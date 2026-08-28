---
inclusion: fileMatch
fileMatchPattern: ["src/lib/**", "supabase/**", "src/components/AuthPage.tsx", "backend/**", "frontend/src/lib/**", "packages/shared/**", "db/**", "docs/target-architecture.md", "docs/backend-portability.md", "docs/house-conventions.md"]
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

4. **Never use the Keycloak identity claim as a foreign key.** The claim here is `upn`
   (an employee number — `sub` is never read in this environment), and it differs from
   the Supabase user id already stored in `user_sounds.user_id`. Ownership columns
   reference `app_users.id`; `upn` is a separate column resolved per request. Getting
   this wrong orphans every existing board — and fails silently, because the user just
   sees a freshly seeded empty board.

4a. **Secrets come from Vault, read directly over KV v2**, not `.env`: `getSecret('s3')`,
   `getSecret('db/postgres/<env>')`, `getSecret('idp/keycloak/soundboard')`. Port
   hana2trino's `backend/src/utils/secrets.ts`. Env vars carry non-secret wiring plus
   `VAULT_TOKEN`, Zod-validated at boot with no fallback values. **Memoise the derived
   clients** — one `pg.Pool`, one `S3Client` — rather than reading Vault per request the
   way hana2trino does, and never build a new pool per call the way its `pg.ts` does.

5. **Write S3 before PostgreSQL.** They cannot share a transaction. `PutObject`
   first, then the rows in one transaction, so a failure leaves a harmless orphaned
   object rather than a row pointing at nothing. Delete in the mirror order.

6. **New SQL must avoid Supabase-only constructs**: `auth.users`, `auth.uid()`,
   `storage.buckets`, `storage.objects`, `storage.foldername()`.

7. **Prefer `double precision` over `numeric`** for anything the client treats as a
   number. `node-postgres` returns `numeric` as a **string**; PostgREST returns it as
   a number. `gain` is the existing landmine.

8. **Keep the data layer behind the hooks.** `useUserSounds` and `useSharedSounds`
   are the only things that touch the backend. Do not scatter queries into
   components — that turns a contained port into a rewrite.

9. **Keep the `{ data, error }` return shape** for anything replacing a supabase-js
   call, and keep the `useAuth` context shape (`user.id`, `user.email`,
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

`src/lib/ffmpegConvert.ts` fetches its wasm core from `unpkg.com` at runtime — a hard
failure offline, unrelated to Supabase. The AWS SDK's default credential chain probes
EC2 metadata and will hang in a closed network. See the `airgap-readiness` skill.

Documentation updates ship with the change: see the `docs-sync` skill.
