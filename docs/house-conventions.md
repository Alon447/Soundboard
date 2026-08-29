# House conventions from sibling projects

Two projects already run in the same closed environment, against the same Keycloak, the
same S3 and the same HashiCorp Vault:

| Project | Path | Shape |
| --- | --- | --- |
| **yanshuf3** | `../yanshuf3` | npm workspaces + turbo: `frontend/`, `backend/` (Express 5 + TS), `packages/shared`, plus Python sidecars (`auth-service`, `vault-microservice`, `query-executor`) |
| **hana2trino** | `../yanshuf3-Hana2Trino` | `frontend/` (Vite + React) and `backend/` (Express 4 + TS), no Python at all, secrets read straight from Vault in-process |

Where they disagree, **hana2trino is the newer and generally better answer** — notably on
secrets, where it replaced yanshuf3's Python vault microservice with a self-contained
TypeScript module.

They are prior art. Copying their conventions beats inventing our own — a third app in
the same environment doing auth and storage differently is a tax on whoever operates all
three. But neither is a clean template: both carry real warts, listed at the end.

## The headline: no Python service is needed

**hana2trino contains no Python whatsoever** and still does Keycloak auth. That settles
the open question.

The OIDC redirect flow — `login-redirect`, `callback`, and setting the session cookie —
is handled by a **sidecar that the environment provides**, not by application code. Both
projects consume it, and they consume it at *different* addresses with *different*
contracts:

| | yanshuf3 | hana2trino |
| --- | --- | --- |
| env var | `AUTH_SERVICE_URL` | `OIDC_SERVICE_URL` |
| dev port | 9000 | 8003 |
| validate endpoint | `POST /auth/oidc/validate-session` | `POST /validate` |
| request body | `{ idToken, accessToken, sessionId }` | `{ token }` |
| routes proxied | `/auth` | `/login-redirect`, `/callback`, `/validate` |

That divergence is the useful signal: the sidecar is **platform infrastructure**, and each
app just points at whichever instance it is given. yanshuf3 happens to ship a copy of one
in `auth-service/`; hana2trino does not, and works fine.

So Soundboard writes **Node only**. No Python, in either project's style.

### Soundboard goes further: no sidecar either

Both projects delegate the redirect flow to a separate process. Soundboard does not — it
runs the whole Authorization Code flow inside its own Node backend. The reasoning:

- **Soundboard is one small app.** A sidecar earns its keep when several apps share one
  Keycloak client registration and one place that knows about the IdP. For a single
  service it is an extra deployment unit, an extra health check and an extra network hop
  for no benefit.
- **The flow is a library call.** `openid-client` does discovery, the authorize URL, PKCE
  and the code exchange, including ID token validation. The three routes are thin.
- **Fewer moving parts in an air-gapped environment**, where every additional service is
  another thing to image, mirror and get firewall rules for.

The pattern that matters — a **server-side code flow that sets an httpOnly cookie, with no
token in the browser** — is preserved exactly. Only its location changes. See
[`target-architecture.md`](./target-architecture.md) for the route design.

The one thing this needs that a shared sidecar would have provided: **Soundboard's own
Keycloak client registration**, with its `client_secret` in Vault. That is a request to
whoever administers the realm, and it is the only external dependency the change adds.

### hana2trino's auth, and what to fix in it

`backend/src/routes/authentication.ts` — `GET /auth/valid`, the session endpoint the
frontend polls:

```ts
if (isBlackEnv()) {
  return res.status(StatusCodes.OK).json({ username: "s8676504", name: "s8676504", IT: true });
}
if (!req.cookies.id_token) return res.sendStatus(StatusCodes.UNAUTHORIZED);

const token = req.cookies.id_token;
const logonValidationResponse = await axios.post(`${config.OIDC_SERVICE_URL}/validate`, { token });
const { ok } = logonValidationResponse.data;

const decodedToken = jsonwebtoken.decode(token);
if (!isDecodedJwtPayload(decodedToken)) return res.sendStatus(StatusCodes.FORBIDDEN);

const username = decodedToken.upn;
```

and `backend/src/middleware/requireUserContext.ts`, mounted once at the API router root,
which attaches `req.userData` for every `/api/*` call.

**Copy the shape.** One middleware mounted once; a `req.userData` augmentation via
`Express.Request`; a `GET /auth/valid` endpoint the frontend consumes through react-query
with `staleTime: Infinity`; identity from a token claim; authorization from a Postgres
table.

**Fix four things while copying:**

1. **`jsonwebtoken.decode()` does not verify anything.** No signature check, no `iss`, no
   `aud`, and `exp` is required to *exist* but never compared to the clock. Use `jose`
   with `createRemoteJWKSet` against the realm, validating `iss`, `aud` and `exp` with a
   small `clockTolerance`.
2. **`ok` is destructured and never checked.** A `200` carrying `{ ok: false }` passes.
3. **`requireUserContext` never calls the sidecar at all** — it only decodes the cookie.
   So the sidecar is consulted once per session and never on data requests. A revoked or
   expired session keeps working until the cookie expires.
4. **`cors()` with no allowlist.** Survives only because production is same-origin.

Gating is structural in both projects and there is no anonymous mode: hana2trino's
`App.tsx` renders the whole tree behind the auth query and self-redirects to
`/login-redirect` on error, with a guard against a redirect loop when already on that
path. Worth copying that guard.

## Vault: talk to it directly, from an in-repo TypeScript module

The two projects do this differently, and **hana2trino's newer approach is the one to
copy**.

yanshuf3 routes everything through a Python `vault-microservice/` and consumes it with a
thin TS client (`backend/src/utils/vault.ts`, `GET http://{VAULT_SERVICE}/secrets/{path}`).
That means an extra service to deploy and keep alive.

hana2trino skips the service entirely. `backend/src/utils/secrets.ts` is a self-contained
TypeScript module that talks **straight to HashiCorp Vault's KV v2 HTTP API**, with a
local-file branch for development:

```ts
export async function getSecret<Fields extends Secret = Secret>(name: string): Promise<Fields> {
  const secret = config.IS_BLACK_ENV ? await readFromFile(name) : await readFromVault(name);
  return secret as Fields;
}

async function readFromVault(name: string): Promise<Secret> {
  const base = config.VAULT_PATH.replace(/\/+$/, "");
  const response = await axios.get(`${base}/data/${name}`, {
    headers: { "X-Vault-Token": config.VAULT_TOKEN, Accept: "application/json" },
    httpsAgent: vaultAgent,
    timeout: VAULT_TIMEOUT_MS,   // 5_000
  });
  const data = (response.data as { data?: { data?: unknown } })?.data?.data;
  if (data === undefined) throw new Error(`Vault response for secret ${name} has no data.data`);
  return toSecret(data, name);
}
```

Note the KV v2 double nesting: the payload lives at `body.data.data`, not `body.data`.

**No microservice, no Python.** `VAULT_PATH` and `VAULT_TOKEN` are required env vars,
validated at boot. This is what Soundboard should do.

Details worth copying verbatim:

- **`SECRET_PATHS` as a `const` object**, so a mistyped path is a compile error rather
  than a runtime 404:
  ```ts
  export const SECRET_PATHS = {
    postgresDev: "db/postgres/dev",
    postgresProd: "db/postgres/prod",
    projectUsers: "Cloud_Services/Project_User_kv",
  } as const;
  ```
- **Value coercion in one place.** `toSecret()` accepts strings and stringifies numbers and
  booleans (because `6543` rather than `"6543"` is what a hand-written local file and Vault
  both hand back). Nested objects and `null` are rejected **by key name**, so the error says
  which field to fix. It also comma-joins arrays of scalars — Soundboard does **not** copy
  that branch: no secret it reads is an array, so it was untested code with no caller.
- **A path containment check** on the local-file branch, so a secret name cannot traverse
  out of `local_secrets/`.
- **`LOCAL_SECRETS_DIR` resolved two levels up from `backend/src/utils`, not three** — the
  container copies `backend/` to `/app`, so anything above the backend root points outside
  the image. That comment is the kind of thing you only learn by breaking it once.
- **Resolve secrets at call time, never at import.** `pg.ts` is explicit about why: "the
  process has to boot with no secret store reachable." yanshuf3 gets this wrong in its
  Python service, where discovery runs at import and Vault being down stops the container
  starting.
- **Zod config with a `blank` preprocessor** treating whitespace-only values as absent, so
  an empty line in `.env` behaves like no line at all, and `process.exit(1)` printing every
  issue at once rather than failing on the first.

There are also unit tests for it — `backend/tests/unit/secrets.test.ts` and
`secretsConfig.test.ts` — which is worth knowing when porting, because they document the
intended coercion behaviour.

### Two things in it not to copy

**No caching at all.** The module docstring is candid: *"Every call reads the store, so a
rotated secret is picked up without a restart. The connection factories are called per
request, which in the closed environment means a Vault round-trip per database call."*
Picking up rotation without a restart is a real benefit, but a Vault round trip per request
is not viable for Soundboard's audio endpoint.

Take a middle path: memoise the derived clients (the `pg.Pool`, the S3 client) as module
singletons, and give the secret read a TTL so rotation is picked up within a few minutes
without paying for it on every request. yanshuf3's `secretsCache.ts` sits at the other
extreme — load once at boot, never refresh — and is worth reading for its
optional-versus-critical distinction (`logger.fatal` plus throw for a secret the server
cannot start without) and its `Promise.allSettled` parallel load.

**A new connection pool per call.** `pg.ts` builds two brand-new `Pool` objects every time
`getPGConnection()` runs:

```ts
const client = (port: string) => new Pool({ user, host, database, password, port: Number(port) });
return { PGReadClient: client(readPort), PGWriteClient: client(writePort) };
```

Nothing closes them. Under load that exhausts connections. Soundboard needs one pool
created once and reused, with `pool.on("error")` and a `SELECT 1` probe at startup.

Also: the generic type argument is honestly documented as *not* validated at runtime, so a
missing field surfaces as a driver error later. Zod-parse each secret at the boundary
instead.

## `IS_BLACK_ENV`: the Node implementation

hana2trino's is the cleanest version, in `backend/src/config/index.ts`:

```ts
const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.string().default("4000").transform(Number),
  IS_BLACK_ENV: z.string().default("false").transform((v) => v.toLowerCase() === "true"),
  OIDC_SERVICE_URL: z.string().optional(),
});
```

with a one-line helper, `backend/src/utils/envCheck.ts`:

```ts
export const isBlackEnv = () => config.IS_BLACK_ENV;
```

Copy that exactly: a string env var, Zod-coerced to boolean, read through a named helper
rather than touching `config.IS_BLACK_ENV` at call sites.

**But do not copy how broadly they use it.** In hana2trino a single flag simultaneously
bypasses authentication, grants `IT: true` (full privileges), swaps the Postgres target,
and returns mock data. One mistyped environment variable is a complete auth bypass with
admin rights.

Split the concerns for Soundboard:

| Concern | Flag | Effect when set |
| --- | --- | --- |
| identity | `IS_BLACK_ENV` | mock claims, Keycloak never contacted — cookie path still runs |
| storage | `IS_BLACK_ENV` | MinIO instead of the internal S3 |
| secrets | `IS_BLACK_ENV` | `local_secrets/*.json` instead of Vault |
| privileges | **never** | a mock user is an ordinary user, not an admin |

Ownership checks must run identically in both modes. If they only run in the closed
environment, they are untested where you actually develop.

## S3: take yanshuf3's credential handling, hana2trino's has not been fixed

Both use `aws-sdk` **v2**, which is EOL — use `@aws-sdk/client-s3` v3 regardless. What
differs is where the credentials come from.

yanshuf3 (`backend/src/utils/s3.ts`) sources them from vault and memoises the client:

```ts
const S3_PARAMS = await getSecret("s3");   // { S3_DOMAIN, S3_ACCESS_ID, S3_SECRET_KEY, S3_BUCKET_NAME }
s3 = new AWS.S3({
  accessKeyId: S3_PARAMS["S3_ACCESS_ID"],
  secretAccessKey: S3_PARAMS["S3_SECRET_KEY"],
  endpoint: new AWS.Endpoint(S3_PARAMS["S3_DOMAIN"]),
  sslEnabled: true,
  s3ForcePathStyle: true,
});
```

**hana2trino's S3 client still hardcodes the access key, secret key, endpoint host and
bucket name as string literals in source**, with `sslEnabled: false` — and it was *not*
updated when `secrets.ts` landed, so it is the one component in that repo still bypassing
Vault. Those credentials are committed to its history and need rotating. Flagged here
rather than reproduced.

That gap is exactly the thing to close in Soundboard: the S3 client is built from
`getSecret('s3')` like every other credential, memoised as a module singleton:

```ts
let client: S3Client | null = null;

export async function getS3() {
  if (client) return client;
  const { S3_DOMAIN, S3_ACCESS_ID, S3_SECRET_KEY } = await getSecret<S3Secret>(SECRET_PATHS.s3);
  client = new S3Client({
    endpoint: S3_DOMAIN,
    region: config.S3_REGION,          // dummy value; the API still requires one
    forcePathStyle: true,              // confirmed required by both projects
    credentials: { accessKeyId: S3_ACCESS_ID, secretAccessKey: S3_SECRET_KEY },
  });
  return client;
}
```

Explicit credentials also short-circuit the AWS SDK's provider chain, which would
otherwise probe EC2 instance metadata and hang in a closed network. Bucket name comes from
the same secret, never a literal in a controller.

**Neither project serves media bytes to a browser.** No presigned URLs anywhere, no
download endpoint in hana2trino, and yanshuf3 proxies its recordings through the API. So
Soundboard's audio endpoint is new ground — but a backend proxy is the lower-risk match
to an environment where the S3 host is internal and the browser may not resolve it at
all. That independently supports the proxy decision in
[`target-architecture.md`](./target-architecture.md).

Neither project has an object-metadata table, content-addressed keys, orphan
reconciliation, multipart upload parsing, MIME validation, or streaming uploads.
Soundboard needs all of those; there is no precedent to inherit.

## Layout, dev topology and offline tooling

yanshuf3's root `package.json` is the naming to match:

```json
"workspaces": ["frontend", "backend", "packages/shared"]
```

with turbo for the task graph and `packages/shared` consumed by name, kept fresh by a
`pre*` hook on every consumer script (`"predev": "npm --prefix .. run build -w @yanshuf/shared"`).

Both projects proxy in dev from Vite so everything is same-origin, with the auth routes
pointing at the sidecar rather than the API. hana2trino's is the more explicit example:

```ts
proxy: {
  "/api":            { target: "http://localhost:4000" },
  "/auth":           { target: "http://localhost:4000" },
  "/login-redirect": { target: "http://localhost:8003" },
  "/callback":       { target: "http://localhost:8003" },
  "/validate":       { target: "http://localhost:8003" },
}
```

Production serves the SPA from nginx in both. Note that **neither nginx config contains
`/api` or `/auth` proxy blocks** — the deployed routing lives in an outer ingress outside
these repos. Worth knowing before assuming the nginx file is the whole story. Soundboard
additionally needs COOP/COEP headers there for ffmpeg.wasm, which neither project needs.

Offline tooling lives in `yanshuf3/scripts/` and answers how `npm ci` works in there:
the mirror is **Nexus**, `stripLockIntegrity.js` must run before `npm ci` (Nexus serves
tarballs whose integrity hashes do not match a public-registry lockfile),
`checkNexusPackages.mjs` reports every missing package at once, and `bundleOfflineDeps.mjs`
stages dependencies for transfer. The internal CA is installed in the Dockerfile via
`update-ca-certificates`, with an internal pip mirror via `PIP_CONFIG_FILE`.

Both repos also generate their agent instructions from a canonical source with a `--check`
in CI — yanshuf3's `scripts/sync-ai-instructions.mjs`. Soundboard's
`scripts/sync-agent-docs.mjs` is the same idea.

## Combined do-not-copy list

- **`aws-sdk` v2** (both projects) — use `@aws-sdk/client-s3` v3.
- **Hardcoded credentials in source** (hana2trino S3, still unfixed after `secrets.ts`
  landed) — Vault, always.
- **No secret caching, so a Vault round trip per request** (hana2trino) — memoise the
  derived clients and give the secret read a TTL.
- **A new `pg.Pool` per call, never closed** (hana2trino `pg.ts`) — one pool, created once,
  with an error handler and a startup probe.
- **A secrets service as a separate process** (yanshuf3) — read Vault directly.
- **`rejectUnauthorized: false` *repo-wide*** (both, everywhere in yanshuf3) — use
  `NODE_EXTRA_CA_CERTS` for S3, Vault and Keycloak. The CA is available; using it is
  configuration, not a blocker. Soundboard's one exception is the PostgreSQL connection,
  which sets it deliberately so a single secret works against Supabase and the internal
  store alike.
- **`jsonwebtoken.decode()` as validation** (hana2trino) — verify with `jose` + JWKS.
- **Unchecked `ok` field** (hana2trino).
- **Re-validating only once per session** (hana2trino) — check on every request, cached.
- **One flag disabling auth *and* granting admin** (hana2trino).
- **`cors()` with no allowlist** (both).
- **JWKS cached for the process lifetime, discovery at import time** (yanshuf3) — key
  rotation needs a restart, and Keycloak being down at boot stops the container starting.
- **Zero clock tolerance, `verify_aud: False`** (yanshuf3).
- **No token refresh; a fixed 12h cookie that can outlive the JWT** (yanshuf3).
- **Bucket auto-creation on write** (yanshuf3) — needs bucket-admin credentials in prod.
- **Hardcoded bucket names in controllers** (both).
- **No ownership check on the object-serving endpoint** (yanshuf3) — any authenticated
  user can fetch any object by id.
- **No migrations, live database as schema truth** (yanshuf3) — Soundboard keeps
  versioned `db/migrations/`.
- **`express.json({ limit })` as the only upload guard** (both) — neither accepts real
  file uploads, so neither has multipart parsing, MIME sniffing or streaming.
- **Inconsistent identity normalisation** (both) — uppercased for one lookup, lowercased
  for another, raw when returned to the client. Normalise once at the boundary.

## The identity gap

Both projects key identity on the **`upn`** claim — an employee number like `T1001001` —
uppercased for database lookups. Neither reads `sub`. Neither has a local users table
mirroring Keycloak, and neither ever inserts an identity row: `upn` is used directly as a
key against pre-existing tables (`auth_user`, `user_details_full`, `special_auth`).

Take the claim choice: `upn` is the organisation's stable cross-app person identifier, so
a Soundboard user is recognisably the same person as a yanshuf3 user.

Soundboard now takes the "no local table" part too: `upn` is stored directly in the
ownership columns. The difference is that yanshuf3's tables were keyed by employee number
from the start, while Soundboard's existing rows hold *Supabase UUIDs*, so the data import
has to rewrite them once. An earlier draft used an `app_users` mirror to bridge that gap
lazily at login instead; it was dropped as a table and a hot-path query for something a
migration step does once. See [`target-architecture.md`](./target-architecture.md).

Both projects also confirm the authorization split Soundboard needs: **the token proves
identity, Postgres decides permission.** yanshuf3 uses Keycloak roles for two coarse
gates; hana2trino uses none at all and reads an `IT` boolean from `public.special_auth`.
Neither pushes fine-grained authorization into Keycloak.
