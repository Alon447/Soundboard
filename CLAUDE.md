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
docker compose up -d    # minio on 9010 + bucket (no postgres: dev uses Supabase over pg)
npm run dev             # vite dev server (frontend), proxies /api to 3001
npm run dev:api         # backend on 3001, tsx watch
npm run build           # production build (frontend)
npm run typecheck       # frontend
npm run typecheck:api   # backend
npm run typecheck:all   # both
npm run build:api       # compile backend to backend/dist
npm run api:check       # backend self-check: secrets + PostgreSQL + S3 round trip
npm run secrets:example # create backend/local_secrets/ and backend/.env from templates
npm run lint            # eslint (frontend only for now)
npm run docs:sync       # mirror .kiro/skills -> .claude/skills
npm run docs:check      # verify that mirror, exit 1 on drift
```

Secrets in development: `IS_BLACK_ENV=true` makes `getSecret(name)` read
`backend/local_secrets/<name>` as JSON, where the secret name is the path
(`db/postgres/dev` → `backend/local_secrets/db/postgres/dev`). That folder is gitignored;
`backend/local_secrets.example/` is committed and `npm run secrets:example` copies it into
place without overwriting anything.

Run `npm run typecheck:all` after any change, plus `npm run build` for frontend changes.
Do not start `npm run dev` yourself — it never exits; ask the user to run it.

`frontend/src/lib/synth.ts` and `frontend/src/lib/useAuth.tsx` have pre-existing lint failures unrelated to
current work. eslint does not yet cover `backend/`.

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

## Repository shape

An npm workspace with two packages: `frontend/` (`@soundboard/frontend`, the Vite SPA) and
`backend/` (`@soundboard/backend`, Express 5 + Vault + S3 + PostgreSQL). The root
`package.json` is workspace orchestration only.

**No `packages/shared` and no turbo** — both were built and removed. The workspace exists to
keep `pg`, `@aws-sdk/*` and `jose` out of the browser bundle, not to share code. `SOUNDS`
lives only in `frontend/src/lib/sounds.ts`, so the API cannot validate `sound_id` and does
not seed: the client reads its board and `POST`s all 15 pads when it is empty. See
`docs/target-architecture.md`.

All scripts run from the root; no `cd` needed.

Backend conventions, already established in the code: ESM with `.js` extensions on relative
imports (NodeNext), `config/` for validated env, `utils/` for integrations, object-first
logging, Zod at every boundary, and no fallback values for things the architecture
guarantees. Never log a secret value — log its path.

## Conventions

- Import via the `@/` alias (`@/lib/useAuth`), never deep relative paths. Frontend only;
  the backend uses relative `.js` imports.
- One React component per file. Shared constants, helpers and types may sit
  alongside in non-component files.
- Prefer HeroUI for inputs, tabs, buttons and sliders, and match the installed
  HeroUI 3 API exactly rather than mixing in patterns from other libraries. For
  overlays, a custom modal shell is acceptable where the HeroUI primitive fights
  the flow.
- Theme values (colours, surfaces, borders, form controls) belong in
  `frontend/src/index.css` as shared variables, not scattered through components.
- Built-in pads are declared in `frontend/src/lib/sounds.ts`; bundled audio lives in
  `frontend/public/sounds/`, pad images in `frontend/public/images/`.
- Keep mp3 and mp4 support working when touching playback.
- Auth today is Supabase email + password. The target is Keycloak SSO via a server-side
  code flow **in our own backend**, setting an httpOnly cookie. No OIDC library in the
  browser, no login UI at all — `AuthPage.tsx` gets deleted, not rewritten. `openid-client`
  goes on the backend only. Do not add any other auth flow.
- Schema changes go in `supabase/migrations/` while still on Supabase, applied with
  `npx supabase db push`. New schema for the target stack goes in `db/migrations/`.
- Keep changes minimal and scoped to what was asked.

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

## The migration that shapes all backend work

The target is a closed environment providing **PostgreSQL, S3-compatible object
storage, Keycloak and HashiCorp Vault**, with no outbound internet, plus one Node process
tying them together. This is a live requirement.

**Two sibling projects already run on that stack** — `../yanshuf3` and
`../yanshuf3-Hana2Trino`, same Keycloak, same S3, same Vault. Read
`docs/house-conventions.md` before designing anything backend. Most decisions are already
made there, and it also documents which of their patterns are warts to avoid.

**Soundboard adds exactly one process.** Vault is read directly over its KV v2 API (port
hana2trino's `backend/src/utils/secrets.ts`) and the Keycloak code flow runs in our own
backend. No auth sidecar, no vault microservice, no Python — both siblings split those out
and we deliberately do not.

Supabase Storage is not a Postgres feature, and browsers cannot speak the PostgreSQL
wire protocol. Porting means rebuilding the HTTP layer Supabase provided, not
swapping a database. If asked whether the app can just point at the closed-environment
PostgreSQL, the answer is no — explain why before proposing anything.

Six rules, in rough order of how expensive they are to get wrong:

1. **`upn` is the ownership key, stored directly — there is no `app_users` table.**
   `user_sounds.user_id` and `shared_sounds.owner_id` are `text` holding the claim (an
   employee number; `sub` is never read here), uppercased once at the boundary. Existing
   rows hold Supabase UUIDs, so the import must rewrite them via the exported
   `auth.users` emails. Miss one and that board orphans silently — the user just sees a
   freshly seeded empty one.
2. **Never persist an absolute URL to a media file.** `shared_sounds.file_url` holding
   a signed URL is why the current data cannot move. Store a reference, derive the URL.
3. **A valid token proves identity, not permission.** Keycloak does not do
   authorization. Derive the user server-side and scope every mutation; the client
   currently sends `user_id` itself and deletes with no user filter. "Use Keycloak only
   to identify the user, not to block the app" is a fine product decision and does not
   relax this — not gating the app is different from letting one user delete another's
   board.
4. **Write S3 before PostgreSQL.** No shared transaction, so order the writes to fail
   into a harmless orphaned object rather than a row pointing at nothing.
5. **Secrets come from Vault, read directly over KV v2**, not `.env`. Memoise the derived
   clients rather than hitting Vault per request.
6. **Nothing may require the public internet**, at runtime or build time.

## Where the detail lives

Read these before proposing backend changes rather than reasoning from scratch:

| Document | Contents |
| --- | --- |
| `docs/architecture.md` | how the app works today: sound sources, playback, upload flow, known rough edges |
| `docs/target-architecture.md` | the decided target: Node API, S3 design, Keycloak BFF, identity mapping, workspace layout |
| `docs/house-conventions.md` | the two sibling projects on the same stack: copy list, do-not-copy list, gaps |
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

- `frontend/src/lib/ffmpegConvert.ts` fetches its wasm core from `unpkg.com` at runtime.
  Breaks offline, and breaks only *video* uploads, so it passes a casual smoke test.
- COOP/COEP headers are set by a Vite plugin for dev and preview only. Production
  needs them or `SharedArrayBuffer` is undefined and ffmpeg-mt fails to load.
- `getBuffer` in `App.tsx` calls bare `fetch(url)` with no headers and caches decoded
  buffers keyed by that URL. A bearer-protected audio endpoint would break uploaded
  sounds only — which is why the session is a cookie. A presigned URL would break the
  cache entirely.
- `npm ci` against the Nexus mirror fails on lockfile integrity hashes unless
  `stripLockIntegrity` runs first. yanshuf3 has the script.
- `numeric` is returned as a JSON number by PostgREST but as a **string** by
  `node-postgres`. `gain` is `numeric`.
- The AWS SDK's default credential chain probes EC2 instance metadata, which hangs
  rather than fails in a closed network. Pass credentials explicitly.
- `moveSound` runs two racing `UPDATE`s rather than one transaction. Fixed in
  `POST /api/user-sounds/reorder`, but the hook still calls Supabase.
- Nothing deletes an upload's bytes or its `shared_sounds` row, and there is no
  client-side size limit. Both are phase-6 work; neither can grow while uploads are parked.
- ~~Sound filenames contain spaces, `!` and curly quotes~~ — all 15 are ASCII slugs now.
- ~~`YouTubeSoundPanel.tsx` and `YOUTUBE_SERVER` are dead code~~ — both deleted.
- `.env` contains a committed Supabase anon key. Do not print it; it needs rotating.
