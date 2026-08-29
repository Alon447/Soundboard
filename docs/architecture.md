# Soundboard architecture

A single-page React soundboard. Users sign in, get a grid of pads and trigger them by
click or keyboard (`1`-`9`, `0`, `-`, `=`). Uploading clips and browsing a shared community
library are **parked** mid-migration and return once audio moves to S3.

There is no guest mode. `App.tsx` renders `<SignInPrompt />` whenever `user` is null, so
every feature sits behind a session — but see the caveat below: that session is currently a
mock.

## Stack

| Concern          | Choice                                                                    |
| ---------------- | ------------------------------------------------------------------------- |
| Build            | Vite 8, React 19, TypeScript                                              |
| UI               | HeroUI 3 + Tailwind 4, `lucide-react` icons                               |
| Server state     | `@tanstack/react-query` v5                                                |
| Client state     | `zustand` (UI flags + non-reactive audio refs)                            |
| HTTP client      | `axios`, one instance in `frontend/src/lib/api.ts`                        |
| Backend          | our own Express 5 API over PostgreSQL (`backend/`)                        |
| Auth             | Keycloak code flow in the backend (`jose`), bypassed under `IS_BLACK_ENV` |
| Media conversion | `@ffmpeg/ffmpeg` (ffmpeg.wasm, multi-threaded core)                       |

Path alias: `@/` maps to `frontend/src/`. Use it instead of deep relative imports.

## Runtime shape

```
browser
 ├─ /api/me             current user, or 401
 ├─ /api/user-sounds    the board: list, add, patch, reorder, delete
 ├─ /auth/*             login, callback — the Keycloak code flow
 └─ /sounds/*           built-in clips, static from public/
                             │
        backend (Express 5)  ├─ pg    ──> PostgreSQL
                             ├─ jose  ──> Keycloak  (discovery + JWKS)
                             └─ S3, Vault  (wired, no route uses S3 yet)
```

**Supabase is gone.** Every browser call is either our own API or a static asset. `axios` is
configured with `withCredentials`, so an httpOnly session cookie will be sent automatically
once one exists.

## The three sound sources

A pad (`user_sounds` row) resolves its audio from exactly one of three places.
`userSoundToBoard` in `frontend/src/lib/useUserSounds.ts` collapses them into one field:

```ts
audio_path: builtin?.audio_path ?? row.shared_sound?.file_url ?? row.custom_file_url ?? '';
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

One hook, react-query, is the _only_ thing that reads or writes the board:
`frontend/src/lib/useUserSounds.ts` — one query plus four mutations (add built-in, remove,
move, update gain), the last three optimistic with rollback. `addCustomSound` still exists
but throws: uploads are parked until the S3 route lands.

**It goes through our own API, not Supabase.** `frontend/src/lib/api.ts` is a thin `fetch`
wrapper over `/api/*` with `credentials: 'same-origin'`; `backend/src/routes/userSounds.ts`
serves it over `pg`. `api.ts` throws rather than returning `{ data, error }`, because
react-query already turns a throw into `error` state.

The `UserSound` row type lives in `useUserSounds.ts`, next to the mapper that consumes it.

`useAuth` is also react-query now: a `useQuery` on `GET /api/me` with `retry: false`, since a
401 is an answer rather than a failure worth retrying. It exposes `{ user, loading }` and
nothing else. **There is no sign-out**: users reach the app already signed in to the
organisation account, so an end-session endpoint would only be a way to lock them out of a
board they are entitled to. The session ends when the ID token expires.

**Two things to know during the transition.** With `IS_BLACK_ENV=true` — the only way it has
been run so far — identity is `MOCK_USER_ID` end to end: what `/api/me` returns, what
`useAuth.user.id` holds, and what scopes every board query. So development has no real
authentication; the Keycloak path exists but has never met a realm. And a pad still pointing
at `shared_sound_id` has no `audio_path`, because the API serves no URL for one;
`db/migrations/0002` converts those pads and has not been run.

No realtime subscriptions, no RPC, no edge functions.

## Files worth knowing

| Path                                     | Role                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `backend/src/utils/secrets.ts`           | Vault KV v2 reads, local-file branch, TTL cache                       |
| `backend/src/utils/s3.ts`                | Memoised S3 client, content-addressed keys, object operations         |
| `backend/src/utils/pg.ts`                | One memoised `pg.Pool`, startup probe, `closePool()`                  |
| `backend/src/config/index.ts`            | Zod-validated env, exits at boot on anything missing                  |
| `backend/src/checkConnectivity.ts`       | `npm run api:check` — four checks: secrets, PostgreSQL, S3            |
| `backend/src/index.ts`                   | Lifecycle only: startup probe, listen, graceful shutdown              |
| `backend/src/app.ts`                     | Express assembly: JSON, `/api` router, 404, error handler             |
| `backend/src/types/index.ts`             | `AuthUser` and the only `Request` augmentation                        |
| `backend/src/middleware/requireUser.ts`  | Identity; `MOCK_USER_ID` under `IS_BLACK_ENV`                         |
| `backend/src/middleware/errorHandler.ts` | `notFound` + the handler that hides driver text                       |
| `backend/src/routes/index.ts`            | Mounts `/me` and `/user-sounds` behind `requireUser`                  |
| `backend/src/routes/userSounds.ts`       | The five board routes, all scoped to the caller                       |
| `db/migrations/0001_init.sql`            | Fresh-database schema: `sound_assets`, `shared_sounds`, `user_sounds` |
| `db/migrations/0002_*.sql`               | In-place migration of the live Supabase `user_sounds`                 |
| `docker-compose.yaml`                    | MinIO only; the dev database is Supabase, reached over `pg`           |

| `frontend/src/App.tsx` | Layout, keybindings, audio engine, auth guard |
| `frontend/src/lib/useUserSounds.ts` | Every board read/write, over `/api`; audio path resolution |
| `frontend/src/lib/api.ts` | axios instance for `/api/*`; one interceptor normalises errors |
| `frontend/src/lib/useAuth.tsx` | Session context; `useQuery` on `/api/me` |
| `frontend/src/components/SignInPrompt.tsx` | No form — one button to `/auth/login` |
| `backend/src/routes/auth.ts` | The Keycloak code flow: `state`, `nonce`, PKCE S256 |
| `backend/src/utils/oidc.ts` | Lazy discovery, JWKS, token exchange, ID token verification |
| `backend/src/utils/session.ts` | Cookie read/write; session expires with the token |
| `frontend/src/lib/sounds.ts` | `SOUNDS` — the 15 built-ins. The only copy; the API has none |
| `frontend/src/lib/ffmpegConvert.ts` | Browser-side video → MP3 |
| `frontend/src/store/soundStore.ts` | UI flags + `AudioContext`/buffer cache |
| `supabase/migrations/*.sql` | Schema, RLS, storage bucket |

## Known rough edges

Fixed outright:

- ~~`index.html` has bolt.new `og:image` URLs and the title "Python Soundboard
  Application"~~ — both gone; the title is "Soundboard" and there are no external
  references left in the bundle.
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

| Location                                                          | Consumed by                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| `.kiro/skills/{supabase-to-postgres,airgap-readiness,docs-sync}/` | Kiro (Agent Skills)                                            |
| `.kiro/steering/project-context.md`                               | Kiro, always loaded                                            |
| `.kiro/steering/backend-portability.md`                           | Kiro, loaded when editing `frontend/src/lib/**`, `supabase/**` |
| `.kiro/hooks/*.json`                                              | Kiro, on session events                                        |
| `.github/copilot-instructions.md`                                 | Copilot, repo-wide                                             |
| `.github/instructions/*.instructions.md`                          | Copilot, path-scoped via `applyTo`                             |

**Documentation is updated in the same change as the code, not afterwards.** The
`docs-sync` skill holds the contract and the concern-to-file map, and a `Stop` hook
(`docs-sync-reminder.json`) prompts for it.

Claude Code support was removed: `CLAUDE.md`, `.claude/skills/`, the mirror script and its
`--check` are all gone. The two remaining instruction sets, `.kiro/` and `.github/`, are
hand-maintained and **nothing verifies they agree**.
