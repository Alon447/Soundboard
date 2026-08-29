# Replacement API contract

The HTTP surface that replaces GoTrue + PostgREST + Storage. Sized to exactly what
the app uses today (see `docs/supabase-surface-inventory.md`) plus the gaps worth
closing.

Serve the built frontend from the same origin, so there is no CORS,
`Cross-Origin-Embedder-Policy: require-corp` is satisfied for audio, and the session cookie
can be `SameSite=Lax`.

Stack: **Express 5** (matching yanshuf3) + `pg` + `@aws-sdk/client-s3` + `zod`, with `jose`
and `openid-client` still to come. **One process** — it serves `/api/*`, owns `/auth/*`, and
reads Vault directly.

The board routes are built. Errors go through `httpError(status, code, message)` and a single
handler that maps anything else to a 500, so the driver's text never reaches the client.

## Auth model

Keycloak owns authentication. There are **no signup, password or password-reset endpoints**
— that is the point of using Keycloak — but unlike both sibling projects, **this API owns
the OIDC flow itself**. No sidecar process.

### Auth routes

| Method | Path | Role |
| --- | --- | --- |
| GET | `/auth/login?state=<return url>` | build the authorize URL, 302 to Keycloak |
| GET | `/auth/callback?code=&state=` | exchange the code, set the cookie, 302 back to `state` |
| POST | `/auth/logout` | clear the cookie, then RP-initiated logout at Keycloak |

Use `openid-client`: it handles discovery, the authorize URL, PKCE and the code exchange
including ID token validation. Soundboard is a **confidential client** — the exchange is
server-side, authenticated with a `client_secret` read from Vault at
`idp/keycloak/soundboard`.

The session cookie is `HttpOnly; Secure; SameSite=Lax; Path=/`. The SPA never sees a token;
its only auth action is a full-page navigation to `/auth/login` with the return URL in
`state`. Validate `state` on the way back — it is both the return URL and the CSRF
protection, so reject anything that is not a same-origin path.

### Per-request verification

Verify the cookie **in-process on every request** with `jose`:

```ts
const jwks = createRemoteJWKSet(new URL(`${OIDC_ISSUER_URL}/protocol/openid-connect/certs`));
const { payload } = await jwtVerify(token, jwks, {
  issuer: OIDC_ISSUER_URL,   // must be byte-identical to the iss claim
  audience: OIDC_AUDIENCE,   // yanshuf3 skips this; do not skip it
  clockTolerance: '30s',     // yanshuf3 uses zero; allow a little
});
```

JWKS is fetched lazily and cached, so this costs microseconds per request. **Both siblings
skip real verification and both are wrong to.** hana2trino calls
`jsonwebtoken.decode()`, which validates no signature and never compares `exp` to the
clock, and reads its sidecar's `ok` field without testing it; its per-request middleware
skips validation entirely, so a revoked session keeps working until the cookie expires.
yanshuf3 omits audience validation and passes no clock tolerance.

Then attach the identity to the request. There is no lookup: `req.user.id` **is** the
uppercased `upn` claim, because that is what the ownership columns store.

The identifying claim is **`upn`**, not `sub`, which yanshuf3 never reads. Uppercase it
once here and never again — it is the stored key, so inconsistent casing means rows that
cannot be found.

**Derive it from the validated token, never from the request body.** Ignore any `user_id`
or `owner_id` a client sends.

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

Copy the `IS_BLACK_ENV` switch: with it set, no IdP is contacted, the callback is reached
with a mock code, and validation synthesizes claims from env vars while the cookie path
still runs. It is how the auth stack gets developed outside the closed network, where there
is no Keycloak to reach.

hana2trino's Node implementation is the one to copy — `z.string().default("false")
.transform(v => v.toLowerCase() === "true")` plus an `isBlackEnv()` helper — but **only for
identity, storage and secrets, never privileges**. Theirs also returns `IT: true`, making a
mistyped env var an admin bypass. Ownership checks must run identically in both modes, or
they are untested exactly where development happens.

## Endpoints

### Session

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/me` | `{ id, email, user_metadata: { name } }` or 401 |

Called once on load to resolve the local user and warm the mirror row. The client maps
this onto the existing `useAuth` context shape, so `App.tsx` needs no changes.

A 401 means "no valid session" and the client responds by navigating to `/auth/login`.
Distinguish it from 502, which means Keycloak or Vault is unreachable — yanshuf3 maps
`ECONNREFUSED` to `badGateway` specifically so the frontend shows a retry instead of
bouncing into a redirect loop, and hana2trino's `App.tsx` additionally guards against
redirecting when already on the login path. Copy both.

### Board

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/api/user-sounds` | — | `UserSound[]` with nested `shared_sound` |
| POST | `/api/user-sounds` | `{ sound_id }` or `{ shared_sound_id }` + `{ name, color, icon, gain? }` | `UserSound` |
| PATCH | `/api/user-sounds/:id` | any of `{ name, color, icon, gain }` | `UserSound` |
| POST | `/api/user-sounds/reorder` | `{ order: uuid[] }` | `204` |
| DELETE | `/api/user-sounds/:id` | — | `204` |

**As built, `POST` takes an array of pads** — one route covers a single add and a 15-pad
seed. Notes below marked *superseded* describe the earlier server-seeding design.

- `GET` must return `shared_sound` as a **nested object**, not flattened columns —
  `userSoundToBoard` reads `row.shared_sound?.…`. The `jsonb_build_object` query is
  in `target-schema.sql`.
- `position` is assigned server-side as `max(position) + 1`. Do not trust a
  client-supplied index the way the current code does (`position: sounds.length`).
- `reorder` replaces `moveSound`'s two racing `UPDATE`s with one statement. Validate
  that the id set matches the caller's pads exactly, and scope on `user_id`.
- First-login seeding — *superseded.* The plan was for `GET /api/user-sounds` to seed the
  built-ins in its own transaction, from a `SOUNDS` list in `packages/shared`. That package
  was removed, so **the client seeds**: it reads the board and, if empty, `POST`s all 15
  pads. `SOUNDS` lives in `frontend/src/lib/sounds.ts` only.
- Consequently the server **does not validate `sound_id`** against a list of built-ins,
  because it has none. It validates shape only. A pad naming an unknown sound renders
  silently with no audio. See `docs/target-architecture.md`, "Why a workspace at all".

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

**As built, `api.ts` throws** — react-query catches it into `error` state, so a
`{ data, error }` wrapper would only be unwrapped and rethrown at all six call sites. The
server still *sends* `{ error: { code, message } }`; the client turns that into an `Error`.

Built on **axios**, not `fetch`. A single response interceptor unwraps the server's error
envelope, so no call site sees an axios error:

```ts
// frontend/src/lib/api.ts — as built
const client = axios.create({ baseURL: '/api', withCredentials: true });
client.interceptors.response.use(undefined, (error) => {
  throw new Error(error.response?.data?.error?.message ?? error.message);
});
export const api = { get, post, patch, remove };   // each returns response.data
```

`withCredentials` is what carries the httpOnly session cookie. The interceptor is also where
a 401 → `/auth/login` redirect belongs when Keycloak lands.

The original design, kept for the reasoning about why the hooks need no restructuring:

```ts
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

401 makes the client navigate to `/auth/login`. 502 means Keycloak or Vault is down — show
a retry, do not redirect, or you get a loop.

## Type changes

`SharedSound` loses `storage_path` and `file_url`. `UserSound` loses
`custom_file_url`. They stay in `frontend/src/lib/` — there is no shared package to move
them to, so the backend describes its own row shape independently.

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
  multi-threaded core fails. `frontend/vite.config.ts` only covers dev and preview, and
  yanshuf3's nginx does not set them because nothing there needs isolation.
- **Secrets come from Vault, read directly over KV v2, not from `.env`** —
  `getSecret('s3')`, `getSecret('db/postgres/<env>')`,
  `getSecret('idp/keycloak/soundboard')`. Port hana2trino's
  `backend/src/utils/secrets.ts`. Env vars carry non-secret wiring plus `VAULT_TOKEN`,
  which is the one credential that cannot come from Vault.
- **Memoise the derived clients** — one `pg.Pool`, one `S3Client`. Give the secret read a
  TTL rather than hitting Vault per request the way hana2trino does.
- Use a `pg.Pool`, not a connection per request. yanshuf3 splits read and write pools
  from one vault secret and probes both with `SELECT 1` at startup; copy the probe and
  the graceful `pool.end()` on SIGTERM.
- **PostgreSQL: `ssl: { rejectUnauthorized: false }`, hardcoded.** A deliberate, scoped
  exception — TLS is on but the certificate is not verified, which is what lets one
  connection string work against both Supabase and an internal CA with no config knob.
  Note this means a *non-TLS* PostgreSQL cannot be used at all; the server must accept SSL.
- S3 and Keycloak still use `NODE_EXTRA_CA_CERTS`. Do **not** extend the PostgreSQL
  exception to them, and do not reach for `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- Pass S3 credentials explicitly and set `forcePathStyle: true` — confirmed required by
  yanshuf3. See the `airgap-readiness` skill for why the default credential chain is a
  hazard here.
- Do not auto-create the bucket on write the way yanshuf3 does; that needs
  bucket-admin credentials in production. Provision it once, out of band.
- Bucket name comes from config, never a literal in a controller.
- Parameterised queries everywhere. No string interpolation into SQL.
- Validate config with Zod at boot and exit on failure. No fallback values for things
  the architecture guarantees.
