# Target architecture

The stack Soundboard moves to for the closed environment. This document records
decisions. [`backend-portability.md`](./backend-portability.md) records why Supabase
cannot come along and what alternatives were rejected;
[`yanshuf3-conventions.md`](./yanshuf3-conventions.md) records the sibling project
whose patterns most of this copies.

## What the closed environment provides

| Available | Used for |
| --- | --- |
| PostgreSQL | relational data: boards, shared sounds, asset metadata |
| S3-compatible object storage | audio bytes |
| Keycloak | authentication, via SSO |
| a vault service | secrets: S3 keys, DB password, OIDC client secret |
| ability to run Node and Python processes | the API, and the auth BFF |

None of those can serve a browser the way Supabase did. Something has to hold the
session, enforce ownership, and hand out audio. That is what gets built.

**`../yanshuf3` already runs on this exact stack.** Its conventions are prior art and
this design follows them deliberately — a second app in the same environment doing
auth and storage differently is a tax on whoever operates both.

## Topology

```
                    ┌──────────────┐
browser ────────────│  Node API    │──── TCP ────> PostgreSQL   (boards, metadata)
   │  HTTPS         │  (Express)   │──── HTTPS ──> S3           (audio bytes)
   │  same origin   │              │──── HTTP ───> vault        (secrets)
   │                └──────────────┘
   │                       │ validate-session (HTTP)
   │                       v
   │                ┌──────────────┐
   ├── /auth/* ─────│ auth-service │──── HTTPS ──> Keycloak
   │                │   (BFF)      │
   │                └──────────────┘
   └── OIDC redirect ──────────────────────────────> Keycloak
```

One origin from the browser's point of view. nginx (or the platform ingress) routes
`/api/*` to the Node API, `/auth/*` to the BFF, and everything else to the static SPA
build. No CORS anywhere, and `Cross-Origin-Embedder-Policy: require-corp` is satisfied
for free.

## Auth: Keycloak via a cookie BFF

**Decision: server-side Authorization Code flow in a BFF that sets httpOnly cookies.
No OIDC library in the browser, no token in JavaScript.**

This supersedes an earlier draft that used Authorization Code + PKCE with
`oidc-client-ts` in the SPA. Three reasons, in order of weight:

1. **It is what yanshuf3 already does**, against this same Keycloak, with a working
   confidential client already provisioned. See
   [`yanshuf3-conventions.md`](./yanshuf3-conventions.md) for the endpoints and code.
2. **It dissolves the `getBuffer` problem.** `App.tsx` fetches audio with a bare
   `fetch(url)` and no headers. Cookies are sent automatically; a bearer token would
   have had to be threaded into that call. The whole class of "uploaded sounds stop
   playing but built-ins work" bugs disappears.
3. **No token in browser memory**, which closed environments tend to have opinions
   about, and no silent-renew iframe to get wrong.

The frontend's entire notion of logging in is a full-page navigation:

```ts
const loginUrl = new URL('/auth/oidc/login-redirect', location.origin);
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

**Open question: is `auth-service` shared infrastructure or per-app?** If shared,
Soundboard calls the existing one and writes no auth code. If per-app, we either stand
up a copy or verify tokens in-process with `jose`. This changes the deployment shape —
ask before building.

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

### Mock mode for development

Copy yanshuf3's `IS_BLACK_ENV` switch. With it set, no IdP is contacted:
`login-redirect` jumps straight to the callback with a mock code, and the session
validation synthesizes claims from env vars. The cookie path still runs, so the mock
exercises the real flow.

This is how the auth stack gets developed outside the closed network, which is most of
the time. The same flag switches storage between MinIO and the internal S3, so one
boolean means "am I outside the closed environment".

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

`@aws-sdk/client-s3` **v3** — not the `aws-sdk` v2 monolith yanshuf3 uses, which is
EOL. Otherwise copy its shape: explicit credentials, explicit endpoint, path-style,
lazily constructed and memoised in a module-level singleton.

```ts
const { S3_DOMAIN, S3_ACCESS_ID, S3_SECRET_KEY, S3_BUCKET_NAME } = await getSecret('s3');

const s3 = new S3Client({
  endpoint: S3_DOMAIN,
  region: process.env.S3_REGION ?? 'us-east-1',  // often ignored, still required
  forcePathStyle: true,                          // confirmed required by yanshuf3
  credentials: { accessKeyId: S3_ACCESS_ID, secretAccessKey: S3_SECRET_KEY },
});
```

Explicit credentials also short-circuit the SDK's provider chain, which would otherwise
probe EC2 instance metadata and hang. See the `airgap-readiness` skill.

Dev uses MinIO on port 9010, as in yanshuf3's `docker-compose.yaml`. Multipart upload
is unnecessary at these file sizes.

## Secrets: vault, not environment variables

Credentials come from the vault service, namespaced by path — the same service
yanshuf3 uses, with a Redis mirror so vault being down does not take the app down.

| Path | Contents |
| --- | --- |
| `s3` | `S3_DOMAIN`, `S3_ACCESS_ID`, `S3_SECRET_KEY`, `S3_BUCKET_NAME` |
| `db/postgres/<env>` | host, database, user, password, readPort, writePort |
| `idp/keycloack/soundboard` | `client_id`, `client_secret` (note the upstream typo in the path) |

In development these are JSON files under `local_secrets/`, gitignored and distributed
out of band.

Environment variables are then only for non-secret wiring:

```
VAULT_SERVICE          # host:port of the vault service
IS_BLACK_ENV           # true outside the closed environment: mock auth + MinIO
PG_ENV                 # DEV | TEST | PROD, selects the vault path
S3_REGION
S3_FORCE_PATH_STYLE
OIDC_ISSUER_URL        # must be byte-identical to the token's iss claim
OIDC_SCOPE
OIDC_REDIRECT_URI
MAX_UPLOAD_BYTES
AUTH_SERVICE_URL
NODE_EXTRA_CA_CERTS    # internal CA, covers S3 and Keycloak
AWS_EC2_METADATA_DISABLED=true
```

Validate all of it with a Zod schema at boot and exit on failure. yanshuf3's rule is
worth adopting verbatim: do not add fallback values for things the architecture
guarantees — throw a clear error instead.

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
│       ├── config/              # Zod-validated env, db pool, secrets cache
│       ├── controllers/         # HTTP shape
│       ├── middleware/          # authMiddleware, injectDBConnections
│       ├── routes/              # thin; auth boundary applied once
│       ├── services/            # logic
│       ├── types/
│       └── utils/               # s3.ts, minio.ts, vault.ts, logger.ts
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
    '/api':  { target: 'http://127.0.0.1:3001' },
    '/auth': { target: 'http://127.0.0.1:9000' },
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
| auth | own users + bcrypt + sessions | Keycloak OIDC, PKCE in the SPA | Keycloak via a **cookie BFF**, no OIDC lib in the browser |
| token in browser | n/a | access token in memory | **none** — httpOnly cookies |
| `getBuffer` auth | n/a | thread a bearer token in | **nothing to do**, cookies are automatic |
| identity key | local `app_users.id` | Keycloak `sub` | **`upn`**, with `app_users.id` still the FK |
| secrets | env vars | env vars | **vault service** |
| layout | add `server/` | `apps/web` + `apps/api` | **`frontend/` + `backend/` + `packages/shared`** |
| login UI | email + password form | sign-in button | **none** — SSO redirect |
| npm in closed net | "use a mirror" | same | **Nexus**, with `stripLockIntegrity` before `npm ci` |

Unchanged throughout, and still the things that matter most: **never store an absolute
media URL in the database**, and **derive the user server-side, never from the request
body**.

## Open questions

- Is `auth-service` shared infrastructure or per-app? Decides whether Soundboard writes
  any auth code at all.
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
