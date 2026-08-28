# yanshuf3 as reference implementation

`../yanshuf3` is a sibling project already running in the same closed environment,
already integrated with the same Keycloak and the same S3. It is prior art, and
copying its conventions beats inventing our own — a second app in the same
environment that does auth and storage *differently* is a maintenance tax on whoever
operates both.

This document records what to copy, what to deliberately not copy, and what yanshuf3
does not answer. File paths below are relative to `../yanshuf3`.

It also changed three decisions in
[`target-architecture.md`](./target-architecture.md): auth moved from SPA-side PKCE
to a cookie BFF, secrets moved from env vars to a vault service, and the workspace
layout realigned to yanshuf3's naming.

## Copy: the auth-service BFF

yanshuf3 uses **no frontend OIDC library at all**. No `oidc-client-ts`, no
`keycloak-js`, no `react-oidc-context`. Instead there is a small FastAPI service
(`auth-service/`, port 9000) that owns the whole Authorization Code flow as a
**confidential client** and hands the browser httpOnly cookies. The SPA never sees a
token.

Three endpoints, all in `auth-service/app/routers/oidc.py`:

| Method | Path | Role |
| --- | --- | --- |
| GET | `/auth/oidc/login-redirect?state=<return url>` | builds the authorize URL, 302s to Keycloak |
| GET | `/auth/oidc/callback?code=&state=` | exchanges the code server-side, sets cookies, 302s back to `state` |
| POST | `/auth/oidc/validate-session` | internal RPC: validates the tokens, returns claims |

```python
response = RedirectResponse(url=redirect_uri)
response.set_cookie(key="id_token",     value=id_token,     httponly=True, max_age=expires_in)
response.set_cookie(key="access_token", value=access_token, httponly=True, max_age=expires_in)
```

The frontend's entire notion of "log in" is a full-page navigation
(`frontend/src/features/auth/slice/authSlice.ts`):

```ts
const loginUrl = new URL("/auth/oidc/login-redirect", location.origin);
loginUrl.search = new URLSearchParams({ state: encodeURIComponent(location.href) }).toString();
location.replace(loginUrl);
```

**Why this matters more for Soundboard than it did for yanshuf3:** cookies are sent
automatically by `fetch`, which means `getBuffer` in `App.tsx` — a bare
`fetch(url)` with no headers — works unchanged against an authenticated audio
endpoint. The bearer-token design would have required threading an access token into
the audio fetch. The BFF makes that whole problem disappear.

The Node backend does not verify JWTs itself. It reads the cookies and delegates
(`backend/src/middleware/authMiddleware.ts`):

```ts
const response = await axios.post(`${AUTH_SERVICE_URL}/auth/oidc/validate-session`, {
  idToken: req.cookies?.id_token ?? "",
  accessToken: req.cookies?.access_token ?? "",
  sessionId: existingSessionId,
}, { timeout: 5000 });
```

Soundboard can either call the same `auth-service` (if it is deployed as shared
infrastructure) or verify tokens in-process with `jose`. Calling the existing service
is less code and keeps one place that knows about Keycloak. **Ask which it is** —
whether `auth-service` is per-app or shared changes the deployment shape.

## Copy: `IS_BLACK_ENV` mock mode

With `IS_BLACK_ENV=true`, no IdP is contacted at all. `login-redirect` jumps straight
to the app's own callback with `code=mock-code`, the token exchange returns
`{'id_token': 'mock-id-token', 'access_token': 'mock-access-token'}`, and
`validate-session` synthesizes claims from `USERNAME`, `OIDC_REALM_ROLES` and
`CURRENT_OIDC_CLIENT_ROLES` env vars. The cookie-setting path still runs, so the mock
exercises the real session flow.

This is how you develop the entire auth stack with no Keycloak available, which is
most of the time when working outside the closed network. **Copy this wholesale.** It
is worth more than any other single pattern here.

The same flag also switches storage between MinIO and the internal S3, so one boolean
covers "am I outside the closed environment".

## Copy: vault for secrets, not env vars

`vault-microservice/` is ~90 lines of FastAPI brokering secrets, with a Redis mirror
so HashiCorp Vault being down does not take the app down:

```python
def _get_secret(secret_name: str):
    if config.IS_BLACK_ENV:
        return _get_secret_from_local_files(secret_name)   # local_secrets/<path>
    return _request_secret_from_vault(secret_name)
```

Consumers use a thin client (`backend/src/utils/vault.ts`) and secrets are namespaced
by path. Existing paths: `s3`, `db/postgres/dev`, `idp/keycloack/yanshuf-localhost`
(the typo is in the real path), `smtp`, `matomo`, `lens-handler`.

For Soundboard that means the S3 keys, the PostgreSQL password and the Keycloak
client secret come from `getSecret('s3')`, `getSecret('db/postgres/<env>')` and
`getSecret('idp/keycloack/soundboard')` — **not** from `.env`. Only `VAULT_SERVICE`
stays an environment variable. In development, secrets are JSON files under
`local_secrets/`, gitignored and distributed out of band.

This supersedes the env-var list in the earlier draft of `target-architecture.md`.

## Copy: the S3 client shape

`backend/src/utils/s3.ts`:

```ts
const S3_PARAMS = await getSecret("s3");   // { S3_DOMAIN, S3_ACCESS_ID, S3_SECRET_KEY, S3_BUCKET_NAME }
s3 = new AWS.S3({
  accessKeyId: S3_PARAMS["S3_ACCESS_ID"],
  secretAccessKey: S3_PARAMS["S3_SECRET_KEY"],
  endpoint: new AWS.Endpoint(S3_PARAMS["S3_DOMAIN"]),
  sslEnabled: true,
  s3ForcePathStyle: true,
  httpOptions: { agent: new https.Agent({ rejectUnauthorized: false }) },
});
```

What to take from it: **explicit credentials, explicit endpoint, path-style, lazily
constructed and memoised in a module-level singleton.** Path-style being required is
now confirmed rather than assumed, and explicit credentials mean the AWS SDK never
walks its provider chain into an EC2 metadata timeout.

Dev uses MinIO on port 9010 from `docker-compose.yaml`, with `useSSL: false` and the
host/port split out of the single `S3_DOMAIN` field
(`backend/src/utils/minio.ts`). `backend/src/utils/s3RecordSessionClient.ts` is the
dynamic-import shim that lets one `{ Bucket, Key, Body }` interface target either —
a clean template.

**yanshuf3 also proxies bytes through the API rather than presigning**, and
consequently has no bucket CORS configuration anywhere. That independently confirms
the decision in `target-architecture.md`.

## Copy: workspace layout and naming

Root `package.json`:

```json
"workspaces": ["frontend", "backend", "packages/shared"]
```

plus turbo for the task graph, and the Python services deliberately *outside* the
workspace as their own containers. Soundboard's layout should match this naming —
`frontend/`, `backend/`, `packages/shared/` — rather than the `apps/web` + `apps/api`
convention drafted earlier. Consistency across two projects in the same organisation
is worth more than the aesthetic preference.

`packages/shared` is a plain `tsc`-compiled types-and-constants package consumed by
name (`@yanshuf/shared`), with a barrel `src/index.ts`. The convention that makes it
work without project references is a `pre*` hook on every consumer script:

```json
"predev":       "npm --prefix .. run build -w @yanshuf/shared",
"prebuild":     "npm --prefix .. run build -w @yanshuf/shared",
"pretypecheck": "npm --prefix .. run build -w @yanshuf/shared"
```

Soundboard's equivalent package holds the `SOUNDS` list and the row types.

Other conventions worth matching: lowerCamelCase files and folders; `backend/src`
split into `config/ controllers/ middleware/ routes/ services/ types/ utils/`; thin
routes, controllers own HTTP shape, services own logic, `utils/` owns integrations;
errors always via a factory and `next(err)`, never `res.status(500)` inline;
logger calls object-first; Zod-validated config that exits on missing env.

The Vite dev proxy shape, from `frontend/vite.config.ts` — note `/auth` bypassing the
backend entirely and specific routes before general:

```ts
proxy: {
  "/api": { target: "http://127.0.0.1:3001" },
  "/auth": { target: "http://127.0.0.1:9000" },
}
```

Production serves the SPA from **nginx**, not from the backend
(`frontend/Dockerfile` → `turbo prune` → `nginx:stable-alpine`), with immutable
caching on `/assets/` and `try_files $uri =404` so a missing JS file 404s instead of
returning `index.html`. Soundboard needs one addition nginx there does not have:
COOP/COEP headers for ffmpeg.wasm.

## Copy: the offline and mirror tooling

This answers the "how does `npm ci` work in a closed network" question concretely.
The npm mirror is **Nexus**, and `scripts/` holds the tooling:

- `checkNexusPackages.mjs` — reads `package-lock.json` and reports *every* package
  missing from the mirror at once, instead of discovering them one at a time through
  failing `npm ci` runs. `--prepare-upload --tarballs <dir>` builds `.tgz` bundles to
  upload.
- `stripLockIntegrity.js` — run **before** `npm ci` inside the Dockerfiles, because a
  Nexus-proxied registry serves tarballs whose integrity hashes do not match a
  lockfile generated against the public registry. Without this, `npm ci` fails in the
  closed environment and the error does not obviously point at the mirror.
- `bundleOfflineDeps.mjs` — stages and archives npm deps for transfer across the air
  gap.
- `bundle.ps1` / `import-bundle.ps1` — moving build artefacts across the gap.

Also: `auth-service/Dockerfile` is where the internal CA actually gets installed, and
it uses an internal pip mirror:

```dockerfile
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
COPY certs/* /usr/local/share/ca-certificates/
RUN update-ca-certificates
ENV PIP_CONFIG_FILE=/opt/etc/pip.conf
```

And `docs/duckdb-result-store-design.md` repeatedly notes that WASM bundles must be
vendored offline because TEST/PROD are internet-disconnected. That is the house answer
to our ffmpeg.wasm problem: **vendor the artefact into the image, never fetch at
runtime.**

## Copy: the generated-agent-instructions pattern

`AGENTS.md` is canonical and hand-edited; `.github/*` and `.claude/*` are **generated**
by `scripts/sync-ai-instructions.mjs` and verified with `--check` in CI via a
`check:ai-instructions` script.

Soundboard already does the equivalent for `.claude/skills` via
`scripts/sync-agent-docs.mjs`. Worth considering: promote `AGENTS.md` to canonical and
generate more of the agent config from it, and wire `docs:check` into CI the way
yanshuf3 does.

## Do not copy

Each of these is a known wart, and in most cases Soundboard's existing docs already
call for the better option.

**`aws-sdk` v2.** yanshuf3 uses the EOL monolith (`aws-sdk@^2.1692.0`). Use
`@aws-sdk/client-s3` v3, modular, as `airgap-readiness` already specifies.

**Blanket `rejectUnauthorized: false`.** It appears in the S3 client, the Trino
client, the AI API client, SMTP, Superset and telemetry — TLS verification is disabled
repo-wide instead of installing the internal CA. Use `NODE_EXTRA_CA_CERTS`. The CA is
available in that environment; using it is configuration, not a blocker.

**Bucket auto-creation on write.** `minio.ts` does `bucketExists` → `makeBucket` on
every upload path, which requires bucket-admin credentials in production. Provision
the bucket once, out of band.

**Hardcoded bucket names in controllers.** `const S3_SESSION_RECORD_BUCKET_NAME =
"recordings"` is declared twice in one file. Bucket belongs in config.

**No ownership check on the object-serving endpoint.** Any authenticated user can
fetch any recording by session id. Soundboard's audio endpoint must scope on the
caller — the rule is already in the steering file, and here is a live example of what
happens without it.

**No migrations.** yanshuf3 treats the live database as schema truth and snapshots it
for reference (`postgres/db-schema-snapshot.sql` is explicitly generated, and
`AGENTS.md` forbids treating Drizzle files as truth). Soundboard already has versioned
migrations and a closed environment needs a repeatable, reviewable path — keep
`db/migrations/`.

**Buffering whole payloads in memory with only `express.json({ limit: '10mb' })` as a
guard.** yanshuf3 accepts no user file uploads at all, so it has no multipart parsing,
no MIME sniffing and no streaming. Soundboard does accept uploads and needs all three.

**JWKS cached forever.** `@lru_cache(maxsize=1)` with no TTL means a Keycloak key
rotation requires an auth-service restart. Discovery also runs at *import* time, so
Keycloak being down at boot means the container will not start.

**Zero clock-tolerance and no audience validation.** `jwt.decode` is called with
`verify_aud: False` and no `leeway`. Issuer *is* validated. If Soundboard verifies
tokens in-process, validate audience too, and allow a small skew.

**No token refresh.** The refresh token from the code exchange is discarded, and the
cookie `max_age` is a fixed 12h `TOKEN_EXPIRATION_LEEWAY` rather than the IdP's real
`expires_in` — so the cookie can outlive the JWT. Expiry surfaces as a poll
(`useSessionPing`, hourly) and a dialog telling the user to reload.

**`allow_origins=["*"]` with `allow_credentials=True`** in the auth-service CORS
middleware. Browsers reject that combination for credentialed requests; it only
survives because everything is same-origin behind the proxy.

## What yanshuf3 does not answer

- **Which S3 implementation the closed environment actually runs.** Never named in
  `.env.example`, compose, docs or the vault secret shape — the secret is just
  `{ S3_DOMAIN, S3_ACCESS_ID, S3_SECRET_KEY, S3_BUCKET_NAME }`. Path-style is required
  and the certificate is not publicly trusted, which fits MinIO, Ceph RGW and
  StorageGRID equally. Still an open question.
- **Content-addressed object keys.** yanshuf3 keys are `<env>/<sessionId>.bin` and
  `export/<name>.xlsx`. No hashing, no dedupe.
- **An object metadata table.** There is none; the database does not know objects
  exist. Soundboard's `sound_assets` is a new invention, not a port.
- **Orphan reconciliation or write ordering.** Nothing references objects, so there is
  no ordering discipline to inherit.
- **A local users table mirroring Keycloak.** See below — this is the important gap.

## The identity gap, and how we differ

yanshuf3 keys identity on the **`upn` claim**, uppercased, used directly as a plain
`varchar` user id against pre-existing employee-number-keyed tables:

```python
if not "upn" in id_token_validation["payload"]:
    return JSONResponse(status_code=403, content={"ok": False, "error": "Missing upn in id token"})
validation["payload"]["upn"] = validation["payload"]["upn"].upper()
```

```ts
const { upn: username, exp, iat } = payload;
return { effectiveUsername: username, realUsername: realUsername ?? username, ... };
```

**The `sub` claim is never read or stored.** There is no local users table, no upsert,
no provisioning — `upn` (an employee number like `T1001001`) is the foreign key value
everywhere, and lookups against `auth_user` / `user_details_full` are read-only with a
graceful fallback to the raw username.

Two things to take from this:

1. **`upn` is the organisation's stable cross-app person identifier**, and it is what
   Keycloak emits here. Soundboard should key on `upn`, not `sub` — that is what makes
   a Soundboard user recognisably the same person as a yanshuf3 user, and it is
   stable across realm migrations in a way `sub` is not.
2. **Do not copy the "no local table" part.** It only works because the org already
   had employee-number-keyed tables. Soundboard has existing rows keyed by *Supabase*
   UUIDs, so it needs the `app_users` mirror to bridge them. Keep `app_users.id` as
   the internal UUID primary key that all ownership columns reference, and add `upn`
   as a unique column resolved per request.

Also worth noting: yanshuf3's case handling is inconsistient — `upn` uppercased, Redis
keys lowercased, one URL lowercased, DB comparisons against the uppercase value. Pick
one canonical form, normalise once at the boundary, and never re-normalise.

## Authorization: the split to imitate

yanshuf3 uses Keycloak roles for exactly two coarse things: an `IT-access` realm role
as a superuser flag, and a per-environment client role (`test-access`,
`temp-prod-access`) gating who may use TEST and PROD at all.

**Everything finer — domains, groups, per-folder read/write ACLs — is computed in
PostgreSQL and enforced by the application.** That is exactly the split Soundboard
needs to replace Supabase RLS: Keycloak proves identity and maybe a coarse
environment gate; the database and the API decide what you may touch.
