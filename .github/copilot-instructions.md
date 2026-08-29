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

## Repository shape and commands

An npm workspace with two packages: `frontend/` (`@soundboard/frontend`, the Vite SPA) and
`backend/` (`@soundboard/backend`, Vault + S3 so far). The root `package.json` is workspace
orchestration only. **No `packages/shared` and no turbo** — both were built and removed, so
`SOUNDS` lives only in `frontend/src/lib/sounds.ts`, the API cannot validate `sound_id`, and
the client seeds its own board. All scripts run from the root.

```bash
docker compose up -d    # minio on 9010 + bucket (no postgres: dev uses Supabase over pg)
npm run dev             # Vite on 3000, proxying /api and /auth to the backend on 3001
npm run dev:api         # backend on 3001, tsx watch
npm run typecheck:all   # frontend + backend
npm run api:check       # backend self-check: secrets + PostgreSQL + S3 round trip
npm run secrets:example # create backend/local_secrets/ and backend/.env from templates
npm run build:api       # compile backend
npm run docs:check      # verify the .claude/skills mirror
```

Secrets in development: `IS_BLACK_ENV=true` makes `getSecret(name)` read
`backend/local_secrets/<name>` as JSON, where the secret name is the path. That folder is
gitignored; `backend/local_secrets.example/` is committed and `npm run secrets:example`
copies it into place.

Backend conventions, already set by the existing code: ESM with `.js` extensions on relative
imports (NodeNext), `config/` for Zod-validated env, `utils/` for integrations, object-first
logging, and no fallback values for things the architecture guarantees. Never log a secret
value — log its path. `frontend/src/lib/synth.ts` and `frontend/src/lib/useAuth.tsx` have pre-existing lint
failures unrelated to current work; eslint does not yet cover `backend/`.

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
- Built-in pads are declared in `frontend/src/lib/sounds.ts`; bundled audio lives in
  `frontend/public/sounds` and pad images in `frontend/public/images`.
- Prefer mp3 and mp4 support when working on playback behavior.
- Prefer HeroUI components for app UI, but match the installed HeroUI API exactly
  instead of mixing patterns from other component libraries.
- Define and reuse shared app theme variables in `frontend/src/index.css` for HeroUI-facing
  colors, surfaces, borders, and form controls instead of scattering ad-hoc colors
  through components.
- Prefer HeroUI for inputs, tabs, buttons, and sliders. For overlays, use a custom
  modal/dialog shell if the installed HeroUI primitive fights the product flow or
  proves unreliable in this app.
- Keep one React component per file. Shared constants, helpers, and types may live
  alongside them in non-component files.
- Import project modules with the `@/` alias (maps to `frontend/src/`) instead of deep
  relative paths.
- Keep changes minimal and validate with `npm run build` and `npm run typecheck`
  when app code changes.

## Write less code, and almost no comments

Every line has to earn its place. Prefer deleting to adding.

**Comments.** The test is not "is this true and interesting" — almost everything passes
that. The test is: **would a competent reader make a wrong change without this line, and
would the mistake be silent?** If the code fails loudly when they get it wrong, the
failure is the comment. Expect one or two comments in a file, often zero.

Specifically banned: restating the code, section-divider banners, a docstring on a
function whose name and signature already say it, and **carrying rationale across from
`docs/` or a reference file while transcribing**. Design history, alternatives and "why
not X" stay where they are; a second copy in source guarantees one of them goes stale.

**New code: "nothing calls it yet" is not the test.** This is a migration branch.
Building Vault, S3, the pool and the auth flow before their consumers exist is the work,
and `docs/target-architecture.md` names those functions. Ask instead:

- Does `docs/` commit to it, or does a named next step consume it? Build it.
- Was it invented while writing the file — an extra option, a defensive branch, an input
  format nobody asked for, a helper added "while we're here"? Cut it. That is the code
  that gets documented, maintained, and thrown away unused.

No abstraction for a single call site, and no file that exists only to re-export one line.

**Existing verbosity is not a precedent.** When editing an over-commented or over-built
file, trim rather than match it.

**Keep chat replies short.** Lead with the answer. Add background, alternatives and
caveats only when asked, or when a decision genuinely turns on them.

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
  (an employee number — `sub` is never read in this environment). It is stored **directly**
  in `user_sounds.user_id` and `shared_sounds.owner_id` as `text`; there is no users table.
  Existing rows hold Supabase UUIDs, so the data import must rewrite them. Getting that
  wrong orphans a board, silently.
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

- `frontend/src/lib/ffmpegConvert.ts` loads its wasm core from `unpkg.com` at runtime — a hard
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
- `moveSound` uses two racing `UPDATE`s instead of one transaction. Fixed in
  `POST /api/user-sounds/reorder`, but the hook still calls Supabase.
- Nothing deletes an upload's bytes or its `shared_sounds` row, and there is no
  client-side size limit. Both are phase-6 work, and uploads are parked meanwhile.
- ~~`YouTubeSoundPanel.tsx` and `YOUTUBE_SERVER` are dead code~~ — both deleted.
- `.env` contains a committed anon key that needs rotating. Never echo its value.
