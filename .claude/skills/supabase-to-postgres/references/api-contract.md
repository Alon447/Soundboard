# Replacement API contract

The HTTP surface that replaces GoTrue + PostgREST + Storage. Sized to exactly what
the app uses today (see `docs/supabase-surface-inventory.md`) plus the gaps worth
closing.

Serve the built frontend from the same process, so everything is same-origin. That
removes CORS, satisfies `Cross-Origin-Embedder-Policy: require-corp` for audio, and
lets a session cookie be `SameSite=Lax` if you go the BFF route.

Stack: Fastify + `pg` + `@aws-sdk/client-s3` + `jose`. One process.

## Auth model

Keycloak issues tokens; the API validates them. There are **no** signup, login,
logout or password endpoints — that is the whole point of using Keycloak.

Default: the SPA runs Authorization Code + PKCE and sends
`Authorization: Bearer <access_token>`. The API validates with `jose`:

```ts
const jwks = createRemoteJWKSet(new URL(`${OIDC_ISSUER}/protocol/openid-connect/certs`));
const { payload } = await jwtVerify(token, jwks, {
  issuer: OIDC_ISSUER,
  audience: OIDC_AUDIENCE,
});
```

Then resolve the local user and attach it to the request:

1. `select * from app_users where oidc_sub = $1`
2. else `select * from app_users where email = $1`, and `update … set oidc_sub = $2`
   — **this is what reconnects an imported user to their existing board**
3. else insert a new row

Require `email_verified` before trusting the email in step 2.

**`req.user.id` is the local `app_users.id`, never the raw `sub`.** Every ownership
column references it. Ignore any `user_id` / `owner_id` in a request body.

**A valid token is not authorization.** Keycloak says who the caller is; only the
API knows which pads are theirs.

Alternative: a BFF, where the API completes the code flow and issues an httpOnly
cookie. More server code, but no token in JavaScript and `fetch(url, { credentials:
'same-origin' })` is authenticated everywhere — including the audio endpoint, which
solves the `getBuffer` problem below for free. Decide before building the audio route.

### The one endpoint the client cannot authenticate today

`getBuffer` in `App.tsx` calls bare `fetch(url)` with no headers. With bearer auth on
`/api/shared-sounds/:id/audio`, uploaded sounds stop playing and built-ins keep
working. Either attach the token in `getBuffer` via a module-level accessor, or use
the BFF cookie. This is a decision, not an implementation detail.

## Endpoints

### Session

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/me` | `{ id, email, user_metadata: { name } }` or 401 |

Called once on load to resolve the local user and warm the mirror row. The client
maps this onto the existing `useAuth` context shape.

### Board

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/api/user-sounds` | — | `UserSound[]` with nested `shared_sound` |
| POST | `/api/user-sounds` | `{ sound_id }` or `{ shared_sound_id }` + `{ name, color, icon, gain? }` | `UserSound` |
| PATCH | `/api/user-sounds/:id` | any of `{ name, color, icon, gain }` | `UserSound` |
| POST | `/api/user-sounds/reorder` | `{ order: uuid[] }` | `204` |
| DELETE | `/api/user-sounds/:id` | — | `204` |

- `GET` must return `shared_sound` as a **nested object**, not flattened columns —
  `userSoundToBoard` reads `row.shared_sound?.…`. The `jsonb_build_object` query is
  in `target-schema.sql`.
- `position` is assigned server-side as `max(position) + 1`. Do not trust a
  client-supplied index the way the current code does (`position: sounds.length`).
- `reorder` replaces `moveSound`'s two racing `UPDATE`s with one statement. Validate
  that the id set matches the caller's pads exactly, and scope on `user_id`.
- First-login seeding: have `GET /api/user-sounds` seed the 9 built-ins when the user
  has no rows, in the same transaction. That matches current behaviour and avoids a
  round trip the client has to remember to make. Seed data comes from the `SOUNDS`
  list in `packages/shared` — one copy, imported by both sides, or it will drift
  silently.

### Community library

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/api/shared-sounds` | — | `SharedSound[]`, public only, newest first |
| POST | `/api/shared-sounds` | multipart: `file`, `name`, `color`, `icon` | `SharedSound` |
| DELETE | `/api/shared-sounds/:id` | — | `204`, owner only |
| GET | `/api/shared-sounds/:id/audio` | — | audio bytes proxied from S3 |

## Upload: `POST /api/shared-sounds`

Replaces the old three-step dance (Storage upload → sign URL → insert). Order
matters, because S3 and PostgreSQL cannot share a transaction:

1. Buffer the upload, enforcing `MAX_UPLOAD_BYTES`. Reject oversize with 413.
2. Sniff the leading bytes and validate against an allowlist. Do not trust
   `file.mimetype`.
3. `sha256` the content. Compute the key:
   `sounds/<first 2 hex>/<full hex>.<ext>`.
4. `select id from sound_assets where sha256 = $1`. If present, **skip the upload
   entirely** and reuse the asset.
5. Otherwise `PutObject`. **S3 first.**
6. In one transaction: insert `sound_assets` (if new), insert `shared_sounds`,
   insert the `user_sounds` pad.

If step 6 fails you have an orphaned object — invisible, harmless, reclaimed by the
reconciliation job. The reverse order would leave a row pointing at nothing, which
is a broken pad in a user's board. Prefer the recoverable failure.

`owner_name` comes from `req.user.user_metadata?.name ?? req.user.email ??
'Anonymous'`, never from the request body.

Content addressing makes step 5 idempotent, so a client retry after a timeout cannot
create a duplicate object.

## Delete: `DELETE /api/shared-sounds/:id`

New — uploads currently accumulate forever. Mirror of the write order:

1. Verify `owner_id = req.user.id`, else 403.
2. In one transaction: delete `shared_sounds`; if no other `shared_sounds` row
   references the asset, delete `sound_assets` too.
3. **After** the transaction commits, best-effort `DeleteObject`.

If step 3 fails, the reconciliation job picks it up. Never delete the object first.

`user_sounds` rows referencing the shared sound cascade away — decide deliberately
whether that is acceptable (it removes the pad from other users' boards) or whether
deletion should be refused with 409 when others reference it. Document whichever you
choose.

## Audio: `GET /api/shared-sounds/:id/audio`

The hot path. Look up `bucket` + `object_key`, `GetObject`, stream the body back.

```
Content-Type: <sound_assets.content_type>
Content-Length: <byte_size>
ETag: "<hex sha256>"
Cache-Control: private, max-age=31536000, immutable
```

Bytes are content-addressed and therefore immutable, so an aggressive cache header is
safe and makes repeat plays free. Answer `If-None-Match` with 304. Requires a valid
session — the old signed URLs were effectively public to anyone holding the link, so
this is strictly better.

Range requests are unnecessary: `decodeAudioData` needs the whole file.

**Why proxy rather than redirect to a presigned URL:** `App.tsx` caches decoded
`AudioBuffer`s keyed by URL, and a presigned URL rotates on every issue, so the cache
would never hit. Proxying also avoids configuring bucket CORS and keeps revocation
immediate. If bandwidth through the API ever becomes a real problem, switch this
route to a `302` — but key the buffer cache on the sound id first.

## Response shape

Keep `{ data, error }` so the react-query hooks need no restructuring:

```ts
// src/lib/api.ts
type Result<T> = { data: T | null; error: { message: string } | null };

async function request<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: { ...authHeader(), ...init?.headers },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { data: null, error: { message: body.error?.message ?? `HTTP ${res.status}` } };
    }
    return { data: res.status === 204 ? (null as T) : await res.json(), error: null };
  } catch (e) {
    return { data: null, error: { message: (e as Error).message } };
  }
}
```

Errors: `{ "error": { "code": "...", "message": "..." } }`. Never leak PostgreSQL or
S3 error text — it exposes schema, constraint names, bucket names and endpoints. Map
known failures to codes and log the original server-side.

401 should make the client re-run the OIDC flow, the same way a null session renders
`<AuthPage />` today.

## Type changes

`SharedSound` loses `storage_path` and `file_url`. `UserSound` loses
`custom_file_url`. Both move to `packages/shared/src/types.ts`.

```ts
export type SharedSound = {
  id: string; owner_id: string; owner_name: string; name: string;
  icon: string; color: string; gain: number;
  is_public: boolean; created_at: string;
};
```

Note `asset_id` is deliberately not exposed. Clients address audio by shared-sound
id, which keeps the storage layer private.

## Deployment notes

- Set `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` on the HTML response, or ffmpeg.wasm's
  multi-threaded core fails. `vite.config.ts` only covers dev and preview.
- Use a `pg.Pool`, not a connection per request.
- `pg` may need `ssl: { ca }` for an internal CA; S3 and Keycloak may need
  `NODE_EXTRA_CA_CERTS`.
- Pass S3 credentials explicitly and set `forcePathStyle: true`. See the
  `airgap-readiness` skill for why the default credential chain is a hazard here.
- Parameterised queries everywhere. No string interpolation into SQL.
- Fail fast at boot on missing environment variables rather than at first request.
