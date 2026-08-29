---
name: docs-sync
description: Keep this project's documentation, agent skills, steering files and Copilot instructions in sync with the code. Use whenever a change lands that affects architecture, the data or auth layer, the database schema, storage, dependencies, folder structure, build scripts, or deployment config — and use it before declaring any such task finished. Also use when asked to update docs, or when adding a new skill or steering file.
---

# Documentation sync contract

**Standing rule for this repository: a change to the code is not finished until the
documentation that describes it has been updated in the same turn.** Not a follow-up
task, not a TODO. The same turn.

This exists because the project is mid-migration off Supabase onto a closed-network
stack. Stale architecture docs during a migration are worse than no docs — they send
the next reader (human or agent) down a path that no longer exists.

## Scope: what counts as documentation-relevant

Update docs when a change touches any of:

- architecture, or any decision about the target stack
- the data layer, auth, or storage
- the database schema or migrations
- dependencies added, removed, or swapped
- folder structure, build scripts, or npm scripts
- deployment, hosting, or environment configuration
- a bug listed in the "known rough edges" / "existing bugs" sections
- conventions the instruction files assert

It is a **no-op** for: answering a question, reading files, a typo fix, a
purely cosmetic style change, or a change already fully described by existing docs.
Do not manufacture edits to satisfy the rule.

## The file map

`docs/` is the single source of truth. Everything else points at it or is
mechanically derived from it. Keep the prose in one place and cross-reference.

| File | Owns | Update when |
| --- | --- | --- |
| `docs/architecture.md` | how the app works today: sound sources, playback, upload flow, file inventory, known rough edges | app behaviour, structure or a listed rough edge changes |
| `docs/backend-portability.md` | why Supabase does not port, options considered, tradeoffs, phased plan, open questions | the analysis, an option's viability, or the plan changes |
| `docs/target-architecture.md` | the decided target: monorepo layout, Node API, S3, Keycloak, dev/prod topology | any target-stack decision changes |
| `docs/supabase-surface-inventory.md` | every Supabase call site, table, column, policy, as a port checklist | a Supabase call site is added, removed or ported |
| `docs/house-conventions.md` | the sibling projects on the same closed-environment stack: copy list, do-not-copy list, gaps | a sibling-project pattern is adopted, rejected, or found to have changed, or another sibling project is examined |
| `.kiro/skills/supabase-to-postgres/` | how to execute the port; `references/` holds the target schema, API contract, migration runbook | the port procedure, schema or API contract changes |
| `.kiro/skills/airgap-readiness/` | offline/on-prem blockers and the pre-deployment checklist | a new external dependency, header, cert or hosting requirement appears |
| `.kiro/skills/docs-sync/` | this contract and the file map | a doc, skill, steering or instruction file is added, renamed or removed |
| `.kiro/steering/project-context.md` | always-loaded summary and the standing constraints | a standing constraint changes |
| `.kiro/steering/backend-portability.md` | rules for editing the portability-critical layer | a rule for that layer changes |
| `.claude/skills/**` | byte-identical mirror of `.kiro/skills/**` | never by hand — run `npm run docs:sync` |
| `CLAUDE.md` | Claude Code entry point: commands, conventions, constraints, pointers | conventions, commands or constraints change |
| `.github/copilot-instructions.md` | Copilot repo-wide conventions and constraints | same as `CLAUDE.md` |
| `.github/instructions/*.instructions.md` | Copilot path-scoped rules, mirroring the two main skills | the matching skill changes, or paths move |

## Rules

**`docs/` first, then the agent configs.** Write the reasoning once in `docs/`.
`CLAUDE.md`, the steering files and the Copilot instructions carry the short version
plus a pointer. If you find yourself pasting three paragraphs into four files, the
content belongs in `docs/` and the others should link to it.

**Never hand-edit `.claude/skills/`.** `.kiro/skills/` is the source of truth. Run:

```powershell
npm run docs:sync    # copy .kiro/skills -> .claude/skills
npm run docs:check   # verify, exit 1 on drift
```

A Stop hook (`.kiro/hooks/sync-agent-docs.json`) runs the sync automatically, so in
practice you only need `docs:check` to confirm.

**Three tools, one message.** Kiro, Claude Code and Copilot must not disagree.
A rule that applies to the project applies in all three. If you update a constraint
in one, update the other two.

**Delete rules that stop being true.** The most damaging documentation failure here
is a rule that outlived its decision. "Auth is email + password, do not add other
flows" was correct against Supabase and became wrong the moment Keycloak entered the
picture. When a decision is superseded, rewrite the rule — do not append a
contradiction next to it.

**Keep path patterns current.** These break silently when files move:

- `fileMatchPattern` in `.kiro/steering/*.md` frontmatter
- `applyTo` in `.github/instructions/*.instructions.md` frontmatter
- the file inventory tables in `docs/architecture.md`
- `SOURCE` / `TARGET` in `scripts/sync-agent-docs.mjs`

The `frontend/` + `backend/` workspace split has happened, and it invalidated 91 `src/`
references plus every `fileMatchPattern` and `applyTo` glob in the repo. They were rewritten
in the same commit. `packages/shared/` was then added and removed again within a day, which
is the cautionary tale: it touched the layout tree in `target-architecture.md`, a
`fileMatchPattern`, three module tables, the API contract's seeding section and both
instruction files — twice. Check these four places whenever a package appears or disappears,
and prefer being sure before adding one.

**Record decisions, not just outcomes.** When a choice is made between real
alternatives, note what was rejected and why. `docs/backend-portability.md` is the
place for that, and `docs/target-architecture.md` carries a table tracking how each
decision has changed across revisions. A future reader needs to know that `bytea` was the
plan before S3 turned out to be available, that SPA-side PKCE was the plan before the
sibling projects' server-side cookie flow was found, and that the flow was going to live in
a sidecar before it moved into our own backend — otherwise all three get re-litigated.

## Before finishing a task

1. Does `docs/` still describe reality? Check `architecture.md` for behaviour and
   `target-architecture.md` for stack decisions.
2. Did a constraint or convention change? Update `.kiro/steering/`, `CLAUDE.md` and
   `.github/` together.
3. Did a rule become false? Rewrite it rather than qualifying it.
4. Did any file move? Fix `fileMatchPattern` and `applyTo`.
5. Run `npm run docs:check`.
6. If app code changed: `npm run build` and `npm run typecheck`.
