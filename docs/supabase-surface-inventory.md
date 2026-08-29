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

## Database — 11 calls, 2 tables

All in `frontend/src/lib/useUserSounds.ts` unless noted.

| Purpose | Call |
| --- | --- |
| load board | `.from('user_sounds').select('*, shared_sound:shared_sounds(*)').eq('user_id', userId).order('position', { ascending: true })` |
| seed first login | `.from('user_sounds').insert(seededRows).select('*')` — all 9 `SOUNDS`, `position = index` |
| add built-in | `.from('user_sounds').insert({ user_id, sound_id, name, color, icon, gain, position })` |
| create shared asset | `.from('shared_sounds').insert({ owner_id, owner_name, name, storage_path, file_url, color, icon, gain: 1 }).select('id').single()` |
| add upload pad | `.from('user_sounds').insert({ user_id, sound_id: null, shared_sound_id, name, color, icon, gain: 1, position })` |
| add from library | `.from('user_sounds').insert({ user_id, sound_id: null, shared_sound_id, name, color, icon, gain, position })` |
| remove pad | `.from('user_sounds').delete().eq('id', dbId)` — **no `user_id` filter** |
| move pad | two parallel `.from('user_sounds').update({ position }).eq('id', ...)` — **not transactional** |
| set gain | `.from('user_sounds').update({ gain }).eq('id', dbId)` |
| community library (`useSharedSounds.ts`) | `.from('shared_sounds').select('*').eq('is_public', true).order('created_at', { ascending: false })` — no pagination |

The embedded join `shared_sound:shared_sounds(*)` is the one PostgREST-specific
feature. In plain SQL it is a `left join shared_sounds` whose columns must be
re-nested into a `shared_sound` object, because `userSoundToBoard` reads
`row.shared_sound?.file_url`.

Every call is wrapped in react-query. Remove / move / gain are optimistic with
rollback. Only the `{ data, error }` return shape leaks into the hooks, so a
`fetch`-based client with the same shape is a drop-in replacement.

## Storage — 2 calls

| Purpose | Call |
| --- | --- |
| upload | `supabase.storage.from('sounds').upload('<user_id>/<Date.now()>.<ext>', file, { upsert: false })` |
| get URL | `supabase.storage.from('sounds').createSignedUrl(filePath, 60*60*24*365*10)` |

The resulting signed URL string is persisted verbatim into
`shared_sounds.file_url`; `storage_path` keeps the object key. The migration
comment states the reason: signed URLs are readable cross-user regardless of RLS,
which is how the community library works at all.

**Replaced by an S3 bucket plus `GET /api/shared-sounds/:id/audio`.** The closest
thing to a like-for-like swap, since Supabase Storage is itself S3-backed — but with
content-addressed keys and no URL stored in the database. The two calls above become
a `PutObject` and nothing, because the URL is derived on the client from the row id.

No `remove()`, `download()`, `getPublicUrl()` or `list()` anywhere. **There is no
delete path for an upload**, so nothing to port — but also nothing reclaiming space.

Bucket `sounds` is created `public = false`. Size cap is
`file_size_limit = "50MiB"` in `supabase/config.toml`; the client enforces nothing.

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
  dependency. **Nothing is added on the web side** — the cookie session means no OIDC
  client library in the browser. The backend gains `pg`, `@aws-sdk/client-s3`, `jose`,
  `openid-client`, `zod` and an HTTP framework,
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
- `frontend/src/components/add-sound/constants.ts` has `YOUTUBE_SERVER =
  'http://localhost:3001'`, used only by the unreferenced `YouTubeSoundPanel.tsx`.
- `frontend/public/sounds/` filenames contain spaces, `!` and curly quotes.
