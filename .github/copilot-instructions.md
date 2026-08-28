# Soundboard project instructions

## Project

React 19 + Vite 8 soundboard. HeroUI 3 + Tailwind 4, `lucide-react` icons,
`@tanstack/react-query` for server state, `zustand` for UI state and audio refs,
ffmpeg.wasm for in-browser video → MP3 conversion. Backend is currently Supabase and
is being migrated to a closed-environment stack.

Deeper context, read these before proposing backend changes:

- `docs/architecture.md` — how the app works today
- `docs/target-architecture.md` — the decided target: one Node backend, S3, Keycloak, Vault
- `docs/house-conventions.md` — the two sibling projects already on this stack: what to
  copy and what not to
- `docs/backend-portability.md` — why Supabase does not port; rejected options
- `docs/supabase-surface-inventory.md` — every Supabase call site as a checklist
- `.github/instructions/` — path-scoped rules for the data layer and for offline
  deployment

## Documentation is part of the change

Any change to architecture, the data or auth layer, schema, storage, dependencies,
folder structure, build scripts or deployment config must update the documentation in
the same change. The mapping of concern to file is in
`.kiro/skills/docs-sync/SKILL.md`. Run `npm run docs:check` before finishing.

Kiro, Claude Code and Copilot must not disagree — a rule that applies to the project
applies in all three, so `.kiro/steering/`, `CLAUDE.md` and this file get updated
together. When a decision is superseded, rewrite the rule rather than appending a
contradiction next to it.

## Conventions

- The board lives in Supabase (`user_sounds`, `shared_sounds`) and requires sign-in.
  There is no guest/local fallback.
- Auth today is Supabase email + password. The target is Keycloak SSO via a server-side
  code flow **in our own backend**, setting an httpOnly cookie. No OIDC library in the
  browser, no login UI — `AuthPage.tsx` gets deleted, not rewritten. `openid-client` goes on
  the backend only. Do not add any other auth flow.
- `.env` must hold `VITE_SUPABASE_URL` and the anon key of the *same* project ref;
  restart the dev server after changing it.
- Schema changes go in `supabase/migrations` while still on Supabase, applied with
  `npx supabase db push`.
- Built-in pads are declared in `src/lib/sounds.ts`; bundled audio lives in
  `public/sounds` and pad images in `public/images`.
- Prefer mp3 and mp4 support when working on playback behavior.
- Prefer HeroUI components for app UI, but match the installed HeroUI API exactly
  instead of mixing patterns from other component libraries.
- Define and reuse shared app theme variables in `src/index.css` for HeroUI-facing
  colors, surfaces, borders, and form controls instead of scattering ad-hoc colors
  through components.
- Prefer HeroUI for inputs, tabs, buttons, and sliders. For overlays, use a custom
  modal/dialog shell if the installed HeroUI primitive fights the product flow or
  proves unreliable in this app.
- Keep one React component per file. Shared constants, helpers, and types may live
  alongside them in non-component files.
- Import project modules with the `@/` alias (maps to `src/`) instead of deep
  relative paths.
- Keep changes minimal and validate with `npm run build` and `npm run typecheck`
  when app code changes.

## Active constraint: migrating off Supabase

The target environment provides **PostgreSQL, S3-compatible object storage, Keycloak and
HashiCorp Vault**, no Supabase, and no outbound internet, plus one Node process tying them
together. This is a live requirement, not a hypothetical.

**Two sibling projects already run on that stack** — `../yanshuf3` and
`../yanshuf3-Hana2Trino`, same Keycloak, same S3, same Vault. Read
`docs/house-conventions.md` before designing anything backend.

**Soundboard adds exactly one process.** Vault is read directly over its KV v2 API (port
hana2trino's `backend/src/utils/secrets.ts`) and the Keycloak code flow runs in our own
backend. No auth sidecar, no vault microservice, no Python — both siblings split those out
and we deliberately do not.

Supabase Storage is not a Postgres feature, and browsers cannot speak the PostgreSQL
wire protocol. Porting means rebuilding the HTTP layer, not swapping a database.

- **Never use the Keycloak identity claim as a foreign key.** The claim here is `upn`
  (an employee number — `sub` is never read in this environment), and it differs from
  the Supabase user id already in `user_sounds.user_id`. Ownership references
  `app_users.id` with `upn` resolved per request. Getting this wrong orphans every
  board, silently.
- **Never persist an absolute URL to a media file in the database.**
  `shared_sounds.file_url` holding a signed URL is why the current data cannot move.
- **A valid token proves identity, not permission.** Keycloak does not do
  authorization. Derive the user server-side; the client currently sends `user_id`
  itself and deletes with no user filter. "Identify the user but don't block the app"
  does not relax this.
- **Write S3 before PostgreSQL.** They cannot share a transaction, so order the
  writes to fail into a harmless orphaned object.
- **Secrets come from Vault, read directly over KV v2**, not `.env`. Memoise the derived
  clients (one `pg.Pool`, one `S3Client`) rather than hitting Vault per request.
- **Do not add anything requiring the public internet**, at runtime or build time.
- **Do not add new Supabase-only dependencies** (Storage, realtime, edge functions,
  `auth.*` schema references) without flagging the portability cost.

## Known traps

- `src/lib/ffmpegConvert.ts` loads its wasm core from `unpkg.com` at runtime — a hard
  failure offline, and it only breaks *video* uploads, so it is easy to miss.
- COOP/COEP headers are set by a Vite plugin for dev and preview only. Production
  must send them or `SharedArrayBuffer` is undefined and ffmpeg-mt fails.
- `getBuffer` in `App.tsx` calls bare `fetch(url)` with no headers and caches decoded
  buffers keyed by that URL. A bearer-protected audio endpoint would break uploaded
  sounds only — which is why the session is a cookie. A presigned URL would break the
  cache entirely.
- `npm ci` against the Nexus mirror fails on lockfile integrity hashes unless
  `stripLockIntegrity` runs first. yanshuf3 has the script.
- `numeric` comes back as a JSON number from PostgREST but as a **string** from
  `node-postgres`. `gain` is `numeric`.
- The AWS SDK's default credential chain probes EC2 instance metadata, which hangs
  rather than fails in a closed network. Pass credentials explicitly.
- `moveSound` uses two racing `UPDATE`s instead of one transaction.
- Nothing ever deletes an upload's bytes or its `shared_sounds` row.
- No client-side upload size limit; the only cap was Storage's 50 MiB.
- `YouTubeSoundPanel.tsx` and `YOUTUBE_SERVER` are dead code.
- `.env` contains a committed anon key that needs rotating. Never echo its value.
