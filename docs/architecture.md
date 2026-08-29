# Soundboard architecture

A single-page React soundboard. Users sign in, get a grid of pads, trigger them by
click or keyboard (`1`-`9`, `0`, `-`, `=`), upload their own clips, and browse a
shared community library of other users' uploads.

There is no guest mode. `App.tsx` renders `<AuthPage />` whenever `user` is null,
so **every** feature sits behind authentication.

## Stack

| Concern | Choice |
| --- | --- |
| Build | Vite 8, React 19, TypeScript |
| UI | HeroUI 3 + Tailwind 4, `lucide-react` icons |
| Server state | `@tanstack/react-query` v5 |
| Client state | `zustand` (UI flags + non-reactive audio refs) |
| Backend | Supabase (GoTrue auth, PostgREST, Storage) |
| Media conversion | `@ffmpeg/ffmpeg` (ffmpeg.wasm, multi-threaded core) |

Path alias: `@/` maps to `frontend/src/`. Use it instead of deep relative imports.

## Runtime shape

```
browser
 ├─ GoTrue      /auth/v1     email + password, session in localStorage
 ├─ PostgREST   /rest/v1     CRUD on user_sounds, shared_sounds
 ├─ Storage     /storage/v1  bucket "sounds", private, signed URLs
 └─ static      /sounds/*    built-in clips bundled in public/
```

Everything the browser touches is an HTTP service that Supabase provides. The
database is never spoken to directly.

## The three sound sources

A pad (`user_sounds` row) resolves its audio from exactly one of three places.
`userSoundToBoard` in `frontend/src/lib/useUserSounds.ts` collapses them into one field:

```ts
audio_path: builtin?.audio_path ?? row.shared_sound?.file_url ?? row.custom_file_url ?? ''
```

1. **Built-in** — `sound_id` matches an entry in `frontend/src/lib/sounds.ts` (`SOUNDS`).
   Audio is a static file in `frontend/public/sounds/*.mp4`, path is relative (`/sounds/...`).
   Nine of them. On first login they are bulk-inserted as the starter board.
2. **Shared** — `shared_sound_id` points at a `shared_sounds` row, whose
   `file_url` is a **10-year Supabase signed URL** to a Storage object.
   Every user upload becomes a shared sound, so this is the path all uploads take.
3. **Legacy `custom_file_url`** — a column no code writes anymore, still read as a
   fallback. Pre-`shared_sounds` uploads live here.

## Playback

`App.tsx` owns the audio engine. Per trigger:

1. `assetPath()` normalises the path (passes through `/`, `http://`, `https://`).
2. `getBuffer()` checks the zustand `audio.buffers` Map, else `fetch(url)` →
   `ctx.decodeAudioData(arrayBuffer)` and caches the `AudioBuffer` keyed by URL.
3. A per-sound `GainNode` (`sound.gain`) feeds the store's `masterGain`.
4. Re-triggering a pad stops its previous `AudioBufferSourceNode` first.

Implication worth remembering: playback needs a **fetchable, CORS/CORP-clean URL
that Web Audio can decode**. It does not care whether that URL is a static file,
a signed URL, or an API route. That is what makes the backend swappable.

There is also a `synth:` pseudo-path branch (`isSynth` → `playSynth`) that nothing
in the data model currently produces.

## Upload flow

`AddSoundModal` → `UploadSoundPanel`. If the file matches `VIDEO_EXTENSIONS`,
`extractAudioFromVideo()` runs ffmpeg.wasm **in the browser**
(`-vn -acodec libmp3lame -q:a 2`) and yields an `audio/mpeg` File. Audio files
upload untouched. Then `addCustomSound` does, in order:

1. `storage.from('sounds').upload('<user_id>/<epoch>.<ext>', file)`
2. `createSignedUrl(path, 10 years)`
3. insert `shared_sounds` (owner, name, `storage_path`, `file_url`, colour, icon)
4. insert `user_sounds` pointing at that shared row

ffmpeg.wasm needs `SharedArrayBuffer`, hence the COOP/COEP headers injected by the
`cross-origin-isolation` plugin in `frontend/vite.config.ts`. Those headers are set for the
dev and preview servers only — a production host must set them itself.

## Data layer

One hook, react-query, is the *only* thing that reads or writes the board:
`frontend/src/lib/useUserSounds.ts` — one query plus four mutations (add built-in, remove,
move, update gain), the last three optimistic with rollback. `addCustomSound` still exists
but throws: uploads are parked until the S3 route lands.

**It goes through our own API, not Supabase.** `frontend/src/lib/api.ts` is a thin `fetch`
wrapper over `/api/*` with `credentials: 'same-origin'`; `backend/src/routes/userSounds.ts`
serves it over `pg`. `api.ts` throws rather than returning `{ data, error }`, because
react-query already turns a throw into `error` state.

`frontend/src/lib/supabase.ts` is now the auth client and nothing else. The `UserSound` row
type lives in `useUserSounds.ts`, next to the mapper that consumes it.

**Two things to know during the transition.** The board is scoped by the backend's
`MOCK_USER_ID`, not by whoever is signed in through Supabase — `useAuth`'s `user.id` only
keys the react-query cache now. And a pad still pointing at `shared_sound_id` has no
`audio_path`, because the API serves no URL for one; `db/migrations/0002` is what converts
those pads. Both resolve as phases 5 and 2 complete.

No realtime subscriptions, no RPC, no edge functions.

## Files worth knowing

| Path | Role |
| --- | --- |
| `backend/src/utils/secrets.ts` | Vault KV v2 reads, local-file branch, TTL cache |
| `backend/src/utils/s3.ts` | Memoised S3 client, content-addressed keys, object operations |
| `backend/src/utils/pg.ts` | One memoised `pg.Pool`, startup probe, `closePool()` |
| `backend/src/config/index.ts` | Zod-validated env, exits at boot on anything missing |
| `backend/src/checkConnectivity.ts` | `npm run api:check` — four checks: secrets, PostgreSQL, S3 |
| `backend/src/index.ts` | Lifecycle only: startup probe, listen, graceful shutdown |
| `backend/src/app.ts` | Express assembly: JSON, `/api` router, 404, error handler |
| `backend/src/types/index.ts` | `AuthUser` and the only `Request` augmentation |
| `backend/src/middleware/requireUser.ts` | Identity; `MOCK_USER_ID` under `IS_BLACK_ENV` |
| `backend/src/middleware/errorHandler.ts` | `notFound` + the handler that hides driver text |
| `backend/src/routes/index.ts` | Mounts `/me` and `/user-sounds` behind `requireUser` |
| `backend/src/routes/userSounds.ts` | The five board routes, all scoped to the caller |
| `db/migrations/0001_init.sql` | Fresh-database schema: `sound_assets`, `shared_sounds`, `user_sounds` |
| `db/migrations/0002_*.sql` | In-place migration of the live Supabase `user_sounds` |
| `docker-compose.yaml` | MinIO only; the dev database is Supabase, reached over `pg` |

| `frontend/src/App.tsx` | Layout, keybindings, audio engine, auth guard |
| `frontend/src/lib/useUserSounds.ts` | Every board read/write, over `/api`; audio path resolution |
| `frontend/src/lib/api.ts` | axios instance for `/api/*`; one interceptor normalises errors |
| `frontend/src/lib/supabase.ts` | Auth client only, until Keycloak lands |
| `frontend/src/lib/useAuth.tsx` | Session context (`getSession`, `onAuthStateChange`, `signOut`) |
| `frontend/src/components/AuthPage.tsx` | Only auth UI; email + password |
| `frontend/src/lib/sounds.ts` | `SOUNDS` — the 15 built-ins. The only copy; the API has none |
| `frontend/src/lib/ffmpegConvert.ts` | Browser-side video → MP3 |
| `frontend/src/store/soundStore.ts` | UI flags + `AudioContext`/buffer cache |
| `supabase/migrations/*.sql` | Schema, RLS, storage bucket |

## Known rough edges

Still live:

- `index.html` still has bolt.new `og:image` URLs and the title
  "Python Soundboard Application".

Fixed outright:

- ~~`moveSound` issues two independent `UPDATE`s~~ — `POST /api/user-sounds/reorder` is one
  `unnest ... with ordinality` statement in a transaction.
- ~~`removeSound` has no `user_id` filter and relies on RLS~~ — every route scopes by the
  caller's id server-side.
- ~~`position` comes from the client's `sounds.length`~~ — assigned as `max(position) + 1`.

- ~~`user_sounds.user_id` has no index~~ — `0002` adds `(user_id, position)`.
- ~~`shared_sound_id` is `on delete set null`, which violates `sound_source_check`~~ —
  `0002` rewrites the constraint to exactly-one-of and drops `custom_file_url`.
- ~~`YouTubeSoundPanel.tsx` + `YOUTUBE_SERVER` are dead code~~ — both deleted.
- ~~Sound filenames contain spaces, `!` and curly quotes~~ — all 15 are slugs.

Deferred with the parked upload path: no client-side size check, and nothing reclaims
Storage objects or `shared_sounds` rows. Both are phase-6 work, and neither can grow now
that `addCustomSound` throws.

## Related reading

- [`target-architecture.md`](./target-architecture.md) — the stack this moves to:
  PostgreSQL, S3, Keycloak and Vault behind a single Node backend, plus the planned
  workspace layout.
- [`house-conventions.md`](./house-conventions.md) — the two sibling projects already
  running on that stack: what to copy, what not to, and what they do not answer.
- [`backend-portability.md`](./backend-portability.md) — why Supabase does not port,
  and which alternatives were rejected.
- [`supabase-surface-inventory.md`](./supabase-surface-inventory.md) — the
  call-site-by-call-site port checklist.

## Repository layout

An npm workspace: `frontend/` (`@soundboard/frontend`, this SPA) and `backend/`
(`@soundboard/backend`, Vault + S3 so far). The root `package.json` is workspace
orchestration only, and all scripts run from there. Paths in this document are relative to
the repository root, so app code lives under `frontend/src/`. See
[`target-architecture.md`](./target-architecture.md) for the full tree.

## Agent configuration

These `docs/` files are the single source of truth. The agent configs point at them
rather than restating the detail, so guidance does not drift.

| Location | Consumed by |
| --- | --- |
| `.kiro/skills/{supabase-to-postgres,airgap-readiness,docs-sync}/` | Kiro (Agent Skills) |
| `.kiro/steering/project-context.md` | Kiro, always loaded |
| `.kiro/steering/backend-portability.md` | Kiro, loaded when editing `frontend/src/lib/**`, `supabase/**` |
| `.kiro/hooks/*.json` | Kiro, on session events |
| `.github/copilot-instructions.md` | Copilot, repo-wide |
| `.github/instructions/*.instructions.md` | Copilot, path-scoped via `applyTo` |

**Documentation is updated in the same change as the code, not afterwards.** The
`docs-sync` skill holds the contract and the concern-to-file map, and a `Stop` hook
(`docs-sync-reminder.json`) prompts for it.

Claude Code support was removed: `CLAUDE.md`, `.claude/skills/`, the mirror script and its
`--check` are all gone. The two remaining instruction sets, `.kiro/` and `.github/`, are
hand-maintained and **nothing verifies they agree**.
