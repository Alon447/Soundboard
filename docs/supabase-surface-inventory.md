# Supabase surface inventory

Every place the app depends on Supabase, as a port checklist. Verified by reading
the source; line numbers drift, the call shapes are what matter.

There are **no** realtime subscriptions, `.rpc()` calls, or edge functions.

## Auth — 0 calls, done

All five are gone, along with `@supabase/supabase-js` and the `supabase` CLI. What they were:

| Was, at        | Supabase API                            | Now                                     |
| -------------- | --------------------------------------- | --------------------------------------- |
| `useAuth.tsx`  | `supabase.auth.getSession()` on mount   | `useQuery` on `GET /api/me`             |
| `useAuth.tsx`  | `supabase.auth.onAuthStateChange(cb)`   | nothing — react-query owns the cache    |
| `useAuth.tsx`  | `supabase.auth.signOut()`               | **dropped** — no sign-out, see below    |
| `AuthPage.tsx` | `supabase.auth.signInWithPassword(...)` | **deleted** — Keycloak owns credentials |
| `AuthPage.tsx` | `supabase.auth.signUp(...)`             | **deleted** — no signup to build        |

`useAuth` now exposes `{ user, loading }`. `session` was dropped because nothing read it, and
`signOut` because there is nothing to sign out of: users arrive already authenticated to the
organisation account. `AuthPage.tsx` was replaced by `SignInPrompt.tsx`: no form, one button,
so a failing `/api/me` cannot produce a redirect loop.

**The Keycloak flow is built** — `/auth/login|callback` plus per-request ID token
verification in `requireUser`. Under `IS_BLACK_ENV` it is bypassed for `MOCK_USER_ID`, which
is how it gets developed with no Keycloak reachable. With `IS_BLACK_ENV=false` the config
demands `OIDC_ISSUER_URL` and `OIDC_REDIRECT_URI`, and the client credentials come from Vault
at `idp/keycloak/soundboard`. **Untested against a real realm** — there is none to reach.

Fields of `user` actually consumed:

- `user.id` (uuid) — query keys, and sent as `user_id` / `owner_id` in every insert
- `user.email` — header label in `App.tsx`, and `owner_name` fallback
- `user.user_metadata?.name` — first choice for `shared_sounds.owner_name`

The old form showed "Account created. Confirm your email, then sign in." when `signUp`
returned no session, and enforced a client-side `minLength={6}`. There was no magic link,
OAuth or password reset — which is why replacing it with SSO cost nothing.

The one thing the replacement must still do that Supabase did implicitly is map the Keycloak
`upn` claim onto the existing user id; see
[`target-architecture.md`](./target-architecture.md).

## Database — 0 calls, done

`frontend/src/lib/useUserSounds.ts` goes through `frontend/src/lib/api.ts` now. What each
former call became:

| Purpose          | Was                                                                                                       | Now                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| load board       | `.from('user_sounds').select('*, shared_sound:shared_sounds(*)').eq('user_id', userId).order('position')` | `GET /api/user-sounds`                                       |
| seed first login | `.from('user_sounds').insert(seededRows).select('*')`                                                     | `POST /api/user-sounds` with all 15 pads, sent by the client |
| add built-in     | `.from('user_sounds').insert({ ... })`                                                                    | `POST /api/user-sounds` with a one-element array             |
| remove pad       | `.from('user_sounds').delete().eq('id', dbId)` — no `user_id` filter                                      | `DELETE /api/user-sounds/:id`, scoped server-side            |
| move pad         | two parallel `.update({ position })` — not transactional                                                  | `POST /api/user-sounds/reorder`, one statement               |
| set gain         | `.from('user_sounds').update({ gain }).eq('id', dbId)`                                                    | `PATCH /api/user-sounds/:id`                                 |

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

| Purpose | Call                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------- |
| upload  | `supabase.storage.from('sounds').upload('<user_id>/<Date.now()>.<ext>', file, { upsert: false })` |
| get URL | `supabase.storage.from('sounds').createSignedUrl(filePath, 60*60*24*365*10)`                      |

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

| Construct                                  | Where          | Replacement                                                         |
| ------------------------------------------ | -------------- | ------------------------------------------------------------------- |
| `references auth.users(id)`                | both tables    | dropped; ownership columns become `text` holding the Keycloak `upn` |
| `auth.uid()`                               | 5 RLS policies | API-layer ownership checks from the validated token                 |
| `enable row level security`                | both tables    | keep only if connecting as a non-superuser role                     |
| `insert into storage.buckets`              | 1st migration  | drop; S3 bucket, key in `sound_assets`                              |
| `create policy on storage.objects`         | 1st migration  | drop                                                                |
| `storage.foldername(name)`                 | storage policy | drop                                                                |
| `auth.users.raw_user_meta_data` / `.email` | backfill CTE   | drop; one-time historical statement                                 |
| `gen_random_uuid()`                        | both PKs       | core in PG 13+, else `pgcrypto`                                     |
| `gain numeric`                             | both tables    | prefer `double precision` (see driver note below)                   |

No GRANTs, no extensions, no triggers, no functions, and **no indexes beyond the
primary keys** — notably none on `user_sounds.user_id`.

## Client config

- ~~`frontend/src/lib/supabase.ts`~~ — **deleted.** `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY` are still sitting in `frontend/.env`, now read by nothing. The
  file is gitignored, but the key was committed earlier in this repo's history, so **rotate
  it** regardless of the dead variables.
- `frontend/src/vite-env.d.ts` has no typed `ImportMetaEnv`, so adding env vars needs no
  type changes.
- `frontend/vite.config.ts` has nothing Supabase-specific, but does set COOP/COEP for
  ffmpeg.wasm and excludes `@ffmpeg/*` from `optimizeDeps`.
- ~~Dependencies to drop at the end: `@supabase/supabase-js`, the `supabase` CLI~~ —
  **both uninstalled.** The frontend bundle dropped from 1,181 kB to 1,004 kB.
  On the web side only **`axios`** was added, for `frontend/src/lib/api.ts` —
  still no OIDC client library in the browser, because the cookie session removes the need.
  The backend has gained `pg`, `express`, `jose`, `zod` and `@aws-sdk/client-s3` — and
  deliberately **not** `openid-client`,
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
