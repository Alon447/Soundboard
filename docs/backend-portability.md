# Moving Soundboard off Supabase

Target: a closed / air-gapped environment with no Supabase and no outbound internet.
What it *does* have: **PostgreSQL, S3-compatible object storage, Keycloak, and a vault
service**, plus the ability to run Node and Python processes.

It also already runs `../yanshuf3` on that stack, which is the single most useful fact
in this document — see [`yanshuf3-conventions.md`](./yanshuf3-conventions.md).

This document is the analysis: what breaks, which options were considered, and why. The
decisions it arrives at are written up as a concrete design in
[`target-architecture.md`](./target-architecture.md); read that if you want the answer
rather than the reasoning.

> This document has been revised twice as the environment became clearer. The first
> revision assumed PostgreSQL was the *only* thing available and recommended audio in a
> `bytea` column with hand-rolled password auth. The second added S3 and Keycloak. The
> third replaced SPA-side PKCE with a cookie BFF after finding that a sibling project
> already does it that way. Rejected options are kept deliberately — "why not `bytea`"
> and "why not just use PKCE in the SPA" are questions that will come up again.

## Short answer to "can the way we store sounds keep working?"

**No. Not as-is.** Two independent reasons, both fatal:

1. **Supabase Storage is not a Postgres feature.** It is a separate Node service
   that puts the actual bytes on S3 or a local disk and keeps only *metadata* rows
   in a `storage.objects` table. A plain PostgreSQL server has no `storage` schema,
   no `storage.buckets`, no `storage.foldername()`, and no way to hand bytes to a
   browser over HTTP. The audio has nowhere to live.
2. **`shared_sounds.file_url` holds an absolute signed URL** pointing at
   `<project-ref>.supabase.co`, signed with that project's JWT secret. In a closed
   network that host is unreachable, and even if it were, the signature could not
   be verified by anything you control. Every one of those rows is a dead link the
   moment you leave.

The same applies one level up: the browser cannot talk to PostgreSQL at all.
PostgreSQL speaks its own binary protocol over TCP, not HTTP, and browsers cannot
open raw TCP sockets. Today the architecture is *browser → managed HTTP services →
PG*. Removing Supabase leaves *browser → nothing → PG*.

**So the port is not "swap the database". It is "supply the HTTP layer Supabase was
providing": auth, data access, and file serving.**

## What has to be replaced

| Supabase piece | Used for | Replacement |
| --- | --- | --- |
| GoTrue (`auth.*`) | email/password signup, login, session, `auth.users` table | **Keycloak** via OIDC, plus a local `app_users` mirror table |
| PostgREST (`from(...)`) | 11 query shapes over 2 tables | own Node API (or self-hosted PostgREST) |
| Storage (`storage.*`) | upload + long-lived signed URL for audio bytes | **S3 bucket**, object key stored in PostgreSQL |
| RLS + `auth.uid()` | the *only* thing stopping cross-user reads/writes | ownership checks in the API layer (mandatory, see below) |

Keycloak and S3 between them remove the two hardest parts of the original plan:
writing auth from scratch, and finding somewhere for bytes to live. What remains is
the data API, which is the part that was always going to have to be written.

Only four source files talk to Supabase, which is the good news:
`src/lib/supabase.ts`, `src/lib/useAuth.tsx`, `src/components/AuthPage.tsx`,
`src/lib/useUserSounds.ts`, `src/lib/useSharedSounds.ts`. See
[`supabase-surface-inventory.md`](./supabase-surface-inventory.md) for the exact
call sites.

## Where do the audio bytes go?

This is the decision that shapes everything else.

### A. S3-compatible object storage — chosen

The environment has it, and it is what Supabase Storage was using underneath
anyway, so this is the closest thing to a like-for-like swap. Bytes in a bucket,
object key in PostgreSQL, database and object store each doing what they are good
at. The design is in [`target-architecture.md`](./target-architecture.md):
content-addressed keys, reads proxied through the API rather than presigned, S3
written before the database so failures leave a harmless orphan rather than a
broken pad.

The one thing it costs you that the rejected options did not: **S3 and PostgreSQL
cannot share a transaction.** You get eventual consistency between the two and need
a reconciliation job for orphaned objects. That is a well-understood problem with a
boring solution, and it is worth it to keep large binaries out of the database.

### B. `bytea` column in PostgreSQL — rejected, was the plan before S3 was known

Store the file in `sound_assets.data bytea`, serve from the API.

Genuinely attractive when PostgreSQL is the only durable store: one backup covers
data *and* media, no second system to provision, deleting a sound deletes its bytes
with no GC to write, and no cross-system consistency problem at all.

Rejected because it does not scale in the ways this app will eventually be asked to:
a `bytea` read materialises the whole value in server memory and again in the
driver's buffer, so concurrency degrades as file size × concurrent plays. TOAST
wastes cycles trying to compress already-compressed MP3 (`alter column data set
storage external` avoids that). Range requests need hand-written
`substring(data from $1 for $2)`. Practical ceiling around 10 MB per file.

Still the right answer if the S3 bucket turns out to be unavailable, or a
provisioning request nobody will approve. Keep it in mind as the fallback — the
schema difference is one table, and `GET /api/shared-sounds/:id/audio` does not
change.

### C. Filesystem + static serving — rejected

Best raw performance (`sendfile`, free range requests), but needs a persistent
volume that survives redeploys, and gives you two things to back up instead of one.
S3 provides the same benefits with better operational properties in this
environment, so there is no reason to prefer a local disk.

### D. PostgreSQL large objects (`lo`, `pg_largeobject`) — rejected

Real streaming and seeking via `lo_read` / `lo_seek`, up to 4 TB. But large objects
live outside the table, leak storage unless you `lo_unlink` explicitly (or install
the `lo` extension's trigger), must be read inside a transaction, and are clumsy
from `node-postgres`. All of the complexity of B with extra footguns.

### The schema change that matters regardless of which option wins

**Stop storing absolute URLs in the database.** That single decision is what makes
the byte-storage choice swappable later. Replace `file_url` / `custom_file_url`
with an asset reference and derive the URL on the client:

```ts
// src/lib/useUserSounds.ts — userSoundToBoard
audio_path: builtin?.audio_path ?? (row.shared_sound ? `/api/shared-sounds/${row.shared_sound.id}/audio` : '')
```

`assetPath()` already passes through anything starting with `/`, so this needs no
other change. Bonus: a same-origin URL sidesteps CORS entirely and satisfies
`Cross-Origin-Embedder-Policy: require-corp`, which cross-origin signed URLs only
happen to survive today.

This is what makes the byte-storage choice reversible. Whether the endpoint reads
from S3, a `bytea` column or a local disk is invisible to the client.

## Where does auth come from?

Keycloak, via a **server-side Authorization Code flow in a BFF that sets httpOnly
cookies**. No OIDC library in the browser, no token in JavaScript. The full design is
in [`target-architecture.md`](./target-architecture.md).

An earlier revision of this document recommended Authorization Code + PKCE with
`oidc-client-ts` in the SPA. That was superseded once `../yanshuf3` turned out to
already run exactly this flow against the same Keycloak — see
[`yanshuf3-conventions.md`](./yanshuf3-conventions.md). The BFF wins on three counts:
it is proven in this environment with a client already provisioned, it keeps tokens out
of browser memory, and it removes the need to thread an access token into
`getBuffer`'s bare `fetch(url)` — a trap that would otherwise have broken uploaded
sounds while leaving built-ins working.

Worth stating why this is the easy call even though the project does not care much
about auth: **not caring about auth is the strongest argument for delegating it.**
Hand-rolling means owning password hashing, session lifetime, rotation, lockout,
reset flows and their failure modes — with no SMTP server to send a reset email
through. Keycloak already runs in the environment and already solves all of it. The
replacement work drops to validating a JWT and mapping a `sub` onto a local user row.

The rejected alternative was a local `app_users` table with bcrypt hashes and an
`app_sessions` table. That plan is only worth revisiting if the Keycloak realm turns
out to be unavailable to this app.

**Auth being a low priority for this project is the argument for the BFF, not against
it.** There is no login UI to build and no auth code to own: `AuthPage.tsx` gets
deleted rather than rewritten, and because Keycloak fronts corporate SSO an existing
session round-trips back without the user seeing a form.

Two things Keycloak does **not** solve, and it is important not to assume otherwise:

- **Authorization.** Keycloak says who the user is. It has no idea which pads belong
  to them. Every ownership check stays the API's job.
- **The identity mapping.** The Keycloak claim identifying the user — `upn` in this
  realm — is not the Supabase user id already stored in `user_sounds.user_id`. Getting
  this wrong orphans every existing board.

"Use Keycloak only to identify the user, not to block the app" is a reasonable product
decision, and it changes nothing here. Not gating the app is a different thing from
letting one user delete another's board.

## Where does the HTTP layer come from?

### Option 1: a small Node API — chosen

Fastify + `pg` + `@aws-sdk/client-s3` + `jose`, one process. Full control over
ownership checks, upload limits and byte serving, and it deploys as the same
artefact as the frontend — serve the built SPA from it and everything is
same-origin, which removes CORS and satisfies COEP for free.

With Keycloak handling authentication and S3 handling bytes, this shrinks to what it
should always have been: a data API plus an S3 proxy. The "you have to write auth
carefully" objection that made this option risky no longer applies.

It does mean the repository needs a real package boundary between the SPA and the
API — see the workspace layout in
[`target-architecture.md`](./target-architecture.md).

See [`../.kiro/skills/supabase-to-postgres/references/api-contract.md`](../.kiro/skills/supabase-to-postgres/references/api-contract.md)
for the endpoint list and
[`target-schema.sql`](../.kiro/skills/supabase-to-postgres/references/target-schema.sql)
for the schema.

### Option 2: self-hosted PostgREST + a tiny auth service

PostgREST is a single static Go binary and works against any PostgreSQL. It
preserves the PostgREST query syntax the hooks already use — including the
embedded join `select=*,shared_sound:shared_sounds(*)` — and lets you keep RLS as
the enforcement mechanism, so both migrations survive nearly verbatim. You still
need to issue JWTs yourself and you still need a separate answer for the audio
bytes, so it is two services instead of one. Worth it only if you want to keep
policy in SQL.

Keycloak makes this more viable than it was — it can issue the JWTs PostgREST
expects, so the "tiny auth service" disappears. But you still need something to
proxy S3 for the audio endpoint, and at that point you are running a Node process
anyway and may as well have it do the queries too. Rejected on that basis rather
than on capability.

To make the existing policies work, redefine the helper Supabase provides:

```sql
create schema if not exists auth;
create or replace function auth.uid() returns uuid
  language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
```

### Option 3: self-host the whole Supabase stack

`docker compose` of postgres + gotrue + postgrest + storage-api + kong. Zero
application changes. But it expects to own its own PostgreSQL — it wants specific
roles (`supabase_admin`, `authenticator`, `anon`, `authenticated`,
`service_role`), the `auth`/`storage` schemas, extensions like `pgcrypto` and
`pgjwt`, and `wal_level=logical` for realtime. Pointing it at a locked-down
corporate PG where you are not superuser ranges from painful to impossible, and
you need to mirror half a dozen container images into the closed network. Only
consider this if the environment already runs containers and the PG is yours.

## Security: RLS is currently doing real work

**Keycloak does not cover this.** Authentication and authorization are different
problems, and it is an easy mistake to think a valid token means a request is
allowed.

Right now the client sends `user_id` in every insert and calls
`.delete().eq('id', dbId)` with **no** user filter. RLS is the only reason that is
safe. The moment you put a hand-written API in front of PG:

- **Derive the user from the session on the server. Never from the request body.**
  Ignore any `user_id` / `owner_id` the client sends.
- Scope every mutation: `delete from user_sounds where id = $1 and user_id = $2`.
- Keep RLS on as defence in depth if you go the PostgREST route or connect as a
  non-superuser role.

This is a correctness *and* security requirement, not a porting detail. It is the
easiest thing to get wrong in this migration.

## Non-obvious traps

1. **`numeric` becomes a string.** PostgREST returns `numeric` as a JSON number;
   `node-postgres` returns it as a **string** (`"1"`). `gain` would silently stop
   being a number, breaking arithmetic and slider comparisons. Fix in the schema
   (`double precision` — recommended) or register a type parser
   (`pg.types.setTypeParser(1700, parseFloat)`). `integer` is parsed to a number,
   so `position` is fine.
2. **ffmpeg.wasm fetches its core from `unpkg.com`** at runtime
   (`src/lib/ffmpegConvert.ts`). This is a hard failure in an air-gapped network
   and it has nothing to do with Supabase. `@ffmpeg/core-mt` is already a
   dependency — copy its `dist/esm` into `public/ffmpeg/` and point `baseURL` there.
3. **COOP/COEP headers only exist in dev.** They are injected by a Vite plugin for
   the dev and preview servers. A production nginx/IIS must send
   `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp`, or the multi-threaded ffmpeg core
   fails to load.
4. **Built-in filenames are hostile.** `public/sounds/` contains spaces, `!`, and
   curly quotes (`“Fahh” - meme sound effect …mp4`). Vite tolerates them; other
   static servers encode them differently. Rename to ASCII slugs and update
   `src/lib/sounds.ts` in the same commit.
5. **You must export the bytes before you lose network access.** The signed URLs in
   `file_url` are the only handle you have on the uploaded audio. Once the closed
   environment is cut over, they are gone. Run the export while Supabase is still
   reachable.
6. **The Keycloak identity claim is not the Supabase user id.** Using `upn` (or `sub`)
   directly as a foreign key orphans every existing board. The `app_users` mirror table
   and the resolve-by-`upn`-then-`email` sequence in
   [`target-architecture.md`](./target-architecture.md) exist entirely to prevent this.
   It is the single most destructive mistake available in this migration, and it fails
   silently — the user signs in and gets a freshly seeded empty board.
7. **Playback fetches audio with no auth header.** `getBuffer` in `App.tsx` calls bare
   `fetch(url)`. Under bearer-token auth, uploaded sounds would stop playing while
   built-ins kept working. The cookie BFF makes this a non-issue, which is part of why
   it was chosen — but do not reintroduce a bearer-only audio route.
8. **A presigned URL would break the audio cache.** `App.tsx` keys its decoded
   `AudioBuffer` cache on the URL string. Presigned URLs rotate, so the cache would
   never hit. Key the cache on the sound id if you ever move to presigning.
9. **The AWS SDK's default credential chain probes EC2 IMDS.** In a closed network
   that means a hang or a slow timeout on every S3 call. Pass credentials
   explicitly. See the `airgap-readiness` skill.
10. **S3 and PostgreSQL cannot share a transaction.** Write S3 first, then the
    database, so a failure leaves an orphaned object rather than a row pointing at
    nothing. Reconcile orphans on a schedule.
11. **`.env` has a committed anon key.** `VITE_SUPABASE_ANON_KEY` is in the repo.
    Rotate it and drop both vars when the migration lands.
12. **`gen_random_uuid()` needs PG 13+**, or `pgcrypto` on older versions. Confirm
    the target server version before assuming defaults work.
13. **TLS and internal CAs.** Node → PostgreSQL may need
    `ssl: { ca: readFileSync(...) }`; Node → S3 and Node → Keycloak may need
    `NODE_EXTRA_CA_CERTS`. Do not disable verification to get past this.

Supabase's bcrypt password hashes in `auth.users.encrypted_password` used to matter,
back when the plan was local passwords. With Keycloak they are irrelevant — export
`email` for the identity mapping and ignore the hashes.

14. **`npm ci` needs the Nexus mirror, and the lockfile fights it.** A Nexus-proxied
    registry serves tarballs whose integrity hashes do not match a lockfile generated
    against the public registry, so `npm ci` fails with an error that does not point at
    the mirror. yanshuf3 solves this with a `stripLockIntegrity` step run before
    `npm ci`, plus a `checkNexusPackages` script that reports every missing package at
    once. Reuse both rather than rediscovering the problem.
15. **Secrets belong in the vault service, not `.env`.** The environment already runs
    one, with a Redis mirror so vault being down does not take the app down. Env vars
    are for non-secret wiring only.

## Recommended plan

Phased so nothing is a big-bang cutover, and every phase is independently
verifiable with `npm run build && npm run typecheck`.

**Phase 0 — capture, while Supabase still works.**
Export `auth.users` (id, email, `raw_user_meta_data` — the password hashes are no
longer needed), `user_sounds` and `shared_sounds` to JSON. Then download every
`shared_sounds.file_url` and verify byte counts. Nothing here is recoverable later.

**Phase 1 — introduce a seam, no behaviour change.**
Add `src/lib/api.ts` exposing the operations the hooks need, implemented on top of
supabase-js and returning the existing `{ data, error }` shape. Move the
`UserSound` / `SharedSound` types out of `supabase.ts` into `src/lib/types.ts`.
Switch `userSoundToBoard` to derive `audio_path` from the shared-sound id rather
than reading `file_url`, and key the decoded-buffer cache in `App.tsx` on the sound
id instead of the URL. Ship and confirm on Supabase.

**Phase 1.5 — restructure the repository.**
Move to the `frontend/` + `backend/` + `packages/shared` workspace layout, matching
yanshuf3's naming. Its own commit, no behaviour change, and much easier to do after
Phase 1 has consolidated the data layer. Update every path pattern in the steering and
instruction files, and in `scripts/sync-agent-docs.mjs`, in the same commit.

**Phase 2 — stand up the new backend.**
New migration set with no `auth.` or `storage.` references, the Node API, the S3
client, and Keycloak token validation. Import the Phase 0 data, mapping users
through the `app_users` mirror. Test against the real closed-environment
PostgreSQL, S3 and Keycloak, not local substitutes — versions, path-style quirks,
privilege levels and realm configuration are what will bite.

**Phase 3 — flip the seam.**
Reimplement `src/lib/api.ts` over `fetch('/api/...')` with
`credentials: 'same-origin'`, replace `useAuth.tsx`'s Supabase session with a
`GET /api/me` call plus a redirect-to-BFF `login()`, **delete** `AuthPage.tsx`, then
remove `@supabase/supabase-js`, the `supabase` CLI dev dependency and the
`VITE_SUPABASE_*` vars. The two data hooks should barely change if Phase 1 was done
properly, and no OIDC client library gets added.

**Phase 4 — harden for the closed environment.**
Vendor the ffmpeg core, set COOP/COEP on the API's HTML response, rename the
built-in audio files to ASCII, add an explicit upload size limit on both client and
server, replace the position swap with a single transactional reorder, add a delete
path for uploads, and schedule the S3 reconciliation job. See the
`airgap-readiness` skill.

## Open questions to settle before Phase 2

Answered by the environment, so no longer open: something other than PostgreSQL can run
(so the Node API is viable), object storage exists (so `bytea` is the fallback rather
than the plan), an identity provider exists (so no local passwords), a vault service
exists (so no secrets in `.env`), and the npm mirror is Nexus (so `npm ci` works with
`stripLockIntegrity`).

Still open, and each one can change the design:

- **Is `auth-service` shared infrastructure or per-app?** If shared, Soundboard writes
  no auth code at all. If per-app, we stand up a copy or verify tokens in-process. This
  is now the top question.

- Is the PostgreSQL server shared or dedicated? Do you have `CREATE EXTENSION` and
  `CREATE SCHEMA`, or only a single owned schema? What major version?
- Which S3 implementation, and is a bucket already provisioned with credentials?
  Path-style requirements, presigning support and CORS configurability all differ
  between MinIO, Ceph RGW, StorageGRID and ECS.
- What is the backup and retention policy on that bucket? It now holds data the
  database cannot reconstruct.
- Keycloak: does a client exist for this app, can it be a public client with PKCE,
  and is the redirect URI configurable?
- Are Keycloak accounts provisioned for the intended users, and do their email
  addresses match the current Supabase accounts? This determines whether existing
  boards reconnect on first login.
- Is `email_verified` trustworthy in that realm?
- Does the environment object to access tokens held in browser memory? If so, go
  BFF from the start rather than retrofitting.
- Where is the internal CA certificate, for PostgreSQL, S3 and Keycloak connections?
- Expected number of users and uploads, and a realistic max clip size.
