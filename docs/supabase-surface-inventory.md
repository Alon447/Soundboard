# Supabase surface inventory

Every place the app depends on Supabase, as a port checklist. Verified by reading
the source; line numbers drift, the call shapes are what matter.

There are **no** realtime subscriptions, `.rpc()` calls, or edge functions.

## Auth — 5 calls

| Call site | Supabase API |
| --- | --- |
| `frontend/src/lib/useAuth.tsx` | `supabase.auth.getSession()` on mount |
| `frontend/src/lib/useAuth.tsx` | `supabase.auth.onAuthStateChange(cb)` + `subscription.unsubscribe()` |
| `frontend/src/lib/useAuth.tsx` | `supabase.auth.signOut()` |
| `frontend/src/components/AuthPage.tsx` | `supabase.auth.signInWithPassword({ email, password })` |
| `frontend/src/components/AuthPage.tsx` | `supabase.auth.signUp({ email, password })` |

`useAuth` exposes `{ user, session, loading, signOut }`. Session persistence and
token refresh are supabase-js defaults (localStorage + auto refresh); nothing
custom, so a replacement is free to use an httpOnly cookie instead.

Fields of `user` actually consumed:

- `user.id` (uuid) — query keys, and sent as `user_id` / `owner_id` in every insert
- `user.email` — header label in `App.tsx`, and `owner_name` fallback
- `user.user_metadata?.name` — first choice for `shared_sounds.owner_name`

`AuthPage` shows "Account created. Confirm your email, then sign in." when
`signUp` returns no session. Password rule is a client-side `minLength={6}`.
No magic link, OAuth, or password reset exists.

**All five calls are replaced by Keycloak**, not by hand-written equivalents and not by a
browser OIDC library. There is no signup or password endpoint to build; `/auth/login`,
`/auth/callback` and `/auth/logout` live in our own backend. `useAuth` reads
`GET /api/me` and its `login()` is a full-page navigation to `/auth/login`, so
**`AuthPage.tsx` is deleted rather than rewritten** — SSO means there is no form to show. The one thing the replacement must do that Supabase
did implicitly is map the Keycloak `upn` claim onto the existing Supabase user id; see
[`target-architecture.md`](./target-architecture.md).

## Database — 0 calls, done

`frontend/src/lib/useUserSounds.ts` goes through `frontend/src/lib/api.ts` now. What each
former call became:

| Purpose | Was | Now |
| --- | --- | --- |
| load board | `.from('user_sounds').select('*, shared_sound:shared_sounds(*)').eq('user_id', userId).order('position')` | `GET /api/user-sounds` |
| seed first login | `.from('user_sounds').insert(seededRows).select('*')` | `POST /api/user-sounds` with all 15 pads, sent by the client |
| add built-in | `.from('user_sounds').insert({ ... })` | `POST /api/user-sounds` with a one-element array |
| remove pad | `.from('user_sounds').delete().eq('id', dbId)` — no `user_id` filter | `DELETE /api/user-sounds/:id`, scoped server-side |
| move pad | two parallel `.update({ position })` — not transactional | `POST /api/user-sounds/reorder`, one statement |
| set gain | `.from('user_sounds').update({ gain }).eq('id', dbId)` | `PATCH /api/user-sounds/:id` |

The embedded join `shared_sound:shared_sounds(*)` is gone and the API does not implement it,
so **a pad still pointing at `shared_sound_id` has no audio.** Running `db/migrations/0002`
converts those pads to built-in `sound_id`s; until it runs, the six former uploads are silent.

Every call was wrapped in react-query, which is what made the swap cheap: the optimistic
remove / move / gain logic is untouched, only the mutation bodies changed. `api.ts` throws
rather than returning `{ data, error }`, because react-query converts a throw into `error`
state by itself.

Two behaviour changes came free with the routes: `moveSound` is now one transactional
reorder instead of two racing `UPDATE`s, and every mutation is scoped by `user_id`
server-side rather than relying on RLS.

**Also gone:** the two `shared_sounds` inserts, the add-from-library insert and the
community-library query. Uploads are parked and the community library was deleted — both
return in phase 6 against S3.

## Storage — 0 calls, done

Both calls are gone. They were:

| Purpose | Call |
| --- | --- |
| upload | `supabase.storage.from('sounds').upload('<user_id>/<Date.now()>.<ext>', file, { upsert: false })` |
| get URL | `supabase.storage.from('sounds').createSignedUrl(filePath, 60*60*24*365*10)` |

The signed URL was persisted verbatim into `shared_sounds.file_url`, which is what made the
old data unportable.

**How it was resolved:** the six existing uploads were downloaded and adopted as built-in
sounds (`custom-1` … `custom-6` in `frontend/src/lib/sounds.ts`), so nothing depends on Storage or on
`file_url` any more. `useUserSounds.addCustomSound` now throws, and the upload tab reports
that uploads are being migrated. `db/migrations/0002` converts the affected pads to
built-in `sound_id`s by matching the `Date.now()` stamp in `storage_path`.

Uploads return in phase 6 as `POST /api/shared-sounds` (multipart → `PutObject`, content
addressed) plus `GET /api/shared-sounds/:id/audio`, with no URL in the database. The
presentational upload UI — `UploadSoundPanel`, the pickers, `ConversionProgress` — was kept
for that; `CommunitySoundList` and `useSharedSounds.ts` were deleted because their types
change shape.

Bucket `sounds` is `public = false` with `file_size_limit = "50MiB"` in
`supabase/config.toml`. Nothing writes to it now, and the client still enforces no cap.

## Supabase-specific SQL in `supabase/migrations/`

| Construct | Where | Replacement |
| --- | --- | --- |
| `references auth.users(id)` | both tables | dropped; ownership columns become `text` holding the Keycloak `upn` |
| `auth.uid()` | 5 RLS policies | API-layer ownership checks from the validated token |
| `enable row level security` | both tables | keep only if connecting as a non-superuser role |
| `insert into storage.buckets` | 1st migration | drop; S3 bucket, key in `sound_assets` |
| `create policy on storage.objects` | 1st migration | drop |
| `storage.foldername(name)` | storage policy | drop |
| `auth.users.raw_user_meta_data` / `.email` | backfill CTE | drop; one-time historical statement |
| `gen_random_uuid()` | both PKs | core in PG 13+, else `pgcrypto` |
| `gain numeric` | both tables | prefer `double precision` (see driver note below) |

No GRANTs, no extensions, no triggers, no functions, and **no indexes beyond the
primary keys** — notably none on `user_sounds.user_id`.

## Client config

- `frontend/src/lib/supabase.ts` reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`,
  throwing if either is missing. Both live in `.env`, which is committed with a
  real anon key — rotate it.
- `frontend/src/vite-env.d.ts` has no typed `ImportMetaEnv`, so adding env vars needs no
  type changes.
- `frontend/vite.config.ts` has nothing Supabase-specific, but does set COOP/COEP for
  ffmpeg.wasm and excludes `@ffmpeg/*` from `optimizeDeps`.
- Dependencies to drop at the end: `@supabase/supabase-js`, and the `supabase` CLI dev
  dependency. On the web side only **`axios`** is added, for `frontend/src/lib/api.ts` —
  still no OIDC client library, because the cookie session removes the need for one. The
  backend has gained `pg`, `express`, `zod` and `@aws-sdk/client-s3`, with `jose` and
  `openid-client` still to come,
  which is the argument for the workspace split in
  [`target-architecture.md`](./target-architecture.md): server dependencies must not
  leak into the browser bundle.

## Driver behaviour change to watch

PostgREST returns `numeric` as a JSON number. `node-postgres` returns it as a
**string**. `gain` is `numeric`, so it becomes `"1"` and quietly breaks arithmetic
and comparisons. `db/migrations/0001_init.sql` uses `double precision` instead, which
avoids it; the alternative is `pg.types.setTypeParser(1700, parseFloat)`. `integer`
(`position`) is fine.

`bigint` has the same problem and is not yet handled: `sound_assets.byte_size` will come
back as a string, and the audio route sets `Content-Length` from it. Either coerce at the
call site or register `setTypeParser(20, Number)` when that route is built.

## Unrelated to Supabase but blocks a closed environment

- `frontend/src/lib/ffmpegConvert.ts` loads its wasm core from
  `https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm` at runtime.
- COOP/COEP headers exist only in the Vite dev/preview middleware.
- `index.html` references `https://bolt.new/static/og_default.png` for `og:image`
  (inert, but an external reference).
- ~~`YOUTUBE_SERVER` / `YouTubeSoundPanel.tsx`~~ — **deleted**, both of them.
- ~~`frontend/public/sounds/` filenames contain spaces, `!` and curly quotes~~ — **fixed.**
  All 15 files are slugs now (`vine-boom.mp4`, `custom-1.mp3`).
