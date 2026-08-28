---
inclusion: always
---

# Soundboard

React 19 + Vite 8 soundboard. HeroUI 3 + Tailwind 4, `lucide-react` icons,
`@tanstack/react-query` for server state, `zustand` for UI state and audio refs.
Backend is currently Supabase (GoTrue auth, PostgREST, Storage), mid-migration.
Import with the `@/` alias, not deep relative paths. One React component per file.

Validate app changes with `npm run build` and `npm run typecheck`.

## Documentation is part of the change, not a follow-up

Any change to architecture, the data or auth layer, schema, storage, dependencies,
folder structure, build scripts or deployment config **must update the documentation
in the same turn**. The `docs-sync` skill holds the concern-to-file map. Run
`npm run docs:check` before finishing. Never hand-edit `.claude/skills/` — it is
generated from `.kiro/skills/` by `npm run docs:sync`.

This matters more than usual here because the project is mid-migration; a stale
architecture doc sends the next reader down a path that no longer exists.

## Active constraint: migrating off Supabase to a closed environment

The target environment has **PostgreSQL, S3-compatible object storage and Keycloak**,
no Supabase, and no outbound internet. This is a live requirement.

- **Never persist an absolute URL to a media file in the database.**
  `shared_sounds.file_url` holding a Supabase signed URL is the single biggest reason
  the current data cannot move. Store a reference and derive the URL.
- **Do not treat RLS as the only authorization.** The client sends `user_id` in
  inserts and deletes with no user filter. Only `auth.uid()` policies make that safe,
  and they will not exist. A valid token proves identity, not permission.
- **Do not add new Supabase-specific dependencies** (Storage, realtime, edge
  functions, `auth.*` schema references) without flagging the portability cost.
- **Do not add anything that needs the public internet at runtime or build time.**

## Where the detail lives

- `docs/architecture.md` — how the app works today
- `docs/target-architecture.md` — the decided target: Node API, S3, Keycloak, layout
- `docs/backend-portability.md` — why Supabase does not port; rejected options
- `docs/supabase-surface-inventory.md` — every Supabase call site, as a checklist
- Skills: `supabase-to-postgres`, `airgap-readiness`, `docs-sync`

Read those before proposing backend changes rather than reasoning from scratch.
