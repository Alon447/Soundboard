---
applyTo: "src/lib/**,supabase/**,src/components/AuthPage.tsx,apps/api/**,apps/web/src/lib/**,packages/shared/**,db/**"
description: "Rules for the portability-critical data, auth and storage layer — this app is migrating off Supabase onto PostgreSQL, S3 and Keycloak in a closed environment."
---

# Portability-critical layer

Every file matching this pattern is part of what has to change to run in the target
closed environment, which provides **PostgreSQL, S3-compatible object storage and
Keycloak**, no Supabase, and no outbound internet — plus a Node API to tie them
together.

Design: `docs/target-architecture.md`. Analysis and rejected options:
`docs/backend-portability.md`. Call-site checklist:
`docs/supabase-surface-inventory.md`. Target schema, API contract and migration
runbook: `.kiro/skills/supabase-to-postgres/references/` (mirrored under
`.claude/skills/`).

## State this before proposing anything

Supabase Storage is not a Postgres feature — it is a separate service keeping bytes on
S3/disk and only metadata in `storage.objects`. And browsers cannot speak the
PostgreSQL wire protocol. Supabase was supplying an entire HTTP layer; porting means
rebuilding it, not swapping a database. So the answer to "can we just point it at our
PostgreSQL" is no.

## Rules

1. **Never use Keycloak's `sub` as a foreign key.** It differs from the Supabase user
   id already stored in `user_sounds.user_id` and `shared_sounds.owner_id`. Ownership
   columns reference `app_users.id`; `oidc_sub` is a separate column resolved per
   request (by `sub`, falling back to `email` and attaching the `sub`). Getting this
   wrong orphans every existing board, and fails **silently** — the user signs in and
   sees a freshly seeded empty board.
2. **No absolute URLs to media in the database.** `shared_sounds.file_url` stores a
   10-year Supabase signed URL, which is exactly why the existing data is unportable.
   Store an asset reference and derive the URL on the client
   (`/api/shared-sounds/<id>/audio`). `assetPath()` already passes through `/`-rooted
   paths, so nothing else changes.
3. **No new Supabase Storage usage.** Audio bytes go to S3; only the object key lives
   in PostgreSQL. Keys are content-addressed: `sounds/<2 hex>/<sha256>.<ext>`.
4. **A valid token proves identity, not permission.** Keycloak does not do
   authorization. The client currently sends `user_id` in every insert and deletes
   with `.eq('id', dbId)` and no user filter; only RLS makes that safe today. Derive
   the user from the validated token server-side and scope every mutation:
   `delete from user_sounds where id = $1 and user_id = $2`. Ignore `user_id` and
   `owner_id` sent by clients.
5. **Write S3 before PostgreSQL.** They cannot share a transaction. `PutObject`
   first, then the rows in one transaction, so a failure leaves a harmless orphaned
   object rather than a row pointing at nothing. Delete in the mirror order: rows
   first, object after, best-effort.
6. **New SQL must avoid Supabase-only constructs**: `auth.users`, `auth.uid()`,
   `storage.buckets`, `storage.objects`, `storage.foldername()`.
7. **Prefer `double precision` over `numeric`** for anything the client treats as a
   number. `node-postgres` returns `numeric` as a **string**; PostgREST returns a
   number. `gain` is the existing landmine.
8. **Keep backend access behind the two hooks.** `useUserSounds` and
   `useSharedSounds` are the only things that talk to the backend. Do not scatter
   queries into components — that turns a contained port into a rewrite.
9. **Keep these shapes stable**: the `{ data, error }` return contract, the `useAuth`
   context (`user.id`, `user.email`, `user.user_metadata.name`, `session`, `loading`,
   `signOut`), the `useUserSounds` return object, and `BoardSound.audio_path` as a
   plain fetchable Web-Audio-decodable URL. Map OIDC claims onto `user`
   (`sub` → `id`, `name ?? preferred_username` → `user_metadata.name`) and `App.tsx`
   needs no changes at all.
10. **Enforce upload size limits** on both client and server. None exists today; the
    only cap was Supabase Storage's 50 MiB, and it disappears.

## Playback constraint that is easy to break

`getBuffer` in `App.tsx` calls bare `fetch(url)` with no headers, and caches decoded
`AudioBuffer`s keyed by that URL string.

- A bearer-protected audio endpoint breaks **uploaded** sounds while built-ins keep
  working, because built-ins are static files. Attach the token in `getBuffer`, or
  use a cookie-based BFF. Decide before writing the audio route.
- A presigned URL rotates per request, so the buffer cache would never hit. Key the
  cache on the sound id if presigning is ever adopted.

## Existing bugs — fix rather than propagate

- `moveSound` runs two racing `UPDATE`s. Prefer a single transactional reorder taking
  the full id order, scoped on `user_id`.
- Nothing ever deletes an upload's bytes or its `shared_sounds` row. Add
  `DELETE /api/shared-sounds/:id` (owner only) plus an S3 reconciliation job.
- `shared_sound_id` is `on delete set null` while `sound_source_check` requires one
  source to be non-null, so deleting a referenced row fails the check constraint. Use
  `on delete cascade`.
- No index on `user_sounds.user_id` despite every read filtering on it.
- `YouTubeSoundPanel.tsx` and `YOUTUBE_SERVER` are dead code — delete, don't port.

## Order of work

No big-bang cutover.

1. **Capture** the rows *and* download every `file_url` while Supabase is still
   reachable — those signed URLs are the only handle on the bytes. Export user emails
   too; the identity mapping needs them.
2. **Seam**: add `src/lib/api.ts` over supabase-js returning the same
   `{ data, error }` shape. Derive `audio_path` from the shared-sound id. Key the
   buffer cache on the sound id. Ship on Supabase first.
3. **Restructure** to `apps/web` + `apps/api` + `packages/shared`, own commit,
   updating every path pattern in `.kiro/steering/` and `.github/instructions/`.
4. **Backend**: migrations with no `auth.`/`storage.` references, the Node API, the S3
   client, Keycloak validation. Test against the real PostgreSQL, S3 and Keycloak.
5. **Flip**: `src/lib/api.ts` over `fetch`, `useAuth` onto `react-oidc-context`,
   `AuthPage` down to a sign-in button, remove `@supabase/supabase-js`.
6. **Harden**: see `airgap-readiness.instructions.md`.

## Ask, don't assume

PostgreSQL version and whether `CREATE EXTENSION` is permitted; which S3
implementation and whether a bucket with credentials exists; whether path-style is
required; the bucket's backup policy; whether a Keycloak client exists that can be
public with PKCE; whether Keycloak account emails match the current Supabase accounts
(this decides whether existing boards reconnect); whether `email_verified` is
trustworthy; whether tokens in browser memory are acceptable or a BFF is required;
where the internal CA certificate lives.

## Verify

`npm run build`, `npm run typecheck`, and `npm run docs:check` if you touched skills.

End to end after the flip: sign in via Keycloak, first-login seeding produces 9 pads,
upload a `.mov`, play a built-in and an uploaded pad, press a pad twice and confirm
the second press does not refetch, reorder, change gain, then sign in as a second user
and confirm you cannot see or delete the first user's pads. For an imported user,
confirm their pre-migration board appears — if it does not, the identity mapping bound
a new row instead of the existing one.
