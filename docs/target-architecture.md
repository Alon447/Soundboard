# Target architecture

The stack Soundboard moves to for the closed environment. This document records
decisions; [`backend-portability.md`](./backend-portability.md) records why Supabase
cannot come along and what alternatives were rejected.

## What the closed environment provides

| Available | Used for |
| --- | --- |
| PostgreSQL | relational data: boards, shared sounds, asset metadata |
| S3-compatible object storage | audio bytes |
| Keycloak | authentication (OIDC) |
| ability to run a Node process | the API that ties the three together |

That last row is the load-bearing one. PostgreSQL, S3 and Keycloak are all
independently reachable, but none of them can serve a browser the way Supabase did.
Something has to hold the session, enforce ownership, and hand out audio.

## Topology

```
                    ┌──────────────┐
browser ────────────│  Node API    │──── TCP ────> PostgreSQL   (boards, metadata)
   │  HTTPS         │  (Fastify)   │──── HTTPS ──> S3           (audio bytes)
   │  same origin   │              │──── HTTPS ──> Keycloak     (JWKS only)
   │                └──────────────┘
   └──── OIDC redirect ───────────────────────────> Keycloak    (login)
```

One origin. The API serves the built SPA and `/api/*`, so there is no CORS anywhere
and `Cross-Origin-Embedder-Policy: require-corp` is satisfied for free. The browser
talks to Keycloak only during the login redirect.

## Storage: S3, read through the API

Audio bytes live in an S3 bucket. The database stores only the object key.

**Reads are proxied by the API, not presigned.** `GET /api/shared-sounds/:id/audio`
looks up the key, does a `GetObject`, and streams the bytes back. Presigned URLs
handed to the browser were considered and rejected for now, for four reasons:

1. **The buffer cache would stop working.** `App.tsx` caches decoded `AudioBuffer`s
   in a `Map` keyed by the URL string. A presigned URL carries a signature and an
   expiry, so it differs on every issue — the cache key would never repeat, and
   every pad press would re-download and re-decode. This is the kind of regression
   that shows up as "the app feels slow" three weeks later.
2. **Bucket CORS becomes a dependency.** A cross-origin `fetch()` needs
   `Access-Control-Allow-Origin` from the bucket. In a locked-down environment that
   is a ticket to whoever owns the object store, not a config edit.
3. **Expiry versus caching.** A URL that expires cannot carry a long
   `Cache-Control`, so you either re-sign constantly or lose caching.
4. **Revocation.** A proxied read checks the session every time. A presigned URL is
   valid to anyone holding it until it expires.

The cost is that audio bytes flow through the API process. For clips of a few hundred
kilobytes behind an immutable cache header, that is not a real cost.

**Design so presigning stays available.** Two things keep the door open:

- Key the decoded-buffer cache on the **sound id**, not the URL. Small change to
  `getBuffer` in `App.tsx`, and it removes objection 1 entirely.
- Keep the URL derivation in one place (`userSoundToBoard`), so switching the
  endpoint to a `302` redirect at a presigned URL is a one-line change.

Do the cache-key change early — it is cheap now and awkward later.

### Object keys are content-addressed

```
sounds/<first 2 hex of sha256>/<full sha256 hex>.<ext>
```

Content addressing gives three things for free: identical uploads deduplicate,
retries are idempotent (`PutObject` of the same content is a no-op, so a failed
request can be retried safely), and the digest doubles as an `ETag`. The two-hex
prefix keeps any single key prefix from getting hot.

This replaces the old `<user_id>/<epoch_ms>.<ext>` convention. Attribution moves
entirely into the database, which is where it belongs — the object store should not
be the index of record.

### Write and delete order

**Write S3 first, then the database.**

1. `PutObject`.
2. In one transaction: insert `sound_assets`, insert `shared_sounds`, insert
   `user_sounds`.

If step 2 fails you get an orphan object: invisible, harmless, reclaimable by a
reconciliation job. The reverse order gives you a database row pointing at nothing,
which is a broken pad in someone's board. Prefer the recoverable failure.

**Delete the database rows first, then the object**, best-effort, for the same
reason. Deleting an asset still referenced by another user's pad must be refused, so
check references inside the transaction.

Neither S3 nor PostgreSQL participates in the other's transaction. Accept that and
plan a periodic reconciliation job that lists objects with no `sound_assets` row and
deletes them after a grace period. Do not attempt two-phase commit.

### Client configuration

`@aws-sdk/client-s3` v3, with `forcePathStyle: true` (MinIO and Ceph RGW generally
require path-style; virtual-host style needs wildcard DNS), an explicit `endpoint`,
and **explicit credentials**. See the `airgap-readiness` skill for why the default
credential chain is dangerous in a closed network.

Multipart upload is unnecessary at these file sizes.

## Auth: Keycloak via OIDC

Keycloak removes the riskiest code in the whole port. Writing password hashing,
session management, reset flows and lockout is where a hand-rolled backend gets
security wrong, and none of it has to be written now. It also disposes of the
no-SMTP problem: email verification and password reset become Keycloak's business.

**Flow: Authorization Code + PKCE, public client, in the SPA.** The API validates
the access token against Keycloak's JWKS on every request.

Library: `oidc-client-ts` with `react-oidc-context`. Its provider/hook shape maps
almost directly onto the existing `useAuth` context, which is the point — keep the
context's public shape identical so nothing downstream changes:

```ts
// src/lib/useAuth.tsx — same shape, different source
{ user: { id, email, user_metadata: { name } } | null, session, loading, signOut }
```

Map the OIDC profile onto it: `sub` → `id`, `email` → `email`,
`name ?? preferred_username` → `user_metadata.name`. `App.tsx`, `useUserSounds` and
`useSharedSounds` then need no changes at all.

`AuthPage.tsx` collapses to a single "Sign in" button calling `signinRedirect()`.
The email and password fields go away.

### Identity mapping — the part that decides whether existing boards survive

Keycloak's `sub` is a different UUID from the Supabase user id already stored in
`user_sounds.user_id` and `shared_sounds.owner_id`. Using `sub` directly as the
foreign key orphans every existing board.

Keep a local mirror table instead:

```sql
create table app_users (
  id         uuid primary key default gen_random_uuid(),  -- keep Supabase UUIDs on import
  oidc_sub   text unique,                                 -- Keycloak sub, attached on first login
  email      citext not null unique,
  display_name text,
  created_at timestamptz not null default now()
);
```

On each authenticated request, resolve the local user:

1. Look up by `oidc_sub`. Found → done.
2. Not found → look up by `email` from the token. Found → attach `oidc_sub` to that
   row. **This is what reconnects an imported user to their existing board.**
3. Still not found → insert a new row.

Two consequences worth stating plainly. First, step 2 trusts the email in the token,
which is only safe because Keycloak is the authoritative corporate directory —
require `email_verified` and do not use this pattern with a self-service IdP. Second,
`app_users.id` never changes, so the identity provider stays swappable and every
foreign key survives.

**Never use the raw `sub` as a foreign key.** All ownership columns reference
`app_users.id`.

### Token validation

`jose`'s `createRemoteJWKSet` plus `jwtVerify`, checking `iss`, `aud` and `exp`.
JWKS is cached and refetched on unknown `kid`. The Keycloak URL must be reachable
from the API, not from the browser's network — those may differ.

### The one concrete code trap

`getBuffer` in `App.tsx` calls bare `fetch(url)` with no headers. If
`/api/shared-sounds/:id/audio` requires `Authorization: Bearer <token>`, **playback
breaks**, and it breaks only for uploaded sounds, since built-ins are static files.

Options, in order of preference:

1. Attach the token in `getBuffer` via a module-level accessor set by the auth
   provider. Smallest change.
2. Move to a BFF: the API completes the code flow server-side and issues an
   httpOnly session cookie. Then `fetch(url, { credentials: 'same-origin' })` is
   authenticated automatically, and no token ever touches JavaScript. More server
   code, better security posture.

Option 1 is the default given how little the project cares about auth. Option 2 is
the hardening path, and worth taking if the environment has an opinion about tokens
in browser memory.

## Repository layout

A Node API alongside the SPA needs real package boundaries. npm workspaces:

```
soundboard/
├── package.json                 # workspaces: ["apps/*", "packages/*"]; orchestration scripts
├── package-lock.json            # single lockfile
├── tsconfig.base.json
├── apps/
│   ├── web/                     # the SPA, moved wholesale
│   │   ├── index.html
│   │   ├── vite.config.ts       # @ -> ./src, /api proxy, COOP/COEP plugin
│   │   ├── tsconfig.json
│   │   ├── public/              # sounds/, images/, ffmpeg/ (vendored wasm core)
│   │   └── src/                 # unchanged internally
│   └── api/
│       ├── package.json         # fastify, pg, @aws-sdk/client-s3, jose
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts         # bootstrap, static dist, COOP/COEP headers
│           ├── config.ts        # env parsing, fail fast on missing vars
│           ├── db/              # pool, migration runner, queries
│           ├── storage/         # S3 client: put, get, delete, reconcile
│           ├── auth/            # JWKS verify, user mirror upsert, requireUser
│           └── routes/
│               ├── userSounds.ts
│               └── sharedSounds.ts
├── packages/shared/
│   └── src/
│       ├── types.ts             # UserSound, SharedSound, BoardSound
│       └── builtinSounds.ts     # the SOUNDS list
├── db/migrations/               # plain .sql, applied by the runner in apps/api
├── docs/
└── scripts/
```

### Why workspaces rather than just adding `server/`

Two things genuinely have to be shared, and both currently live in the frontend:

- **`SOUNDS`** (`src/lib/sounds.ts`) — the API needs it for first-login seeding.
- **`UserSound` / `SharedSound`** (`src/lib/supabase.ts`) — the API produces these
  shapes and the frontend consumes them.

Reaching across `src/` ↔ `server/` without a package boundary means either
duplicating both (they will drift, and the seeding one will drift silently) or
tsconfig and bundler hacks that break `tsc -b` and confuse Vite's dependency
discovery. A workspace package is the honest way to express "both sides depend on
this".

It also enforces the dependency split that a single `package.json` cannot: `pg`,
`@aws-sdk/*` and `jose` never reach the browser bundle, and React never reaches the
API.

The move is mechanical. Imports inside `apps/web/src` are untouched because `@/`
still resolves to that directory. What does change: the alias target in
`vite.config.ts`, the tsconfig layout, the `SOURCE`/`TARGET` paths in
`scripts/sync-agent-docs.mjs`, and every `src/lib/**` path pattern in
`.kiro/steering/*.md` and `.github/instructions/*.instructions.md`. Do those in the
same commit as the move — see the `docs-sync` skill.

**Not yet done.** The layout above is agreed but the files have not moved. It is a
high-churn refactor with no behavioural payoff on its own, so it should land as its
own commit, ideally right before the API work starts and after the Phase 1 seam
(`src/lib/api.ts`) is in place — moving a smaller, better-factored surface is easier.

## Dev and production

**Dev** runs two processes: Vite on 5173, API on 3000, with Vite proxying `/api`:

```ts
// apps/web/vite.config.ts
server: {
  proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
}
```

That keeps dev same-origin too, so the COOP/COEP plugin and the audio fetch behave
exactly as in production. Run them in two terminals, or add a root script.

**Production** is one process: `apps/web` builds to static assets, the API serves
them plus `/api/*`. The API must send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` on the HTML response — the Vite plugin
that does this today only covers dev and preview, so this is a real gap to close.

### Environment variables

API (server-side, never bundled):

```
DATABASE_URL
PGSSLROOTCERT            # if PG requires the internal CA
S3_ENDPOINT
S3_REGION
S3_BUCKET
S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY
S3_FORCE_PATH_STYLE=true
OIDC_ISSUER              # https://keycloak.internal/realms/<realm>
OIDC_AUDIENCE
MAX_UPLOAD_BYTES
```

Web (bundled, so public by definition — no secrets):

```
VITE_OIDC_ISSUER
VITE_OIDC_CLIENT_ID
VITE_OIDC_REDIRECT_URI
```

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are removed at the end of the port.
The committed anon key needs rotating regardless.

## What this changes versus the earlier plan

Recorded so the reasoning is not re-litigated:

| Decision | Before S3/Keycloak were known | Now |
| --- | --- | --- |
| audio bytes | `bytea` column in PostgreSQL | S3 object, key in PostgreSQL |
| audio URL | `/api/shared-sounds/:id/audio` serving from `bytea` | same endpoint, proxying S3 |
| auth | own `app_users` + bcrypt + session table | Keycloak OIDC; `app_users` survives as an identity mirror |
| sessions | `app_sessions` table + httpOnly cookie | Keycloak tokens (or a BFF cookie if hardening) |
| no SMTP | activate on signup, or admin provisioning | Keycloak's problem, not ours |
| layout | single package, add `server/` | npm workspaces: `apps/web`, `apps/api`, `packages/shared` |

Unchanged, and still the two things that matter most: **never store an absolute
media URL in the database**, and **derive the user server-side, never from the
request body**.

## Open questions

- Which S3 implementation? MinIO, Ceph RGW, NetApp StorageGRID and Dell ECS differ
  on path-style requirements, presigning support and CORS configurability.
- Is a bucket already provisioned, with credentials, or does that need requesting?
  What is the retention and backup policy on it?
- Keycloak realm and client: does a client exist, and can it be configured as a
  public client with PKCE and the app's redirect URI?
- Are Keycloak accounts already provisioned for the intended users, and do their
  emails match the current Supabase accounts? That determines whether the
  email-matching import step reconnects existing boards.
- Is `email_verified` reliable in that realm?
- Does anything in the environment object to access tokens held in browser memory?
  If so, go BFF from the start rather than retrofitting.
- PostgreSQL major version, and whether `CREATE EXTENSION` is permitted.
- Internal CA certificate location, for both PostgreSQL and S3 connections.
