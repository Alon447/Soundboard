---
inclusion: fileMatch
fileMatchPattern: ["backend/**", "frontend/src/lib/**", "frontend/src/components/AuthPage.tsx", "supabase/**", "db/**", "docs/target-architecture.md", "docs/backend-portability.md", "docs/house-conventions.md"]
---

# You are editing the portability-critical layer

This app is migrating off Supabase into a closed environment that provides
**PostgreSQL, S3-compatible object storage, Keycloak and HashiCorp Vault**, with no
outbound internet. Every file matching this pattern is part of what has to change.

`../yanshuf3` and `../yanshuf3-Hana2Trino` already run on that stack. Copy their
conventions rather than inventing new ones — a third app in the same environment doing
auth and storage differently is a tax on whoever operates all three.

**Soundboard adds exactly one process.** Vault is read directly over KV v2 and the Keycloak
code flow runs in our own backend: no auth sidecar, no vault microservice, no Python.

Design: #[[file:docs/target-architecture.md]]
Reference implementations: #[[file:docs/house-conventions.md]]
Analysis and rejected options: #[[file:docs/backend-portability.md]]

## Rules for changes here

1. **No absolute URLs to media in the database.** `shared_sounds.file_url` stores a
   10-year Supabase signed URL, and that is precisely why the existing data cannot
   move. Store an asset reference; derive the URL on the client
   (`/api/shared-sounds/<id>/audio`). `assetPath()` already passes through
   `/`-rooted paths, so nothing else needs to change.

2. **No new Supabase Storage usage.** It is a separate service, not a Postgres
   feature. Audio bytes go to S3, with only the object key in PostgreSQL.

3. **Do not rely on RLS as the only authorization.** The client currently sends
   `user_id` in inserts and deletes with `.eq('id', dbId)` and no user filter. That
   is safe *only* because of `auth.uid()` policies. Derive the user from the
   validated token server-side and scope every mutation. **A valid Keycloak token
   proves identity, not permission.**

4. **`upn` is the ownership key, stored directly. There is no `app_users` table.**
   `user_sounds.user_id` and `shared_sounds.owner_id` are `text` holding the claim
   (an employee number — `sub` is never read here), uppercased once at the boundary.
   The consequence: existing rows hold **Supabase UUIDs**, so the data import has to
   rewrite them to the matching `upn` using the exported `auth.users` emails. Miss one and
   that board is orphaned silently — the user just sees a freshly seeded empty board.
   Do not reintroduce a mirror table; do not add a per-request resolution query.

4a. **Secrets come from Vault — already built.** `backend/src/utils/secrets.ts` provides
   `getSecret(name, schema?)`, `SECRET_PATHS` and `invalidateSecret`; it reads Vault KV v2
   directly, falls back to `backend/local_secrets/` when `IS_BLACK_ENV`, and caches for
   `SECRET_TTL_MS`. Do not rewrite it, do not add a second way to read secrets, and never
   put a credential in `.env` or in source. **Memoise anything derived from a secret** —
   `backend/src/utils/s3.ts` and `backend/src/utils/pg.ts` show the shape — `getPool()` is
   one pool for the process, not hana2trino's pool-per-call. Do not open a second pool.

5. **Write S3 before PostgreSQL.** They cannot share a transaction. `PutObject`
   first, then the rows in one transaction, so a failure leaves a harmless orphaned
   object rather than a row pointing at nothing. Delete in the mirror order.

6. **New SQL must avoid Supabase-only constructs**: `auth.users`, `auth.uid()`,
   `storage.buckets`, `storage.objects`, `storage.foldername()`.

7. **Prefer `double precision` over `numeric`** for anything the client treats as a
   number. `node-postgres` returns `numeric` as a **string**; PostgREST returns it as
   a number. `gain` is the existing landmine.

8. **Keep the data layer behind the hook.** `useUserSounds` is the only thing that
   touches the backend. Do not scatter queries into components — that turns a
   contained port into a rewrite. On the server side the mirror rule holds: SQL lives
   in `backend/src/routes/`, and every mutation is scoped by the caller's id.

9. **`frontend/src/lib/api.ts` throws; it does not return `{ data, error }`.** react-query
   turns a throw into `error` state on its own, so the wrapper only got unwrapped and
   rethrown at every call site. What *must* stay stable is the **`useUserSounds` return
   object** and the `useAuth` context shape (`user.id`, `user.email`,
   `user.user_metadata.name`, `session`, `loading`, `signOut`). Preserve those and
   `App.tsx` needs no changes at all.

## Playback constraint that is easy to break

`getBuffer` in `App.tsx` calls bare `fetch(url)` with no headers, and caches decoded
`AudioBuffer`s keyed by that URL string. Two consequences:

- A bearer-protected audio endpoint breaks uploaded sounds while built-ins keep working.
  This is why the session is an **httpOnly cookie** set by a server-side code flow, not
  SPA-side PKCE with a bearer token — cookies are sent automatically. Do not add a
  bearer-only audio route.
- A presigned URL rotates per request, so the cache would never hit. Key the cache on
  the sound id if presigning is ever adopted.

## Existing bugs — fix rather than propagate

- `moveSound` uses two racing `UPDATE`s instead of one transactional reorder.
- Nothing ever deletes an upload's bytes or its `shared_sounds` row.
- `shared_sound_id` is `on delete set null`, which violates `sound_source_check`.
- No index on `user_sounds.user_id`.
- No client-side upload size limit.

## Also remember

`frontend/src/lib/ffmpegConvert.ts` fetches its wasm core from `unpkg.com` at runtime — a hard
failure offline, unrelated to Supabase. The AWS SDK's default credential chain probes
EC2 metadata and will hang in a closed network. See the `airgap-readiness` skill.

Documentation updates ship with the change: see the `docs-sync` skill.
