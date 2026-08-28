---
inclusion: always
---

# Soundboard

React 19 + Vite 8 soundboard. HeroUI 3 + Tailwind 4, `lucide-react` icons,
`@tanstack/react-query` for server state, `zustand` for UI state and audio refs.
Backend is currently Supabase (GoTrue auth, PostgREST, Storage), mid-migration.
Import with the `@/` alias, not deep relative paths. One React component per file.

Validate app changes with `npm run build` and `npm run typecheck`.

## Write less code, and almost no comments

Every line has to earn its place. Prefer deleting to adding.

**Comments.** No comment that restates the code. No section-divider banners, no
docstring on a function whose name and signature already say it. Comment only what the
code cannot record: a non-obvious constraint, a workaround for external behaviour, or a
decision a reader would otherwise reverse. One or two lines. Rationale, history and
rejected alternatives belong in `docs/` — a second copy in source guarantees one of them
goes stale.

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

## Documentation is part of the change, not a follow-up

Any change to architecture, the data or auth layer, schema, storage, dependencies,
folder structure, build scripts or deployment config **must update the documentation
in the same turn**. The `docs-sync` skill holds the concern-to-file map. Run
`npm run docs:check` before finishing. Never hand-edit `.claude/skills/` — it is
generated from `.kiro/skills/` by `npm run docs:sync`.

This matters more than usual here because the project is mid-migration; a stale
architecture doc sends the next reader down a path that no longer exists.

## Active constraint: migrating off Supabase to a closed environment

The target environment has **PostgreSQL, S3-compatible object storage, Keycloak and
HashiCorp Vault**, no Supabase, and no outbound internet. This is a live requirement.

**Two sibling projects already run on that stack** — `../yanshuf3` and
`../yanshuf3-Hana2Trino`. Their conventions are prior art; read
`docs/house-conventions.md` before designing anything backend.

Soundboard adds **exactly one process**. Vault is read directly over its KV v2 API and the
Keycloak code flow runs in our own backend — no auth sidecar, no vault microservice, no
Python, unlike the siblings.

- **Never persist an absolute URL to a media file in the database.**
  `shared_sounds.file_url` holding a Supabase signed URL is the single biggest reason
  the current data cannot move. Store a reference and derive the URL.
- **Do not treat RLS as the only authorization.** The client sends `user_id` in
  inserts and deletes with no user filter. Only `auth.uid()` policies make that safe,
  and they will not exist. A valid token proves identity, not permission.
- **Secrets come from Vault, read directly over KV v2, not from `.env`.** Already built at
  `backend/src/utils/secrets.ts` — use `getSecret(name, schema?)` and `SECRET_PATHS`, and
  memoise anything derived from a secret rather than hitting Vault per request.
- **Do not add new Supabase-specific dependencies** (Storage, realtime, edge
  functions, `auth.*` schema references) without flagging the portability cost.
- **Do not add anything that needs the public internet at runtime or build time.**

## Where the detail lives

- `docs/architecture.md` — how the app works today
- `docs/target-architecture.md` — the decided target: Node API, S3, Keycloak BFF, layout
- `docs/house-conventions.md` — the two sibling projects to copy from, and what not to copy
- `docs/backend-portability.md` — why Supabase does not port; rejected options
- `docs/supabase-surface-inventory.md` — every Supabase call site, as a checklist
- Skills: `supabase-to-postgres`, `airgap-readiness`, `docs-sync`

Read those before proposing backend changes rather than reasoning from scratch.
