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

Path alias: `@/` maps to `src/`. Use it instead of deep relative imports.

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
`userSoundToBoard` in `src/lib/useUserSounds.ts` collapses them into one field:

```ts
audio_path: builtin?.audio_path ?? row.shared_sound?.file_url ?? row.custom_file_url ?? ''
```

1. **Built-in** — `sound_id` matches an entry in `src/lib/sounds.ts` (`SOUNDS`).
   Audio is a static file in `public/sounds/*.mp4`, path is relative (`/sounds/...`).
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
`cross-origin-isolation` plugin in `vite.config.ts`. Those headers are set for the
dev and preview servers only — a production host must set them itself.

## Data layer

Two hooks, both react-query, are the *only* things that talk to the database:

- `src/lib/useUserSounds.ts` — the board. One query plus six mutations
  (add built-in, add custom, add shared, remove, move, update gain). Remove, move
  and gain are optimistic.
- `src/lib/useSharedSounds.ts` — the community library. One query.

`src/lib/supabase.ts` holds the client plus the only TypeScript mirror of the
schema (`UserSound`, `SharedSound`). Those two types are the contract any
replacement backend has to satisfy.

No realtime subscriptions, no RPC, no edge functions.

## Files worth knowing

| Path | Role |
| --- | --- |
| `src/App.tsx` | Layout, keybindings, audio engine, auth guard |
| `src/lib/useUserSounds.ts` | Every board read/write; audio path resolution |
| `src/lib/useSharedSounds.ts` | Community library query |
| `src/lib/supabase.ts` | Client + schema types |
| `src/lib/useAuth.tsx` | Session context (`getSession`, `onAuthStateChange`, `signOut`) |
| `src/components/AuthPage.tsx` | Only auth UI; email + password |
| `src/lib/sounds.ts` | Built-in pad declarations |
| `src/lib/ffmpegConvert.ts` | Browser-side video → MP3 |
| `src/store/soundStore.ts` | UI flags + `AudioContext`/buffer cache |
| `supabase/migrations/*.sql` | Schema, RLS, storage bucket |

## Known rough edges

- Removing a pad deletes only the `user_sounds` row. The `shared_sounds` row and
  the Storage object are never deleted, so uploads accumulate forever. There is
  no delete path for an upload anywhere in the client.
- `moveSound` issues two independent `UPDATE`s via `Promise.all`, not one
  transaction. A partial failure leaves duplicate `position` values.
- `removeSound` runs `.delete().eq('id', dbId)` with no `user_id` filter. Only RLS
  stops one user deleting another's pad.
- No client-side upload size check. The only limit is Storage's 50 MiB.
- `user_sounds.user_id` has no index, though every read filters on it.
- `shared_sound_id` is `on delete set null` while `sound_source_check` requires one
  of the three sources to be non-null — so deleting a `shared_sounds` row that a
  pad references will fail the check constraint. Latent, because nothing deletes.
- `YouTubeSoundPanel.tsx` + `YOUTUBE_SERVER` are dead code; `AddSoundModal` only
  renders the `builtin`, `upload` and `community` tabs. No `server` npm script exists.
- `index.html` still has bolt.new `og:image` URLs and the title
  "Python Soundboard Application".

## Related reading

- [`target-architecture.md`](./target-architecture.md) — the stack this moves to:
  PostgreSQL, S3, a Keycloak cookie BFF and a Node API, plus the planned workspace
  layout.
- [`yanshuf3-conventions.md`](./yanshuf3-conventions.md) — the sibling project already
  running on that stack: what to copy, what not to, and what it does not answer.
- [`backend-portability.md`](./backend-portability.md) — why Supabase does not port,
  and which alternatives were rejected.
- [`supabase-surface-inventory.md`](./supabase-surface-inventory.md) — the
  call-site-by-call-site port checklist.

## Agent configuration

These `docs/` files are the single source of truth. The agent configs point at them
rather than restating the detail, so guidance does not drift.

| Location | Consumed by |
| --- | --- |
| `.kiro/skills/{supabase-to-postgres,airgap-readiness,docs-sync}/` | Kiro (Agent Skills) |
| `.kiro/steering/project-context.md` | Kiro, always loaded |
| `.kiro/steering/backend-portability.md` | Kiro, loaded when editing `src/lib/**`, `supabase/**` |
| `.kiro/hooks/*.json` | Kiro, on session events |
| `.claude/skills/**` | Claude Code — byte-identical mirror of `.kiro/skills/` |
| `CLAUDE.md` | Claude Code, always loaded |
| `.github/copilot-instructions.md` | Copilot, repo-wide |
| `.github/instructions/*.instructions.md` | Copilot, path-scoped via `applyTo` |

**Documentation is updated in the same change as the code, not afterwards.** The
`docs-sync` skill holds the contract and the concern-to-file map. Two `Stop` hooks
enforce it: `sync-agent-docs.json` runs the mirror script, and
`docs-sync-reminder.json` prompts a check of the prose docs.

`.kiro/skills/` is the source of truth for skills; `.claude/skills/` is generated.
Never hand-edit the latter.

```powershell
npm run docs:sync    # copy .kiro/skills -> .claude/skills
npm run docs:check   # verify, exit 1 on drift
```
