---
name: supabase-to-postgres
description: Port the Soundboard app off Supabase (GoTrue auth, PostgREST, Storage) onto the closed-environment stack — PostgreSQL for data, S3 for audio bytes, Keycloak for auth, and a Node API tying them together. Use when working on auth, the data layer, sound storage, migrations, the API, the workspace layout, or anything about running this app on-prem. Also use when touching src/lib/useUserSounds.ts, src/lib/useSharedSounds.ts, src/lib/supabase.ts, src/lib/useAuth.tsx, src/components/AuthPage.tsx, or supabase/migrations.
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
| a Node process | the glue: ownership checks, S3 proxying, seeding |

Documents, in the order they are useful:

- `docs/target-architecture.md` — the decided design. Start here.
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
// src/lib/useUserSounds.ts — userSoundToBoard
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

**Never use Keycloak's `sub` as a foreign key.** It is a different UUID from the
Supabase user id already in `user_sounds.user_id`. Ownership columns reference
`app_users.id`, and `app_users` carries `oidc_sub` as a separate resolvable column.
The resolve-by-`sub`-then-`email` sequence in `docs/target-architecture.md` is what
reconnects imported users to their existing boards. Getting this wrong orphans
every board in the database.

**Write S3 before PostgreSQL.** They cannot share a transaction. `PutObject` first,
then insert the rows in one transaction. A failure then leaves an orphaned object,
which is invisible and reclaimable; the reverse order leaves a row pointing at
nothing, which is a broken pad. Delete in the mirror order: rows first, object after.

**Use `double precision`, not `numeric`, for `gain`.** PostgREST returns `numeric`
as a JSON number; `node-postgres` returns it as a **string**. Alternatively
`pg.types.setTypeParser(1700, parseFloat)`.

**Enforce an upload size limit on both client and server.** There is none today; the
only limit was Supabase Storage's 50 MiB and it disappears.

## Order of work

Each phase builds and typechecks on its own. No big-bang cutover.

1. **Capture** — export the rows *and* download every `file_url` while Supabase is
   still reachable. Those signed URLs are the only handle on the bytes. Export
   `auth.users` emails too: the identity mapping needs them. See
   `references/data-migration.md`.
2. **Seam** — add `src/lib/api.ts` with the operations the hooks need, still over
   supabase-js, returning the existing `{ data, error }` shape. Move `UserSound` /
   `SharedSound` into `src/lib/types.ts`. Derive `audio_path` from the shared-sound
   id. Key the decoded-buffer cache in `App.tsx` on the sound id rather than the URL
   — cheap now, awkward later, and it keeps presigned URLs available as an option.
   Ship on Supabase and confirm no regression.
3. **Restructure** — move to `apps/web` + `apps/api` + `packages/shared`. Own
   commit, no behaviour change. Update every path pattern in `.kiro/steering/*.md`
   and `.github/instructions/*` in the same commit.
4. **Backend** — migrations from `references/target-schema.sql`, the API from
   `references/api-contract.md`, the S3 client, Keycloak token validation. Import
   the captured data. Test against the real PostgreSQL, S3 and Keycloak — versions,
   path-style quirks, privileges and realm config are what will bite, not logic.
5. **Flip** — reimplement `src/lib/api.ts` over `fetch`, swap `useAuth.tsx` to
   `react-oidc-context`, reduce `AuthPage.tsx` to a sign-in button, delete
   `@supabase/supabase-js` and the `VITE_SUPABASE_*` vars.
6. **Harden** — see the `airgap-readiness` skill.

## Keep these interfaces stable

Changing them turns a contained port into a rewrite.

```ts
// src/lib/useAuth.tsx — same shape, Keycloak underneath
{ user: { id: string; email?: string; user_metadata?: { name?: string } } | null,
  session: unknown | null, loading: boolean, signOut: () => Promise<void> }

// src/lib/useUserSounds.ts — the exported hook API
{ sounds: BoardSound[], loading, error,
  addBuiltinSound, addCustomSound, addSharedSound,
  removeSound, moveSound, updateGain, refetch }
```

Map the OIDC profile onto `user`: `sub` → `id`, `email` → `email`,
`name ?? preferred_username` → `user_metadata.name`. Do that and `App.tsx`,
`useUserSounds` and `useSharedSounds` need no changes at all.

`BoardSound.audio_path` must stay a plain fetchable, Web-Audio-decodable URL.

## The trap that breaks playback silently

`getBuffer` in `App.tsx` calls bare `fetch(url)` with no headers. If
`/api/shared-sounds/:id/audio` requires `Authorization: Bearer <token>`, **uploaded
sounds stop playing while built-ins keep working** — because built-ins are static
files. Easy to misdiagnose as a storage problem.

Fix by attaching the token in `getBuffer` via a module-level accessor set by the
auth provider, or by moving to a BFF with an httpOnly session cookie so
`credentials: 'same-origin'` handles it. Decide before writing the audio endpoint.

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

- PostgreSQL major version; `CREATE EXTENSION` / `CREATE SCHEMA` permitted?
- Which S3 implementation (MinIO, Ceph RGW, StorageGRID, ECS)? Bucket provisioned
  with credentials? Path-style required? Backup policy on the bucket?
- Keycloak: client provisioned, public client with PKCE allowed, redirect URI
  configurable? Is `email_verified` trustworthy in that realm?
- Do Keycloak account emails match the current Supabase accounts? This decides
  whether existing boards reconnect.
- Any objection to access tokens in browser memory? If so, BFF from the start.
- Internal CA certificate location, for PostgreSQL, S3 and Keycloak.
- Realistic user count, upload count, max clip size.

## Verify

`npm run build` and `npm run typecheck` after any app change, and
`npm run docs:check` if you touched the skills.

End to end, after the flip: sign in via Keycloak, first-login seeding produces 9
pads, upload a `.mov` (exercises ffmpeg, S3 write, and serve), play a built-in and
an uploaded pad, press the same pad twice and confirm the second press does not
refetch, reorder, change gain, sign out, then sign in as a second user and confirm
you cannot see or delete the first user's pads.

For an imported user specifically: confirm their pre-migration board appears. If it
does not, the identity mapping is wrong — check `app_users.oidc_sub` was attached to
the existing row rather than a new row being created.
