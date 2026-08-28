# Target architecture

The stack Soundboard moves to for the closed environment. This document records
decisions. [`backend-portability.md`](./backend-portability.md) records why Supabase
cannot come along and what alternatives were rejected;
[`house-conventions.md`](./house-conventions.md) records the two sibling projects whose
patterns most of this copies.

## What the closed environment provides

| Available | Used for |
| --- | --- |
| PostgreSQL | relational data: boards, shared sounds, asset metadata |
| S3-compatible object storage | audio bytes |
| Keycloak | authentication, via SSO |
| HashiCorp Vault | secrets: S3 keys, DB password, OIDC client secret |
| ability to run a Node process | the API, the auth routes, and nothing else |

Soundboard adds **exactly one process**. Vault and Keycloak are spoken to directly over
HTTP; there is no auth sidecar and no vault microservice, unlike the sibling projects. See
[`house-conventions.md`](./house-conventions.md).

None of those can serve a browser the way Supabase did. Something has to hold the
session, enforce ownership, and hand out audio. That is what gets built.

**`../yanshuf3` and `../yanshuf3-Hana2Trino` already run on this exact stack.** Their
conventions are prior art and this design follows them deliberately — a third app in the
same environment doing auth and storage differently is a tax on whoever operates all three.

## Topology

```
                    ┌────────────────────────┐
browser ────────────│      Node backend      │──── TCP ────> PostgreSQL  (boards, metadata)
   │  HTTPS         │  /api/*   data + audio │──── HTTPS ──> S3          (audio bytes)
   │  same origin   │  /auth/*  OIDC flow    │──── HTTPS ──> Vault       (secrets, KV v2)
   │                └────────────────────────┘──── HTTPS ──> Keycloak    (discovery, JWKS,
   │                                                                      code exchange)
   └── OIDC redirect ──────────────────────────────────────> Keycloak
```

**One backend process. No auth sidecar, no vault microservice, no Python.**

nginx (or the platform ingress) serves the SPA build and routes `/api/*` and `/auth/*` to
the Node backend. One origin, so no CORS anywhere, and
`Cross-Origin-Embedder-Policy: require-corp` is satisfied for free.

Both sibling projects split auth into a separate process and yanshuf3 splits secrets into
another. Soundboard deliberately does neither — see
[`house-conventions.md`](./house-conventions.md) for why. The *patterns* are unchanged: a
server-side code flow setting an httpOnly cookie, and credentials read from Vault. Only
the number of processes changes.

## Auth: Keycloak, server-side code flow, httpOnly cookie

**Decision: the Authorization Code flow runs in our own Node backend and sets an httpOnly
cookie. No OIDC library in the browser, no token in JavaScript, and no separate auth
process.**

This supersedes an earlier draft that used Authorization Code + PKCE with
`oidc-client-ts` in the SPA. Three reasons, in order of weight:

1. **It is the flow both sibling projects run** against this same Keycloak, so the shape is
   proven here. See [`house-conventions.md`](./house-conventions.md). They put it in a
   separate process; we do not — see below.
2. **It dissolves the `getBuffer` problem.** `App.tsx` fetches audio with a bare
   `fetch(url)` and no headers. Cookies are sent automatically; a bearer token would
   have had to be threaded into that call. The whole class of "uploaded sounds stop
   playing but built-ins work" bugs disappears.
3. **No token in browser memory**, which closed environments tend to have opinions
   about, and no silent-renew iframe to get wrong.

The frontend's entire notion of logging in is a full-page navigation:

```ts
const loginUrl = new URL('/auth/login', location.origin);
loginUrl.search = new URLSearchParams({ state: encodeURIComponent(location.href) }).toString();
location.replace(loginUrl);
```

Because Keycloak is fronting corporate SSO, an existing session means the user
round-trips back without seeing a login form. **There is no login UI to build.**
`AuthPage.tsx` is deleted, not rewritten.

`useAuth` keeps its current public shape so nothing downstream changes:

```ts
{ user: { id, email, user_metadata: { name } } | null, session, loading, signOut }
```

`GET /api/me` populates it. `App.tsx`, `useUserSounds` and `useSharedSounds` need no
changes at all.

### Soundboard owns the flow — no sidecar, no Python

Both sibling projects delegate the redirect flow to a separate process and only consume the
resulting cookie. Soundboard runs the whole Authorization Code flow in its own Node
backend. It is one small app; a sidecar earns its keep when several apps share one client
registration, not here.

Four routes, all in `backend/src/routes/auth.ts`, using `openid-client` (which handles
discovery, the authorize URL, PKCE and the code exchange including ID token validation):

| Method | Path | Role |
| --- | --- | --- |
| GET | `/auth/login?state=<return url>` | build the authorize URL, 302 to Keycloak |
| GET | `/auth/callback?code=&state=` | exchange the code, set the cookie, 302 back to `state` |
| POST | `/auth/logout` | clear the cookie, then RP-initiated logout at Keycloak |
| GET | `/api/me` | current user, or 401 |

Soundboard is a **confidential client**: the code exchange is server-side and authenticated
with a `client_secret` read from Vault. The cookie is
`HttpOnly; Secure; SameSite=Lax; Path=/`.

Per request, a single middleware mounted once at the API router root:

1. read the session cookie
2. verify it — `jose` + `createRemoteJWKSet`, checking `iss`, `aud` and `exp` with a small
   `clockTolerance`
3. resolve `upn` to a local `app_users` row, cached
4. attach it as `req.user`

**Verify on every request, properly.** Both siblings get this wrong and in instructive
ways. hana2trino calls `jsonwebtoken.decode()`, which validates no signature and never
compares `exp` to the clock; it reads the sidecar's `ok` field without testing it; and its
per-request middleware skips validation entirely, so a revoked session keeps working until
the cookie expires. yanshuf3 skips audience validation and passes no clock tolerance.
Verifying a JWT locally against cached JWKS costs microseconds — there is no reason to
skip it.

**The one new dependency:** Soundboard needs its own Keycloak client registration with a
`client_secret` in Vault. That is a request to whoever administers the realm, and it is the
only thing a shared sidecar would have provided for free.

### Identity: key on `upn`, keep a local mirror

Keycloak here emits **`upn`** — an employee number like `T1001001` — and that is what
yanshuf3 keys every user-owned row on. It is the organisation's stable cross-app person
identifier, and it is what makes a Soundboard user recognisably the same person as a
yanshuf3 user. `sub` is realm-scoped and less stable; yanshuf3 never reads it.

But Soundboard cannot use `upn` as a foreign key directly the way yanshuf3 does,
because every existing `user_sounds.user_id` and `shared_sounds.owner_id` holds a
**Supabase UUID**. So:

```sql
create table app_users (
  id           uuid primary key default gen_random_uuid(),  -- keep Supabase UUIDs on import
  upn          text unique,          -- Keycloak upn, uppercased. Null until first login.
  email        citext unique,
  display_name text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);
```

Resolution, per authenticated request:

1. Look up by `upn`. Found → done.
2. Not found → look up by `email` from the token. Found → set `upn` on that row.
   **This is what reconnects an imported user to their existing board.**
3. Still not found → insert a new row.

Two consequences worth stating plainly. Step 2 trusts the token's email claim, which
is acceptable only because Keycloak is the authoritative corporate directory — require
`email_verified`. And `app_users.id` never changes, so every foreign key survives and
the identity provider stays swappable.

**Never use `upn` or `sub` as a foreign key.** All ownership columns reference
`app_users.id`.

Normalise `upn` to uppercase **once**, at the boundary, and never re-normalise.
yanshuf3 is inconsistent here — `upn` uppercased, Redis keys lowercased, one URL
lowercased — and it is a recurring source of confusion.

### Authorization stays ours

Keycloak proves identity. It has no idea which pads belong to whom. yanshuf3 uses
realm/client roles for two coarse gates only (`IT-access` as a superuser flag, a
per-environment role for who may use TEST/PROD at all) and computes everything finer
in PostgreSQL.

Soundboard needs no roles at all. What it does need is an ownership check on every
mutation, because the client currently sends its own `user_id` and deletes with no
user filter. **"Keycloak only identifies the user, it does not block the app" is fine
as a product decision, and it does not relax this.** Not gating the app is different
from letting user A delete user B's board.

### Mock mode for development: `IS_BLACK_ENV`

One boolean meaning "am I outside the closed environment". It is how the auth stack gets
developed at all, since there is no Keycloak to talk to out here.

hana2trino has the cleanest Node implementation — a string env var, Zod-coerced, read
through a named helper rather than touched directly at call sites:

```ts
// backend/src/config/index.ts
IS_BLACK_ENV: z.string().default("false").transform((v) => v.toLowerCase() === "true"),

// backend/src/utils/envCheck.ts
export const isBlackEnv = () => config.IS_BLACK_ENV;
```

What it switches for Soundboard:

| Concern | Effect when set |
| --- | --- |
| identity | mock claims, Keycloak never contacted — the cookie path still runs |
| storage | MinIO instead of the internal S3 |
| secrets | `local_secrets/*.json` instead of Vault |
| privileges | **nothing** |

That last row is a deliberate divergence. In hana2trino the same flag bypasses
authentication *and* grants `IT: true` (full admin) *and* swaps the Postgres target *and*
returns mock data, so one mistyped environment variable is a complete auth bypass with
admin rights. A mock user here is an ordinary user.

Ownership checks must behave identically in both modes. If they only run in the closed
environment, they are untested exactly where development happens.

## Storage: S3, read through the API

Audio bytes live in an S3 bucket. The database stores only the object key.

**Reads are proxied by the API, not presigned.** `GET /api/shared-sounds/:id/audio`
looks up the key, does a `GetObject`, and streams the bytes back. yanshuf3 does the
same for its recordings and consequently has no bucket CORS configuration anywhere,
which independently confirms the choice. The reasons:

1. **The buffer cache would break.** `App.tsx` caches decoded `AudioBuffer`s in a `Map`
   keyed by the URL string. A presigned URL carries a signature and an expiry, so it
   differs on every issue — the cache key would never repeat, and every pad press would
   re-download and re-decode. That surfaces as "the app feels slow" weeks later.
2. **Bucket CORS becomes a dependency.** In a locked-down environment that is a ticket
   to whoever owns the object store, not a config edit.
3. **Expiry versus caching.** A URL that expires cannot carry a long `Cache-Control`.
4. **Revocation.** A proxied read checks the session every time.

The cost is that bytes flow through the API process. For clips of a few hundred
kilobytes behind an immutable cache header, that is not a real cost.

**Design so presigning stays available:** key the decoded-buffer cache on the **sound
id**, not the URL, and keep URL derivation in one place (`userSoundToBoard`). Then
switching the endpoint to a `302` at a presigned URL is a one-line change. Do the
cache-key change early — cheap now, awkward later.

### Object keys are content-addressed

```
sounds/<first 2 hex of sha256>/<full sha256 hex>.<ext>
```

Deduplicates identical uploads, makes retries idempotent (`PutObject` of the same
content is a no-op, so a failed request is safe to retry), and the digest doubles as an
`ETag`. The two-hex prefix keeps any single key prefix from getting hot.

This is a deliberate improvement on yanshuf3, whose keys are `<env>/<sessionId>.bin`
with no hashing or dedupe. Attribution lives entirely in the database, which is where
it belongs — the object store should not be the index of record.

### Write and delete order

**Write S3 first, then the database.**

1. `PutObject`.
2. In one transaction: insert `sound_assets`, `shared_sounds`, `user_sounds`.

If step 2 fails you get an orphan object: invisible, harmless, reclaimable. The reverse
order gives you a row pointing at nothing, which is a broken pad in someone's board.
Prefer the recoverable failure.

**Delete the database rows first, then the object**, best-effort, for the same reason.
Refuse to delete an asset another user's pad still references — check inside the
transaction.

Neither S3 nor PostgreSQL participates in the other's transaction. Accept that and run
a periodic reconciliation job for unreferenced objects past a grace period. Do not
attempt two-phase commit. yanshuf3 has no such job because nothing there references
objects; Soundboard needs one.

### Client configuration

`@aws-sdk/client-s3` **v3** — not the `aws-sdk` v2 monolith both siblings use, which is
EOL. **Credentials come from Vault**, and the client is memoised:

```ts
let client: S3Client | null = null;

export async function getS3(): Promise<S3Client> {
  if (client) return client;
  const { S3_DOMAIN, S3_ACCESS_ID, S3_SECRET_KEY } =
    await getSecret<S3Secret>(SECRET_PATHS.s3);
  client = new S3Client({
    endpoint: S3_DOMAIN,
    region: config.S3_REGION,   // dummy value; the API still requires one
    forcePathStyle: true,       // confirmed required by both siblings
    credentials: { accessKeyId: S3_ACCESS_ID, secretAccessKey: S3_SECRET_KEY },
  });
  return client;
}
```

This is the one place hana2trino has **not** been brought in line: its S3 client still
hardcodes the access key, secret key, endpoint host and bucket name as string literals, and
was not updated when `secrets.ts` landed. Those credentials are in its git history and need
rotating. Soundboard closes that gap from the start — the bucket name comes from the same
secret, never a literal in a controller.

Explicit credentials also short-circuit the SDK's provider chain, which would otherwise
probe EC2 instance metadata and hang. See the `airgap-readiness` skill.

Dev uses MinIO on port 9010, as in yanshuf3's `docker-compose.yaml`. Multipart upload is
unnecessary at these file sizes.

## Secrets: vault, not environment variables

Credentials come from **HashiCorp Vault, read directly over its KV v2 HTTP API**. No vault
microservice — that is yanshuf3's older approach and it means an extra process to deploy.
hana2trino's `backend/src/utils/secrets.ts` is the model: a self-contained TypeScript
module, ~150 lines, with a local-file branch for development.

```ts
export async function getSecret<Fields extends Secret = Secret>(name: string): Promise<Fields> {
  const secret = config.IS_BLACK_ENV ? await readFromFile(name) : await readFromVault(name);
  return secret as Fields;
}

// readFromVault:
const res = await axios.get(`${config.VAULT_PATH.replace(/\/+$/, "")}/data/${name}`, {
  headers: { "X-Vault-Token": config.VAULT_TOKEN, Accept: "application/json" },
  timeout: 5_000,
});
const data = (res.data as { data?: { data?: unknown } })?.data?.data;  // KV v2 double nesting
```

Copy these details:

- **`SECRET_PATHS` as an `as const` object**, so a mistyped path is a compile error.
- **Coerce values in one place.** Accept strings, stringify numbers and booleans (a port
  written `6543` rather than `"6543"` is normal in both a hand-written local file and
  Vault), comma-join scalar arrays, and reject nested objects and `null` **by key name** so
  the error says which field to fix.
- **Containment-check the local-file path**, so a secret name cannot escape
  `local_secrets/`.
- **Resolve at call time, never at import**, so the process boots with Vault unreachable.
- **`local_secrets/` sits at the backend root**, resolved two levels up from
  `src/utils` — the container copies `backend/` to `/app`, so three levels would point
  outside the image.

Paths for Soundboard:

| Path | Contents |
| --- | --- |
| `s3` | `S3_DOMAIN`, `S3_ACCESS_ID`, `S3_SECRET_KEY`, `S3_BUCKET_NAME` |
| `db/postgres/<env>` | host, database, user, password, readPort, writePort |
| `idp/keycloak/soundboard` | `client_id`, `client_secret` |

### Cache the derived clients — the one thing to fix while copying

hana2trino's module reads the store on **every** call, and its docstring is candid about
the cost: *"the connection factories are called per request, which in the closed
environment means a Vault round-trip per database call."* It buys secret rotation without a
restart, which is genuinely useful, but Soundboard's audio endpoint cannot pay a Vault round
trip per request.

Take the middle path:

- **Memoise the derived clients** — one `pg.Pool` and one `S3Client`, built lazily on first
  use and reused. hana2trino builds *two brand-new pools on every call* and never closes
  them, which exhausts connections under load. Do not copy that.
- **Give the secret read a TTL** (a few minutes) so a rotated secret is picked up without a
  restart and without per-request cost.
- **Zod-parse each secret** at the boundary. The generic type argument in the original is
  explicitly not validated at runtime, so a missing field surfaces later as a driver error.
- **Fail fast on the ones that matter.** `s3` and `db/postgres/<env>` are both critical;
  there are no optional secrets here, so a failure to load either should stop startup.
  yanshuf3's `secretsCache.ts` is worth reading for how it separates optional from critical
  (`logger.fatal` plus throw for a secret the server cannot start without).

| Path | Contents |
| --- | --- |
| `s3` | `S3_DOMAIN`, `S3_ACCESS_ID`, `S3_SECRET_KEY`, `S3_BUCKET_NAME` |
| `db/postgres/<env>` | host, database, user, password, readPort, writePort |
| `idp/keycloak/soundboard` | `client_id`, `client_secret` |

Note yanshuf3's equivalent path is misspelled `idp/keycloack/...`; do not copy the typo, and
confirm the exact path when the secret is provisioned.

In development these are JSON files under `local_secrets/`, gitignored and distributed
out of band.

Environment variables are then only for non-secret wiring:

```
VAULT_PATH             # Vault KV v2 mount, e.g. https://vault.internal/v1/kv
VAULT_TOKEN            # the only credential that lives in env, by necessity
IS_BLACK_ENV           # true outside the closed environment: mock auth + MinIO + local files
PG_ENV                 # dev | prod, selects the vault path
S3_REGION              # dummy, but the SDK requires one
OIDC_ISSUER_URL        # must be byte-identical to the token's iss claim
OIDC_SCOPE
OIDC_REDIRECT_URI
MAX_UPLOAD_BYTES
NODE_EXTRA_CA_CERTS    # internal CA, covers Vault, S3 and Keycloak
AWS_EC2_METADATA_DISABLED=true
```

`VAULT_TOKEN` is the bootstrap credential — the one secret that cannot itself come from
Vault. Treat it accordingly: injected by the platform, never committed, never logged.

Validate all of it with Zod at boot and exit on failure. Copy hana2trino's
`config/index.ts` shape: a `blank` preprocessor so a whitespace-only value counts as
absent, `requiredEnv` / `requiredUrl` helpers, and a `process.exit(1)` that prints **every**
issue at once rather than failing on the first. And adopt yanshuf3's rule verbatim: do not
add fallback values for things the architecture guarantees — throw a clear error instead.

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are removed at the end of the port.
The committed anon key needs rotating regardless.

## Repository layout

Matching yanshuf3's workspace naming rather than inventing our own:

```
soundboard/
├── package.json                 # workspaces: ["frontend", "backend", "packages/shared"]
├── package-lock.json            # single lockfile
├── turbo.json
├── tsconfig.base.json           # an improvement on yanshuf3, which duplicates configs
├── docker-compose.yaml          # postgres + minio + vault for local dev
├── frontend/
│   ├── index.html
│   ├── vite.config.ts           # @ -> ./src, /api + /auth proxies, COOP/COEP plugin
│   ├── nginx.conf               # prod: SPA + immutable /assets/ + COOP/COEP
│   ├── public/                  # sounds/, images/, ffmpeg/ (vendored wasm core)
│   └── src/                     # unchanged internally
├── backend/
│   └── src/
│       ├── index.ts             # bootstrap, ordered startup, graceful shutdown
│       ├── config/              # Zod-validated env
│       ├── controllers/         # HTTP shape
│       ├── middleware/          # requireUser, injectDb
│       ├── routes/              # thin; auth.ts owns login/callback/logout
│       ├── services/            # logic
│       ├── types/
│       └── utils/               # secrets.ts, s3.ts, pg.ts, oidc.ts, logger.ts
├── local_secrets/               # dev only, gitignored, one JSON file per secret path
├── packages/shared/
│   └── src/
│       ├── types.ts             # UserSound, SharedSound, BoardSound
│       └── builtinSounds.ts     # the SOUNDS list
├── db/migrations/               # versioned .sql — deliberately unlike yanshuf3
├── docs/
└── scripts/
```

### Why a workspace at all

Two things genuinely have to be shared, and both currently live in the frontend:

- **`SOUNDS`** (`src/lib/sounds.ts`) — the API needs it for first-login seeding.
- **`UserSound` / `SharedSound`** (`src/lib/supabase.ts`) — the API produces these
  shapes, the frontend consumes them.

Reaching across `frontend/` ↔ `backend/` without a package boundary means either
duplicating both — and the seeding list will drift silently — or tsconfig and bundler
hacks. It also enforces the dependency split a single `package.json` cannot: `pg`,
`@aws-sdk/*` and `jose` never reach the browser bundle, and React never reaches the API.

Follow yanshuf3's `pre*` hook convention so the shared package is always built before
its consumers:

```json
"predev": "npm --prefix .. run build -w @soundboard/shared",
"prebuild": "npm --prefix .. run build -w @soundboard/shared",
"pretypecheck": "npm --prefix .. run build -w @soundboard/shared"
```

**Deliberate divergence: keep versioned migrations in `db/migrations/`.** yanshuf3
treats its live database as schema truth and snapshots it for reference. Soundboard
already has versioned migrations, and a closed environment needs a repeatable,
reviewable path.

**Not yet done.** The layout is agreed but nothing has moved. It is high-churn with no
behavioural payoff, so it lands as its own commit — ideally after the Phase 1
`src/lib/api.ts` seam, since a smaller better-factored surface is easier to move. What
changes with it: the Vite alias, the tsconfig layout, `SOURCE`/`TARGET` in
`scripts/sync-agent-docs.mjs`, and every `src/lib/**` pattern in `.kiro/steering/*.md`
and `.github/instructions/*`. Same commit — see the `docs-sync` skill.

## Dev and production

**Dev**: `docker compose up` for PostgreSQL, MinIO and vault; the API on 3001; Vite on
3000 proxying to both. Specific routes before general, and `/auth` bypasses the API:

```ts
// frontend/vite.config.ts
server: {
  proxy: {
    // both go to our own backend — there is no separate auth process
    '/api':  { target: 'http://127.0.0.1:3001' },
    '/auth': { target: 'http://127.0.0.1:3001' },
  },
}
```

Same-origin in dev too, so the COOP/COEP plugin and the audio fetch behave exactly as
in production. Run the processes in separate terminals or via turbo.

**Production**: nginx serves the SPA build, and routes `/api` and `/auth` onward —
following yanshuf3's `frontend/Dockerfile` (`turbo prune` → multi-stage →
`nginx:stable-alpine`) with immutable caching on `/assets/` and `try_files $uri =404`
so a missing asset 404s instead of returning `index.html`.

**One thing yanshuf3's nginx does not need and ours does:**

```nginx
add_header Cross-Origin-Opener-Policy   same-origin  always;
add_header Cross-Origin-Embedder-Policy require-corp always;
```

Without them `SharedArrayBuffer` is undefined and ffmpeg.wasm's multi-threaded core
will not load. The Vite plugin that sets these today covers dev and preview only.

## What this changes versus earlier drafts

Recorded so the reasoning is not re-litigated.

| Decision | First draft (PG only) | Second draft (S3 + Keycloak known) | Now (yanshuf3 known) |
| --- | --- | --- | --- |
| audio bytes | `bytea` column | S3 object, key in PG | unchanged |
| audio URL | API serving `bytea` | API proxying S3 | unchanged; yanshuf3 confirms proxy-not-presign |
| auth | own users + bcrypt + sessions | Keycloak OIDC, PKCE in the SPA | Keycloak, **server-side code flow in our backend**, httpOnly cookie |
| token in browser | n/a | access token in memory | **none** — httpOnly cookies |
| `getBuffer` auth | n/a | thread a bearer token in | **nothing to do**, cookies are automatic |
| identity key | local `app_users.id` | Keycloak `sub` | **`upn`**, with `app_users.id` still the FK |
| layout | add `server/` | `apps/web` + `apps/api` | **`frontend/` + `backend/` + `packages/shared`** |
| login UI | email + password form | sign-in button | **none** — SSO redirect |
| npm in closed net | "use a mirror" | same | **Nexus**, with `stripLockIntegrity` before `npm ci` |
| Python needed? | n/a | maybe, for an auth BFF | **no** |
| auth flow location | n/a | a sidecar process | **our own Node backend** |
| secrets access | env vars | a vault microservice | **direct to Vault KV v2, in-process** |
| S3 credentials | env vars | vault | **vault**, memoised client |

Unchanged throughout, and still the things that matter most: **never store an absolute
media URL in the database**, and **derive the user server-side, never from the request
body**.

## Open questions

- **A Keycloak client registration for Soundboard**, with `client_secret` stored at
  `idp/keycloak/soundboard` in Vault. The only external dependency the
  no-sidecar decision adds. Also confirm the allowed redirect URI and post-logout redirect
  URI.
- **The Vault mount path and how `VAULT_TOKEN` is issued** to the Soundboard container —
  its TTL, and whether it needs renewing. It is the one credential that cannot come from
  Vault itself.
- Which S3 implementation? yanshuf3 does not name it — the vault secret is only
  `{ S3_DOMAIN, S3_ACCESS_ID, S3_SECRET_KEY, S3_BUCKET_NAME }`. Path-style is required
  and the certificate is not publicly trusted, which fits MinIO, Ceph RGW and
  StorageGRID equally.
- A dedicated bucket for Soundboard, or a prefix in a shared one? What is its backup
  and retention policy? It holds data the database cannot reconstruct.
- A Keycloak client for Soundboard, and a vault path for its credentials — or does it
  reuse yanshuf3's client?
- Do Keycloak `upn`/email values line up with the current Supabase accounts? This
  decides whether existing boards reconnect on first login. Diff them before cutover.
- Is `email_verified` reliable in that realm? Step 2 of the identity resolution depends
  on it.
- PostgreSQL major version, and whether `CREATE EXTENSION` is permitted.
- Internal CA certificate location, for PostgreSQL, S3 and Keycloak.
