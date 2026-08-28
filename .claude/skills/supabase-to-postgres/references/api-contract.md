# Replacement API contract

The HTTP surface that replaces GoTrue + PostgREST + Storage. Sized to exactly what
the app uses today (see `docs/supabase-surface-inventory.md`) plus the gaps worth
closing.

Serve the built frontend from the same process, so everything is same-origin. That
removes CORS, satisfies `Cross-Origin-Embedder-Policy: require-corp` for audio, and
lets a session cookie be `SameSite=Lax` if you go the BFF route.

Stack: Fastify + `pg` + `@aws-sdk/client-s3` + `jose`. One process.

## Auth model

Keycloak owns authentication, via a **cookie BFF**. There are **no** signup, login,
logout or password endpoints in this API — that is the whole point of using Keycloak,
and `../yanshuf3` already runs exactly this flow against the same realm.

The BFF (`/auth/oidc/login-redirect`, `/auth/oidc/callback`,
`/auth/oidc/validate-session`) completes a server-side Authorization Code flow as a
confidential client and sets `id_token` and `access_token` as **httpOnly cookies** on
the app's own origin. The SPA never sees a token, and the frontend's only auth action
is a full-page navigation to `login-redirect` with the return URL in `state`.

Per request, this API then either:

- **delegates** to the BFF, posting the two cookies to `validate-session` and getting
  claims back — what yanshuf3's Node backend does, and the least code if `auth-service`
  is shared infrastructure; or
- **verifies in-process** with `jose`, if Soundboard runs its own:

```ts
const jwks = createRemoteJWKSet(new URL(`${OIDC_ISSUER_URL}/protocol/openid-connect/certs`));
const { payload } = await jwtVerify(token, jwks, {
  issuer: OIDC_ISSUER_URL,   // must be byte-identical to the iss claim
  audience: OIDC_AUDIENCE,   // yanshuf3 skips this; do not skip it
  clockTolerance: '30s',     // yanshuf3 uses zero; allow a little
});
```

Ask which before building. Either way, resolve the local user and attach it to the
request:

1. `select * from app_users where upn = $1`
2. else `select * from app_users where email = $1`, and `update … set upn = $2`
   — **this is what reconnects an imported user to their existing board**
3. else insert a new row

The identifying claim is **`upn`**, uppercased once at this boundary — not `sub`, which
yanshuf3 never reads. Require `email_verified` before trusting the email in step 2.
Cache the resolved user rather than querying per request.

**`req.user.id` is the local `app_users.id`, never the raw claim.** Every ownership
column references it. Ignore any `user_id` / `owner_id` in a request body.

**A valid token is not authorization.** Keycloak says who the caller is; only this API
knows which pads are theirs. Using Keycloak "only to identify the user, not to block the
app" is a fine product decision and does not relax this — not gating the app is a
different thing from letting user A delete user B's board.

### Why cookies rather than a bearer header

`getBuffer` in `App.tsx` calls bare `fetch(url)` with no headers. Under bearer auth the
audio route would 401, so uploaded sounds would stop playing while built-ins kept
working — a confusing, partial failure. Cookies are sent automatically, so
`fetch(url, { credentials: 'same-origin' })` authenticates every route including audio,
with no change to the playback path.

Do not introduce a bearer-only route for audio later; it reopens this.

### Mock mode

Copy yanshuf3's `IS_BLACK_ENV` switch: with it set, no IdP is contacted, the callback is
reached with a mock code, and validation synthesizes claims from env vars while the
cookie path still runs. It is how the auth stack gets developed outside the closed
network.

## Endpoints

### Session

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/me` | `{ id, email, user_metadata: { name } }` or 401 |

Called once on load to resolve the local user and warm the mirror row. The client maps
this onto the existing `useAuth` context shape, so `App.tsx` needs no changes.

A 401 means "no valid session" and the client responds by navigating to
`/auth/oidc/login-redirect`. Distinguish it from 502, which means the BFF or Keycloak is
unreachable — yanshuf3 maps `ECONNREFUSED` to `badGateway` specifically so the frontend
shows a retry instead of bouncing into a redirect loop. Copy that.

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
    // credentials only — the session is an httpOnly cookie, there is no token to attach
    const res = await fetch(path, { credentials: 'same-origin', ...init });
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
known failures to codes and log the original server-side. Follow yanshuf3's convention
of an error factory plus `next(err)` rather than `res.status(500)` inline.

401 makes the client navigate to the BFF's `login-redirect`. 502 means the BFF or
Keycloak is down — show a retry, do not redirect.

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
  multi-threaded core fails. `vite.config.ts` only covers dev and preview, and
  yanshuf3's nginx does not set them because nothing there needs isolation.
- **Secrets come from the vault service, not `.env`** — `getSecret('s3')`,
  `getSecret('db/postgres/<env>')`, `getSecret('idp/keycloack/soundboard')`. Env vars
  are for non-secret wiring only.
- Use a `pg.Pool`, not a connection per request. yanshuf3 splits read and write pools
  from one vault secret and probes both with `SELECT 1` at startup; copy the probe and
  the graceful `pool.end()` on SIGTERM.
- `pg` may need `ssl: { ca }` for an internal CA; S3 and Keycloak need
  `NODE_EXTRA_CA_CERTS`. Do **not** copy yanshuf3's blanket
  `rejectUnauthorized: false`.
- Pass S3 credentials explicitly and set `forcePathStyle: true` — confirmed required by
  yanshuf3. See the `airgap-readiness` skill for why the default credential chain is a
  hazard here.
- Do not auto-create the bucket on write the way yanshuf3 does; that needs
  bucket-admin credentials in production. Provision it once, out of band.
- Bucket name comes from config, never a literal in a controller.
- Parameterised queries everywhere. No string interpolation into SQL.
- Validate config with Zod at boot and exit on failure. No fallback values for things
  the architecture guarantees.
