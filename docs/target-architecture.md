# Target architecture

The stack Soundboard moves to for the closed environment. This document records
decisions. [`backend-portability.md`](./backend-portability.md) records why Supabase
cannot come along and what alternatives were rejected;
[`house-conventions.md`](./house-conventions.md) records the two sibling projects whose
patterns most of this copies.

## What the closed environment provides

| Available                     | Used for                                               |
| ----------------------------- | ------------------------------------------------------ |
| PostgreSQL                    | relational data: boards, shared sounds, asset metadata |
| S3-compatible object storage  | audio bytes                                            |
| Keycloak                      | authentication, via SSO                                |
| HashiCorp Vault               | secrets: S3 keys, DB password, OIDC client secret      |
| ability to run a Node process | the API, the auth routes, and nothing else             |

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
[`house-conventions.md`](./house-conventions.md) for why. The _patterns_ are unchanged: a
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
`AuthPage.tsx` is deleted, not rewritten — done, replaced by `SignInPrompt.tsx`, which is a
single button rather than an automatic redirect so a failing `/api/me` cannot loop.

`useAuth` keeps its current public shape so nothing downstream changes:

```ts
{ user: { id, email, user_metadata: { name } } | null, loading }
```

`GET /api/me` populates it, and already returns this shape from the mock identity. `App.tsx`
and `useUserSounds` need no changes at all.

### Soundboard owns the flow — no sidecar, no Python

Both sibling projects delegate the redirect flow to a separate process and only consume the
resulting cookie. Soundboard runs the whole Authorization Code flow in its own Node
backend. It is one small app; a sidecar earns its keep when several apps share one client
registration, not here.

Three routes, two in `backend/src/routes/auth.ts` and `/api/me` in `routes/me.ts`:

| Method | Path                              | Role                                                   |
| ------ | --------------------------------- | ------------------------------------------------------ |
| GET    | `/auth/login?state=<return path>` | build the authorize URL, 302 to Keycloak               |
| GET    | `/auth/callback?code=&state=`     | exchange the code, set the cookie, 302 back to `state` |
| GET    | `/api/me`                         | current user, or 401                                   |

**Decision: `jose` only, no `openid-client`.** The earlier plan was to let `openid-client`
handle discovery, the authorize URL, PKCE and the exchange. In practice the flow yanshuf3
runs against this same Keycloak is a query string, one form POST with `client_secret_basic`,
and a JWT verification — and `jose` is needed for the per-request verification regardless. So
the library would add a package to mirror into Nexus to save roughly forty lines.

What that costs is owning the correctness of the flow, so `backend/src/utils/oidc.ts` and
`routes/auth.ts` validate all three of the things a library would have: **`state`** (random,
compared on callback — not just the return URL), **`nonce`** (compared against the ID token
claim) and **PKCE S256**. Revisit if the realm ever needs a flow more exotic than this one.

**Decision: there is no logout.** Users reach Soundboard already signed in to the
organisation account, so an RP-initiated logout would end that shared session on their
behalf and give them nothing back — the next navigation signs them straight in again. The
end-session endpoint, `OIDC_POST_LOGOUT_REDIRECT_URI` and `useAuth.signOut` were built and
then removed. The session ends when the ID token expires, which is also when the cookie
does. Revisit only if shared workstations make account switching a real requirement.

Soundboard is a **confidential client**: the code exchange is server-side and authenticated
with a `client_secret` read from Vault. The cookie is
`HttpOnly; Secure; SameSite=Lax; Path=/`.

Per request, a single middleware mounted once at the API router root:

1. read the session cookie
2. verify it — `jose` + `createRemoteJWKSet`, checking `iss`, `aud` and `exp` with a small
   `clockTolerance`
3. uppercase `upn` and attach it as `req.user.id`

**Verify on every request, properly.** Both siblings get this wrong and in instructive
ways. hana2trino calls `jsonwebtoken.decode()`, which validates no signature and never
compares `exp` to the clock; it reads the sidecar's `ok` field without testing it; and its
per-request middleware skips validation entirely, so a revoked session keeps working until
the cookie expires. yanshuf3 skips audience validation and passes no clock tolerance.
Verifying a JWT locally against cached JWKS costs microseconds — there is no reason to
skip it.

**The one new dependency:** Soundboard needs its own Keycloak client registration with a
`client_secret` in Vault, and `OIDC_REDIRECT_URI` registered on it. That is a request to
whoever administers the realm, and it is the only thing a shared sidecar would have provided
for free. It is also the reason none of this has run yet — the flow is written but has never
reached a realm.

### Identity: `upn` is the ownership key

Keycloak here emits **`upn`** — an employee number like `T1001001` — and that is what
yanshuf3 keys every user-owned row on. It is the organisation's stable cross-app person
identifier, and it is what makes a Soundboard user recognisably the same person as a
yanshuf3 user. `sub` is realm-scoped and less stable; yanshuf3 never reads it.

**Decision: `upn` is the ownership key directly. There is no `app_users` table.**
`user_sounds.user_id` and `shared_sounds.owner_id` are `text` holding the claim, exactly
as yanshuf3 does it. No mirror table, no per-request resolution query, no join to
authenticate.

This supersedes an earlier draft with an `app_users` mirror keyed on `uuid`, whose entire
purpose was to bridge the Supabase UUIDs already in those columns. The mirror bought two
things and cost one.

What it bought, and what replaces it:

- **Reconnecting imported users.** The mirror did it lazily, per login, by matching the
  token's email against the imported row. Without it, the import must rewrite
  `user_id` from Supabase UUID to `upn` **once, up front**, using the exported
  `auth.users` emails as the join. Same information, done as a migration step rather than
  at runtime.
- **A swappable identity provider.** A stable local id meant changing IdP touched one
  table. Now it would touch every ownership column. Accepted: this environment has one
  Keycloak.

What it cost was a table, a query on the hot path, and a class of silent failure where a
user gets a _new_ row instead of their existing one and sees a freshly seeded empty board.

**The hazard moves rather than disappearing.** If the import maps a UUID to the wrong
`upn`, or misses one, that board is orphaned just as silently — the user signs in and gets
9 seeded built-ins. The difference is that it now fails once, during a migration you can
verify with a query, instead of unpredictably on individual logins. Diff the emails before
cutover either way.

Normalise `upn` to uppercase **once**, at the boundary, and never re-normalise.
yanshuf3 is inconsistent here — `upn` uppercased, Redis keys lowercased, one URL
lowercased — and it is a recurring source of confusion. With `upn` now the stored key,
inconsistent casing means rows that cannot be found rather than merely confusion.

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

| Concern    | Effect when set                                                                   |
| ---------- | --------------------------------------------------------------------------------- |
| identity   | `MOCK_USER_ID` is the whole session; Keycloak never contacted                     |
| data       | the Supabase database, over `pg` with TLS — same driver, same SQL, different host |
| storage    | MinIO instead of the internal S3                                                  |
| secrets    | `local_secrets/*.json` instead of Vault                                           |
| privileges | **nothing**                                                                       |

**There is no local PostgreSQL.** Development talks to Supabase's database directly with
`pg`, so the driver, the pool and every query are identical in both environments — the only
difference is the host in the `db/postgres/<env>` secret. That removes the class of bug
where PostgREST and `node-postgres` disagree about a type, because PostgREST is out of the
picture from the first query. `docker-compose.yaml` therefore provides MinIO only.

That last row is a deliberate divergence. In hana2trino the same flag bypasses
authentication _and_ grants `IT: true` (full admin) _and_ swaps the Postgres target _and_
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
EOL. **Credentials come from Vault**, and the client is memoised. Implemented in
`backend/src/utils/s3.ts`:

```ts
export async function getStorage(): Promise<{ client: S3Client; bucket: string; endpoint: string }>;
```

which builds, once:

```ts
new S3Client({
	endpoint: S3_DOMAIN, // from the secret; the Zod schema requires a full URL
	region: config.S3_REGION, // dummy value; the SDK refuses to sign without one
	forcePathStyle: true, // verified on the wire: PUT /<bucket>/<key>
	credentials: { accessKeyId: S3_ACCESS_ID, secretAccessKey: S3_SECRET_KEY },
});
```

Alongside it: `buildObjectKey(sha256Hex, ext)` and `sha256Hex(bytes)` for content-addressed
keys, and `putObject` / `getObjectStream` / `getObjectBytes` / `objectExists` /
`deleteObject`. `objectExists` maps a 404 to `false` and rethrows anything else.
`getObjectStream` is the one the audio route should use; `getObjectBytes` buffers and is
fine for short clips.

The module also sets `AWS_EC2_METADATA_DISABLED=true` at import, belt-and-braces on top of
the explicit credentials, so the SDK can never wander into an EC2 metadata timeout.

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

Implemented in `backend/src/utils/secrets.ts`:

```ts
export async function getSecret<Fields extends Secret = Secret>(name: string, schema?: ZodType<Fields>): Promise<Fields>;
```

The Vault leg uses **native `fetch` with `AbortSignal.timeout`**, not axios. hana2trino
uses axios; dropping it means one less package to mirror into the Nexus registry, which is
worth more here than matching the sibling line-for-line.

```ts
const res = await fetch(`${config.VAULT_PATH.replace(/\/+$/, '')}/data/${name}`, {
	headers: { 'X-Vault-Token': config.VAULT_TOKEN, Accept: 'application/json' },
	signal: AbortSignal.timeout(config.VAULT_TIMEOUT_MS),
});
const data = ((await res.json()) as { data?: { data?: unknown } })?.data?.data; // KV v2 nests twice
```

The optional Zod schema is the preferred way to read a secret — the bare type argument is
a cast and nothing more. `SECRET_PATHS` and `postgresSecretPath()` are exported so callers
never write a path string.

Copy these details:

- **`SECRET_PATHS` as an `as const` object**, so a mistyped path is a compile error.
- **Coerce values in one place.** Accept strings, stringify numbers and booleans (a port
  written `6543` rather than `"6543"` is normal in both a hand-written local file and
  Vault), and reject nested objects, arrays and `null` **by key name** so the error says
  which field to fix.
- **Containment-check the local-file path**, so a secret name cannot escape
  `local_secrets/`.
- **Resolve at call time, never at import**, so the process boots with Vault unreachable.
- **`local_secrets/` sits at the backend root**, resolved two levels up from
  `backend/src/utils` — the container copies `backend/` to `/app`, so three levels would point
  outside the image.

Paths for Soundboard:

| Path                      | Contents                                                       |
| ------------------------- | -------------------------------------------------------------- |
| `s3`                      | `S3_DOMAIN`, `S3_ACCESS_ID`, `S3_SECRET_KEY`, `S3_BUCKET_NAME` |
| `db/postgres/<env>`       | host, database, user, password, writePort                      |
| `idp/keycloak/soundboard` | `client_id`, `client_secret`                                   |

### Cache the derived clients — the one thing to fix while copying

hana2trino's module reads the store on **every** call, and its docstring is candid about
the cost: _"the connection factories are called per request, which in the closed
environment means a Vault round-trip per database call."_ It buys secret rotation without a
restart, which is genuinely useful, but Soundboard's audio endpoint cannot pay a Vault round
trip per request.

The middle path, as implemented:

- **A TTL cache** (`SECRET_TTL_MS`, default 5 minutes) so a rotated secret is picked up
  without a restart and without per-request cost.
- **Concurrent misses share one in-flight request**, so a burst at startup does not fan out
  into N identical Vault calls.
- **The derived clients are memoised** — `getStorage()` builds one `S3Client` and reuses it,
  and `getPool()` one `pg.Pool`; `resetStorage()` and `closePool()` exist for rotation and
  shutdown. hana2trino builds _two brand-new pools on every call_ and never closes them,
  which exhausts connections under load. Do not copy that.
- **Zod-parse at the boundary.** The generic type argument alone is not validated at
  runtime, so a missing field would surface later as a driver error.
- **Fail fast on the ones that matter.** `s3` and `db/postgres/<env>` are both critical;
  there are no optional secrets here. yanshuf3's `secretsCache.ts` is worth reading for how
  it separates optional from critical (`logger.fatal` plus throw for a secret the server
  cannot start without) if optional ones ever appear.

| Path                      | Contents                                                       |
| ------------------------- | -------------------------------------------------------------- |
| `s3`                      | `S3_DOMAIN`, `S3_ACCESS_ID`, `S3_SECRET_KEY`, `S3_BUCKET_NAME` |
| `db/postgres/<env>`       | host, database, user, password, writePort                      |
| `idp/keycloak/soundboard` | `client_id`, `client_secret`                                   |

Note yanshuf3's equivalent path is misspelled `idp/keycloack/...`; do not copy the typo, and
confirm the exact path when the secret is provisioned.

### Local secrets when `IS_BLACK_ENV=true`

Outside the closed environment there is no Vault, so `getSecret(name)` reads
`backend/local_secrets/<name>` and parses it as JSON. The secret _name_ is the path, so
`db/postgres/dev` is a file at `backend/local_secrets/db/postgres/dev` — nested directories,
no file extension. This is the same convention as both sibling projects.

`local_secrets/` is **gitignored and never committed**. To make the required file names and
shapes discoverable without shipping real credentials, `backend/local_secrets.example/` is
committed with the same tree and throwaway localhost values:

```
npm run secrets:example      # copies the example tree into local_secrets/, skipping anything present
npm run api:check            # confirms every secret parses and S3 round-trips
```

The scaffold never overwrites an existing file, so it is safe to re-run after editing. In the
closed environment you do not run it at all.

Two safeguards in the file branch: the resolved path is checked for containment, so a secret
name cannot traverse out of `local_secrets/`; and a missing file produces an error naming both
the expected path and `IS_BLACK_ENV`, because "cannot read secret" with no path is the least
useful message available.

`local_secrets.example/` is a small deliberate addition — hana2trino documents the required
files in its `.env.example` prose instead. A committed example tree makes the shapes
copy-pasteable and keeps the scaffold script honest.

Environment variables are then only for non-secret wiring:

```
VAULT_PATH             # Vault KV v2 mount, e.g. https://vault.internal/v1/kv
VAULT_TOKEN            # the only credential that lives in env, by necessity
IS_BLACK_ENV           # true outside the closed environment: mock auth + MinIO + local files
PG_ENV                 # dev | prod, selects the vault path
S3_REGION              # dummy, but the SDK requires one
OIDC_ISSUER_URL        # must be byte-identical to the token's iss claim; checked at discovery
OIDC_REDIRECT_URI      # must also be registered on the Keycloak client
OIDC_SCOPE             # defaults to "openid"
OIDC_TIMEOUT_MS        # discovery and token exchange
MAX_UPLOAD_BYTES
MOCK_USER_ID          # IS_BLACK_ENV only: the user_sounds.user_id the mock session owns
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
├── package.json                 # workspaces: ["frontend", "backend"]
├── package-lock.json            # single lockfile
├── tsconfig.base.json           # an improvement on yanshuf3, which duplicates configs
├── docker-compose.yaml          # minio for local dev; the dev database is Supabase
├── frontend/
│   ├── index.html
│   ├── frontend/vite.config.ts           # @ -> ./src, /api + /auth proxies, COOP/COEP plugin
│   ├── nginx.conf               # prod: SPA + immutable /assets/ + COOP/COEP
│   ├── public/                  # sounds/, images/, ffmpeg/ (vendored wasm core)
│   └── frontend/src/                     # unchanged internally
├── backend/
│   └── frontend/src/
│       ├── index.ts             # bootstrap, ordered startup, graceful shutdown
│       ├── config/              # Zod-validated env
│       ├── controllers/         # HTTP shape
│       ├── middleware/          # requireUser, injectDb
│       ├── routes/              # thin; auth.ts owns login/callback
│       ├── services/            # logic
│       ├── types/
│       └── utils/               # secrets.ts, s3.ts, pg.ts, oidc.ts, logger.ts
├── local_secrets/               # dev only, gitignored, one JSON file per secret path
├── db/migrations/               # versioned .sql — deliberately unlike yanshuf3
├── docs/
└── scripts/
```

### Why a workspace at all

Not to share code — to enforce the dependency split a single `package.json` cannot: `pg`,
`@aws-sdk/*` and `jose` never reach the browser bundle, and React never reaches the API.

**Decision: no `packages/shared`.** It was built, then removed. It existed to hold `SOUNDS`
so the API could seed a new board and validate an incoming `sound_id`, which is a real
benefit — but it costs a third package, a build step, and a `pre*` hook on every consumer
script, to share one array that changes rarely.

What the API gives up, and how it copes:

- **Seeding.** `GET /api/user-sounds` returns the board and nothing else. The client seeds,
  exactly as it does on Supabase today: read, and if the board is empty `POST` all 15 pads.
- **Validating `sound_id`.** The server has no list to check against, so it stores what it
  is given. A pad naming a sound the client does not know renders silently with no audio.
  Shape is still validated — `sound_id`, `name`, a hex `color`, `icon`, `gain` in range.

`SOUNDS` therefore lives only in `frontend/src/lib/sounds.ts`, and `POST /api/user-sounds`
takes an **array** so one route serves both a single add and a 15-pad seed. Revisit the
shared package if a second consumer of `SOUNDS` appears, or if silent bad `sound_id`s
actually bite.

**Deliberate divergence: keep versioned migrations in `db/migrations/`.** yanshuf3
treats its live database as schema truth and snapshots it for reference. Soundboard
already has versioned migrations, and a closed environment needs a repeatable,
reviewable path.

### Current state

The workspace split, the schema, the pool and the board API are **done**. What remains is
the OIDC flow and rebuilding uploads on S3. There are two packages, not three — see the
decision above.

```
soundboard/
├── package.json                    # workspace root only: workspaces + orchestration scripts
├── package-lock.json               # one lockfile
├── docker-compose.yaml             # minio only; dev PostgreSQL is Supabase, over pg
├── db/migrations/                  # 0001_init.sql (fresh) + 0002 (Supabase, in place)
├── frontend/                       # @soundboard/frontend
│   ├── package.json
│   ├── index.html
│   ├── vite.config.ts              # @ -> ./src, /api + /auth proxy, COOP/COEP plugin
│   ├── tsconfig.json               # + tsconfig.app.json, tsconfig.node.json
│   ├── eslint.config.js
│   ├── tailwind.config.js          # + postcss.config.js
│   ├── .env                        # VITE_SUPABASE_* for now
│   ├── public/                     # sounds/, images/
│   └── src/                        # unchanged internally; @/ still resolves here
├── backend/                        # @soundboard/backend
│   ├── package.json
│   ├── tsconfig.json               # ES2022 / NodeNext / strict
│   ├── .env.example
│   ├── local_secrets.example/      # committed templates, dummy localhost values
│   ├── local_secrets/              # gitignored, created by `npm run secrets:example`
│   ├── scripts/scaffoldLocalSecrets.mjs
│   └── src/
│       ├── index.ts                # lifecycle only: startup probe, listen, shutdown
│       ├── app.ts                  # express assembly: json, /api router, 404, errors
│       ├── config/index.ts         # Zod-validated env, exits on anything missing
│       ├── checkConnectivity.ts    # `npm run api:check`
│       ├── types/index.ts          # AuthUser + the one Express Request augmentation
│       ├── middleware/
│       │   ├── requireUser.ts      # verifies the ID token every request; mock under IS_BLACK_ENV
│       │   └── errorHandler.ts     # notFound + the handler that hides driver text
│       ├── routes/
│       │   ├── index.ts            # mounts /me and /user-sounds behind requireUser
│       │   ├── me.ts               # GET /api/me
│       │   └── userSounds.ts       # the five board routes
│       └── utils/
│           ├── secrets.ts          # Vault KV v2 + local-file branch + TTL cache
│           ├── s3.ts               # memoised v3 client, content-addressed keys
│           ├── pg.ts               # one memoised Pool, SELECT 1 probe, closePool()
│           ├── httpError.ts        # status + code carrier for the error handler
│           ├── envCheck.ts         # isBlackEnv()
│           └── logger.ts           # dependency-free structured logging
├── supabase/migrations/            # the original Supabase schema, superseded by 0002
└── docs/  .kiro/  .github/
```

The root `package.json` is no longer a package in its own right. It holds the workspace list,
the orchestration scripts, and the two dev dependencies both sides share (`typescript`,
`tsx`) plus the `supabase` CLI and `typescript-eslint`.

`packages/shared` was built when the seeding route needed `SOUNDS`, then removed along with
turbo — the board API now seeds nothing and validates shape rather than membership. `SOUNDS`
lives in `frontend/src/lib/sounds.ts` only. See "Why a workspace at all" above for the
tradeoff that was accepted.

Two migrations, two entry points, one destination:

- **`0001_init.sql`** creates `sound_assets`, `shared_sounds` and `user_sounds` from
  scratch. This is the closed-environment path.
- **`0002_user_sounds_to_target_shape.sql`** alters the _existing_ Supabase `user_sounds`
  into the same shape, because that database already holds live rows. It converts the six
  former uploads into built-in `sound_id`s, drops `custom_file_url`, moves `gain` to
  `double precision`, changes `user_id` to `text`, and drops the foreign key into
  `auth.users`.

Neither runs automatically; a migration runner is still missing. `0002` is destructive and
aborts rather than stranding a pad — see the `DO` block. It also **recreates the RLS policy
with `auth.uid()::text`**, because the frontend still reads through PostgREST until the data
hooks move to `/api`, and RLS with no policy denies everything.

### Scripts

Everything is driven from the root; nothing needs a `cd`.

| Command                                                 | Effect                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `docker compose up -d`                                  | MinIO on 9010, plus the bucket. No PostgreSQL — that is Supabase                |
| `npm run dev`                                           | Vite dev server on 3000, proxying `/api` and `/auth` to 3001                    |
| `npm run dev:api`                                       | the backend on 3001, `tsx watch`                                                |
| `npm run build`                                         | frontend production build to `frontend/dist`                                    |
| `npm run lint`                                          | eslint, frontend                                                                |
| `npm run typecheck` / `typecheck:api` / `typecheck:all` | frontend / backend / both                                                       |
| `npm run build:api`                                     | compile the backend to `backend/dist`                                           |
| `npm run api:check`                                     | connectivity self-check: every secret, PostgreSQL, and an S3 round trip         |
| `npm run secrets:example`                               | create `backend/local_secrets/` and `backend/.env` from the committed templates |

`api:check` is the first thing to run in a new environment. Four checks — the two secrets,
PostgreSQL, S3 — each reporting one line. It prints secret field _names_, never values, and
the PostgreSQL leg verifies all three tables exist, which is how you find out
`db/migrations` never ran.

It deliberately stays a thin diagnostic: it reports the driver's own error rather than
guessing at causes, because a table of guessed remedies goes stale faster than it helps.

`IS_BLACK_ENV` defaults to **false**, meaning "assume the closed environment", so a missing
`backend/.env` fails at boot demanding Vault settings rather than silently mocking identity.
`npm run secrets:example` creates that `.env` from `.env.example`.

## Dev and production

**Dev**: `docker compose up` for MinIO; the API on 3001; Vite on
3000 proxying to both.

**Under `IS_BLACK_ENV`, PostgreSQL is Supabase's hosted instance, reached over the plain
wire protocol by `pg`.** That is a decision, not a leftover — compose deliberately runs no
`postgres` service. It keeps development pointed at the real board and its real data while
the import into the closed environment is still being worked out, and it costs nothing
portability-wise: `pg` does not care that the far end happens to be Supabase, and no
Supabase API is involved. Vault and Keycloak have no dev equivalent at all; those are the
two `IS_BLACK_ENV` bypasses.

Specific routes before general, and `/auth` bypasses the API:

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
in production. Run `npm run dev` and `npm run dev:api` in separate terminals.

**Production**: nginx serves the SPA build, and routes `/api` and `/auth` onward —
following yanshuf3's `frontend/Dockerfile` but without its `turbo prune` step: a plain
multi-stage build from the workspace root into `nginx:stable-alpine`, with immutable caching
on `/assets/` and `try_files $uri =404` so a missing asset 404s instead of returning
`index.html`.

**One thing yanshuf3's nginx does not need and ours does:**

```nginx
add_header Cross-Origin-Opener-Policy   same-origin  always;
add_header Cross-Origin-Embedder-Policy require-corp always;
```

Without them `SharedArrayBuffer` is undefined and ffmpeg.wasm's multi-threaded core
will not load. The Vite plugin that sets these today covers dev and preview only.

## What this changes versus earlier drafts

Recorded so the reasoning is not re-litigated.

| Decision           | First draft (PG only)         | Second draft (S3 + Keycloak known) | Now (yanshuf3 known)                                                |
| ------------------ | ----------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| audio bytes        | `bytea` column                | S3 object, key in PG               | unchanged                                                           |
| audio URL          | API serving `bytea`           | API proxying S3                    | unchanged; yanshuf3 confirms proxy-not-presign                      |
| auth               | own users + bcrypt + sessions | Keycloak OIDC, PKCE in the SPA     | Keycloak, **server-side code flow in our backend**, httpOnly cookie |
| token in browser   | n/a                           | access token in memory             | **none** — httpOnly cookies                                         |
| `getBuffer` auth   | n/a                           | thread a bearer token in           | **nothing to do**, cookies are automatic                            |
| task runner        | n/a                           | turbo, following yanshuf3          | **none** — npm workspace scripts and `pre*` hooks                   |
| identity key       | local `app_users.id`          | Keycloak `sub`                     | **`upn` stored directly**; no mirror table                          |
| dev database       | local PostgreSQL              | local PostgreSQL                   | **Supabase, over `pg`** — one driver, two hosts                     |
| layout             | add `server/`                 | `apps/web` + `apps/api`            | **`frontend/` + `backend/`**, no shared package                     |
| board seeding      | n/a                           | server-side, from shared `SOUNDS`  | **client-side**; the server has no built-in list                    |
| login UI           | email + password form         | sign-in button                     | **none** — SSO redirect                                             |
| npm in closed net  | "use a mirror"                | same                               | **Nexus**, with `stripLockIntegrity` before `npm ci`                |
| Python needed?     | n/a                           | maybe, for an auth BFF             | **no**                                                              |
| auth flow location | n/a                           | a sidecar process                  | **our own Node backend**                                            |
| OIDC library       | n/a                           | `openid-client`                    | **none** — `jose` only, flow written directly                       |
| secrets access     | env vars                      | a vault microservice               | **direct to Vault KV v2, in-process**                               |
| S3 credentials     | env vars                      | vault                              | **vault**, memoised client                                          |

Unchanged throughout, and still the things that matter most: **never store an absolute
media URL in the database**, and **derive the user server-side, never from the request
body**.

## Open questions

- **A Keycloak client registration for Soundboard**, with `client_secret` stored at
  `idp/keycloak/soundboard` in Vault. The only external dependency the
  no-sidecar decision adds. Also confirm the allowed redirect URI.
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
- Do Keycloak `upn`/email values line up with the current Supabase accounts? With `upn`
  stored directly, this decides whether the **import** can rewrite every `user_id`, so it
  is now a migration blocker rather than a first-login risk. Diff them before cutover.
- Does `0001_init.sql` run in a fresh schema on Supabase, or are the existing
  `user_sounds` / `shared_sounds` tables altered in place? They collide as written.
- PostgreSQL major version, and whether `CREATE EXTENSION` is permitted.
- Internal CA certificate location, for PostgreSQL, S3 and Keycloak.
