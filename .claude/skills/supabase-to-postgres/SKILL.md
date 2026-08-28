---
name: supabase-to-postgres
description: Port the Soundboard app off Supabase (GoTrue auth, PostgREST, Storage) onto the closed-environment stack — PostgreSQL for data, S3 for audio bytes, Keycloak for auth, and a Node API tying them together. Use when working on auth, the data layer, sound storage, migrations, the API, the workspace layout, or anything about running this app on-prem. Also use when touching frontend/src/lib/useUserSounds.ts, frontend/src/lib/useSharedSounds.ts, frontend/src/lib/supabase.ts, frontend/src/lib/useAuth.tsx, frontend/src/components/AuthPage.tsx, or supabase/migrations.
---

# Porting Soundboard off Supabase

## Read this first

The browser cannot talk to PostgreSQL, S3 or Keycloak the way it talked to Supabase.
PostgreSQL speaks a binary TCP protocol; S3 needs signed requests and credentials
that must never reach a browser; Keycloak handles login but not data. Supabase was
supplying an entire HTTP layer — GoTrue, PostgREST and Storage — and that layer has
to be rebuilt.

**This is not a database swap.** If someone asks whether the app can just point at
the closed-environment PostgreSQL, the answer is no. Say why before proposing
anything.

What the environment provides, and what each piece replaces:

| Available | Replaces |
| --- | --- |
| PostgreSQL | PostgREST-backed tables |
| S3-compatible object storage | Supabase Storage |
| Keycloak | GoTrue |
| HashiCorp Vault (KV v2) | secrets that would otherwise sit in `.env` |
| a Node process | the OIDC flow, ownership checks, S3 proxying, seeding |

**Soundboard adds exactly one process.** Vault and Keycloak are spoken to directly over
HTTP. No auth sidecar, no vault microservice, no Python — unlike the sibling projects, which
split both out.

**Two sibling projects already run on this exact stack** — `../yanshuf3` and
`../yanshuf3-Hana2Trino`, against the same Keycloak, S3 and vault. Read
`docs/house-conventions.md` before designing anything: most decisions are already made
there, and a third app doing auth and storage differently is a tax on whoever operates
all three.

The one that matters most: hana2trino has **no Python at all** and still does Keycloak auth
and reads Vault directly. Soundboard goes one step further and keeps the OIDC flow in its
own backend rather than a sidecar.

Documents, in the order they are useful:

- `docs/target-architecture.md` — the decided design. Start here.
- `docs/house-conventions.md` — the reference implementations: copy list, do-not-copy
  list, and the gaps they do not cover.
- `docs/backend-portability.md` — why, and what was rejected.
- `docs/supabase-surface-inventory.md` — every call site, as a checklist.
- `docs/architecture.md` — how the app works today.

References in this skill:

- `references/target-schema.sql` — the schema, ready to adapt
- `references/api-contract.md` — endpoints, auth model, response shapes
- `references/data-migration.md` — getting data, bytes and identities across

## Non-negotiable rules

**Never store an absolute URL in the database.** `file_url` holding a Supabase
signed URL is exactly why the current data cannot move. Store an asset reference and
derive the URL client-side:

```ts
// frontend/src/lib/useUserSounds.ts — userSoundToBoard
audio_path: builtin?.audio_path
  ?? (row.shared_sound ? `/api/shared-sounds/${row.shared_sound.id}/audio` : '')
```

`assetPath()` already passes through `/`-rooted paths. Nothing else changes, and the
byte-storage choice stays swappable.

**Derive the user from the token, server-side. Never from the request body.**
The client currently sends `user_id` in every insert and deletes with
`.eq('id', dbId)` and no user filter — RLS is the only thing making that safe, and
RLS is going away. Every mutation must be scoped:

```sql
delete from user_sounds where id = $1 and user_id = $2
```

Ignore any `user_id` / `owner_id` a client sends. **A valid Keycloak token proves
identity, not permission.** Authentication and authorization are separate, and
conflating them is the easiest way to build a system where any user can delete
anyone's board.

**Never use the Keycloak identity claim as a foreign key.** The claim here is `upn` (an
employee number, what yanshuf3 keys everything on — `sub` is never read in this
environment), and it differs from the Supabase user id already in
`user_sounds.user_id`. Ownership columns reference `app_users.id`; `app_users` carries
`upn` as a separate resolvable column. The resolve-by-`upn`-then-`email` sequence in
`docs/target-architecture.md` is what reconnects imported users to their existing
boards. Getting this wrong orphans every board — and fails silently, because the user
just sees a freshly seeded empty board.

**Secrets come from Vault, read directly, not from `.env`.** `getSecret('s3')`,
`getSecret('db/postgres/<env>')`, `getSecret('idp/keycloak/soundboard')`. Env vars carry
non-secret wiring plus `VAULT_TOKEN` — the one credential that cannot itself come from
Vault — validated with Zod at boot with no fallback values.

Port hana2trino's `backend/src/utils/secrets.ts`: a self-contained TypeScript module hitting
the KV v2 API (`GET {VAULT_PATH}/data/{name}` with an `X-Vault-Token` header, payload at
`body.data.data`), with an `IS_BLACK_ENV` branch reading `local_secrets/<name>`. Keep its
`SECRET_PATHS` `as const` object, its value coercion, and its rule of resolving at call time
rather than at import so the process boots with Vault unreachable.

**But memoise the derived clients** — one `pg.Pool` and one `S3Client`, built lazily and
reused, with a TTL on the secret read. hana2trino reads Vault on every call and builds two
new pools per `getPGConnection()`, closing neither.

**Verify tokens properly.** Both sibling projects get this wrong: hana2trino uses
`jsonwebtoken.decode()` (no signature check, `exp` never compared to the clock) and never
tests the sidecar's `ok` field; yanshuf3 skips audience validation and passes no clock
tolerance. Use `jose` + `createRemoteJWKSet`, checking `iss`, `aud` and `exp` with a small
`clockTolerance`.

**`IS_BLACK_ENV` must not grant privileges.** Copy hana2trino's Zod-coerced boolean and
`isBlackEnv()` helper, but only for identity mocking, MinIO-instead-of-S3 and
`local_secrets/`. In hana2trino the same flag also grants `IT: true`, so one mistyped env
var is an auth bypass with admin rights. Ownership checks must behave identically in both
modes.

**Write S3 before PostgreSQL.** They cannot share a transaction. `PutObject` first,
then insert the rows in one transaction. A failure then leaves an orphaned object,
which is invisible and reclaimable; the reverse order leaves a row pointing at
nothing, which is a broken pad. Delete in the mirror order: rows first, object after.

**Use `double precision`, not `numeric`, for `gain`.** PostgREST returns `numeric`
as a JSON number; `node-postgres` returns it as a **string**. Alternatively
`pg.types.setTypeParser(1700, parseFloat)`.

**Enforce an upload size limit on both client and server.** There is none today; the
only limit was Supabase Storage's 50 MiB and it disappears.

## Already built

The `backend/` workspace exists with the infrastructure layers done, so do not rewrite
these — extend them:

| Module | Provides |
| --- | --- |
| `backend/src/config/index.ts` | Zod-validated env; exits at boot listing every problem |
| `backend/src/utils/secrets.ts` | `getSecret(name, schema?)` over Vault KV v2, local-file branch for `IS_BLACK_ENV`, TTL cache, `SECRET_PATHS`, `invalidateSecret` |
| `backend/src/utils/s3.ts` | `getStorage()` memoised client, `buildObjectKey`, `sha256Hex`, put/get/head/delete |
| `backend/src/utils/envCheck.ts` | `isBlackEnv()` |
| `backend/src/utils/logger.ts` | object-first structured logging, no dependencies |
| `backend/src/checkConnectivity.ts` | `npm run api:check` — reads every secret, round-trips an object through S3 |

Still to come: the `pg.Pool` (one pool, memoised, `SELECT 1` at startup — not hana2trino's
pool-per-call), the migrations in `db/migrations/`, the OIDC routes, and the HTTP layer.

## Order of work

Each phase builds and typechecks on its own. No big-bang cutover.

1. **Capture** — export the rows *and* download every `file_url` while Supabase is
   still reachable. Those signed URLs are the only handle on the bytes. Export
   `auth.users` emails too: the identity mapping needs them. See
   `references/data-migration.md`.
2. **Seam** — add `frontend/src/lib/api.ts` with the operations the hooks need, still over
   supabase-js, returning the existing `{ data, error }` shape. Move `UserSound` /
   `SharedSound` into `frontend/src/lib/types.ts`. Derive `audio_path` from the shared-sound
   id. Key the decoded-buffer cache in `App.tsx` on the sound id rather than the URL
   — cheap now, awkward later, and it keeps presigned URLs available as an option.
   Ship on Supabase and confirm no regression.
3. ~~**Restructure**~~ — **done.** `frontend/` and `backend/` are npm workspaces; the root
   `package.json` is orchestration only. `packages/shared` is deferred until the backend
   needs the `SOUNDS` list.
4. **Backend** — migrations from `references/target-schema.sql`, the API from
   `references/api-contract.md`, the secrets module, the S3 client, the OIDC routes and
   per-request verification. **Build `IS_BLACK_ENV` mock mode first**, so the whole thing is
   developable with neither Keycloak nor Vault reachable. Import the captured data. Then
   test against the real PostgreSQL, S3, Vault and Keycloak — versions, path-style quirks,
   privileges and realm config are what will bite, not logic.
5. **Flip** — reimplement `frontend/src/lib/api.ts` over `fetch` with
   `credentials: 'same-origin'`, replace `useAuth.tsx`'s Supabase session with
   `GET /api/me` plus a `login()` that navigates to `/auth/login`, **delete**
   `AuthPage.tsx`, then
   delete `@supabase/supabase-js` and the `VITE_SUPABASE_*` vars. No OIDC client
   library gets added.
6. **Harden** — see the `airgap-readiness` skill.

## Keep these interfaces stable

Changing them turns a contained port into a rewrite.

```ts
// frontend/src/lib/useAuth.tsx — same shape, Keycloak underneath
{ user: { id: string; email?: string; user_metadata?: { name?: string } } | null,
  session: unknown | null, loading: boolean, signOut: () => Promise<void> }

// frontend/src/lib/useUserSounds.ts — the exported hook API
{ sounds: BoardSound[], loading, error,
  addBuiltinSound, addCustomSound, addSharedSound,
  removeSound, moveSound, updateGain, refetch }
```

`GET /api/me` populates `user`: `app_users.id` → `id`, `email` → `email`, display name
→ `user_metadata.name`. Do that and `App.tsx`, `useUserSounds` and `useSharedSounds`
need no changes at all. Note `user.id` is the **local** id, not the Keycloak claim.

`BoardSound.audio_path` must stay a plain fetchable, Web-Audio-decodable URL.

## The trap the cookie session exists to avoid

`getBuffer` in `App.tsx` calls bare `fetch(url)` with no headers. If
`/api/shared-sounds/:id/audio` required `Authorization: Bearer <token>`, **uploaded
sounds would stop playing while built-ins kept working** — because built-ins are static
files. Easy to misdiagnose as a storage problem.

Cookies are sent automatically, which is one of the three reasons the design uses a
server-side flow with a cookie rather than SPA-side PKCE with a bearer token. **Do not add a
bearer-only route for audio later**; it reopens exactly this.

## Bugs to fix while you are in here

Do not port these forward.

- `moveSound` runs two racing `UPDATE`s via `Promise.all`. Replace with one
  transactional reorder taking the full id order.
- Nothing ever deletes an upload's bytes or its `shared_sounds` row. Add
  `DELETE /api/shared-sounds/:id` (owner only) plus the S3 reconciliation job.
- `shared_sound_id` is `on delete set null` while `sound_source_check` requires one
  source to be non-null, so deleting a referenced row fails the check constraint.
  Use `on delete cascade`.
- No index on `user_sounds.user_id` despite every read filtering on it.
- `YouTubeSoundPanel.tsx` and `YOUTUBE_SERVER` are dead code. Delete, don't port.

## Settle these before writing the backend

Ask rather than assume:

- **A Keycloak client registration for Soundboard**, with `client_secret` at
  `idp/keycloak/soundboard` in Vault, plus the allowed redirect and post-logout redirect
  URIs. The only dependency the no-sidecar decision adds.
- **The Vault mount path, and how `VAULT_TOKEN` reaches the container** — its TTL and
  whether it needs renewing.
- Which S3 implementation (MinIO, Ceph RGW, StorageGRID, ECS)? yanshuf3 never names it.
  A dedicated bucket or a prefix in a shared one? Credentials provisioned? Backup and
  retention policy on it?
- A Keycloak client for Soundboard and a vault path for its credentials, or does it
  reuse yanshuf3's client?
- Do Keycloak `upn`/email values match the current Supabase accounts? This decides
  whether existing boards reconnect. Diff before cutover.
- Is `email_verified` trustworthy in that realm? Step 2 of identity resolution needs it.
- PostgreSQL major version; `CREATE EXTENSION` / `CREATE SCHEMA` permitted?
- Internal CA certificate location, for PostgreSQL, S3 and Keycloak.
- Realistic user count, upload count, max clip size.

## Verify

`npm run build` and `npm run typecheck` after any app change, and
`npm run docs:check` if you touched the skills.

End to end, after the flip: sign in via Keycloak, first-login seeding produces 9 pads,
upload a `.mov` (exercises ffmpeg, S3 write, and serve), play a built-in and an uploaded
pad, press the same pad twice and confirm the second press does not refetch, reorder,
change gain, then sign in as a second user and confirm you cannot see or delete the
first user's pads.

For an imported user specifically: confirm their pre-migration board appears. If it does
not, the identity mapping is wrong — check `app_users.upn` was attached to the existing
row rather than a new row being created.

Also verify the failure modes, which are where this design differs from the old one: make
Keycloak unreachable and confirm the app shows a retry rather than a redirect loop, and
confirm `IS_BLACK_ENV` mock mode exercises the full cookie path with neither Keycloak nor
Vault running.
