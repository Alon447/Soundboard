# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A React 19 + Vite 8 soundboard. Users sign in, get a grid of pads, trigger them by
click or keyboard (`1`-`9`, `0`, `-`, `=`), upload their own clips, and browse a
shared library of other users' uploads. There is no guest mode — `App.tsx` renders
`<AuthPage />` whenever `user` is null.

Stack: HeroUI 3 + Tailwind 4, `lucide-react` icons, `@tanstack/react-query` for
server state, `zustand` for UI state and audio refs, `@ffmpeg/ffmpeg` (ffmpeg.wasm)
for in-browser video → MP3 conversion. Backend is currently Supabase
(GoTrue auth, PostgREST, Storage), and is being migrated — see below.

## Commands

```bash
npm run dev         # vite dev server
npm run build       # production build
npm run typecheck   # tsc --noEmit -p tsconfig.app.json
npm run lint        # eslint
npm run docs:sync   # mirror .kiro/skills -> .claude/skills
npm run docs:check  # verify that mirror, exit 1 on drift
```

Run `npm run build` and `npm run typecheck` after any app change. Do not start
`npm run dev` yourself — it never exits; ask the user to run it.

## Documentation is part of the change, not a follow-up

**Any change to architecture, the data or auth layer, schema, storage, dependencies,
folder structure, build scripts or deployment config must update the documentation in
the same turn.** The `docs-sync` skill holds the concern-to-file map — read it rather
than guessing which files need touching. Run `npm run docs:check` before finishing.

`.kiro/skills/` is the source of truth for skills. `.claude/skills/` is generated
from it; never hand-edit it. Kiro, Claude Code and Copilot must not disagree — a rule
that applies to the project applies in all three, so update
`.kiro/steering/`, this file and `.github/` together.

When a decision is superseded, rewrite the rule rather than appending a contradiction
next to it.

## Conventions

- Import via the `@/` alias (`@/lib/useAuth`), never deep relative paths.
- One React component per file. Shared constants, helpers and types may sit
  alongside in non-component files.
- Prefer HeroUI for inputs, tabs, buttons and sliders, and match the installed
  HeroUI 3 API exactly rather than mixing in patterns from other libraries. For
  overlays, a custom modal shell is acceptable where the HeroUI primitive fights
  the flow.
- Theme values (colours, surfaces, borders, form controls) belong in
  `src/index.css` as shared variables, not scattered through components.
- Built-in pads are declared in `src/lib/sounds.ts`; bundled audio lives in
  `public/sounds/`, pad images in `public/images/`.
- Keep mp3 and mp4 support working when touching playback.
- Auth today is Supabase email + password; the target is Keycloak OIDC. Do not add
  any *other* auth flow (magic link, OTP, social login) — the direction is to delete
  auth code, not add it.
- Schema changes go in `supabase/migrations/` while still on Supabase, applied with
  `npx supabase db push`. New schema for the target stack goes in `db/migrations/`.
- Keep changes minimal and scoped to what was asked.

## The migration that shapes all backend work

The target is a closed environment providing **PostgreSQL, S3-compatible object
storage and Keycloak**, with no outbound internet, plus a Node API to tie them
together. This is a live requirement.

Supabase Storage is not a Postgres feature, and browsers cannot speak the PostgreSQL
wire protocol. Porting means rebuilding the HTTP layer Supabase provided, not
swapping a database. If asked whether the app can just point at the closed-environment
PostgreSQL, the answer is no — explain why before proposing anything.

Five rules, in rough order of how expensive they are to get wrong:

1. **Never use Keycloak's `sub` as a foreign key.** It differs from the Supabase user
   id already in `user_sounds.user_id`. Ownership references `app_users.id`, with
   `oidc_sub` resolved per request. Getting this wrong orphans every board — silently,
   because the user just sees a freshly seeded empty one.
2. **Never persist an absolute URL to a media file.** `shared_sounds.file_url` holding
   a signed URL is why the current data cannot move. Store a reference, derive the URL.
3. **A valid token proves identity, not permission.** Keycloak does not do
   authorization. Derive the user server-side and scope every mutation; the client
   currently sends `user_id` itself and deletes with no user filter.
4. **Write S3 before PostgreSQL.** No shared transaction, so order the writes to fail
   into a harmless orphaned object rather than a row pointing at nothing.
5. **Nothing may require the public internet**, at runtime or build time.

## Where the detail lives

Read these before proposing backend changes rather than reasoning from scratch:

| Document | Contents |
| --- | --- |
| `docs/architecture.md` | how the app works today: sound sources, playback, upload flow, known rough edges |
| `docs/target-architecture.md` | the decided target: Node API, S3 design, Keycloak flow, identity mapping, workspace layout |
| `docs/backend-portability.md` | why Supabase does not port, options rejected, phased plan, open questions |
| `docs/supabase-surface-inventory.md` | every Supabase call site, table, column and policy as a port checklist |

Skills in `.claude/skills/`:

- `supabase-to-postgres` — executing the port. `references/` holds the target schema,
  the API contract, and the data-migration runbook.
- `airgap-readiness` — offline/on-prem blockers, including the ffmpeg.wasm core loaded
  from unpkg.com, COOP/COEP headers that only exist in dev, the AWS SDK's metadata
  probe, and Keycloak issuer-URL mismatches.
- `docs-sync` — the documentation contract and file map.

## Traps worth knowing up front

- `src/lib/ffmpegConvert.ts` fetches its wasm core from `unpkg.com` at runtime.
  Breaks offline, and breaks only *video* uploads, so it passes a casual smoke test.
- COOP/COEP headers are set by a Vite plugin for dev and preview only. Production
  needs them or `SharedArrayBuffer` is undefined and ffmpeg-mt fails to load.
- `getBuffer` in `App.tsx` calls bare `fetch(url)` with no headers and caches decoded
  buffers keyed by that URL. A bearer-protected audio endpoint breaks uploaded sounds
  only; a presigned URL would break the cache entirely.
- `numeric` is returned as a JSON number by PostgREST but as a **string** by
  `node-postgres`. `gain` is `numeric`.
- The AWS SDK's default credential chain probes EC2 instance metadata, which hangs
  rather than fails in a closed network. Pass credentials explicitly.
- `moveSound` runs two racing `UPDATE`s rather than one transaction.
- Nothing ever deletes an upload's bytes or its `shared_sounds` row.
- No client-side upload size limit exists; the only cap was Storage's 50 MiB.
- `public/sounds/` filenames contain spaces, `!` and curly quotes.
- `YouTubeSoundPanel.tsx` and `YOUTUBE_SERVER` are dead code.
- `.env` contains a committed Supabase anon key. Do not print it; it needs rotating.
