-- ---------------------------------------------------------------------------
-- Soundboard — target schema for the closed environment
--   PostgreSQL : relational data
--   S3         : audio bytes (this schema stores only the object key)
--   Keycloak   : authentication (this schema stores only the upn claim)
--
-- Differences from supabase/migrations/*.sql, and why:
--   * auth.users            -> nothing. Ownership columns hold the Keycloak `upn`
--                             claim directly as text; there is no users table.
--   * no password_hash      -> Keycloak owns credentials
--   * no session table      -> the session is an httpOnly cookie holding the ID token
--   * no RLS / auth.uid()   -> ownership enforced in the API layer
--   * storage bucket        -> sound_assets.object_key pointing into S3
--   * file_url / storage_path / custom_file_url dropped entirely
--                             (absolute URLs are what made the old data
--                              unportable; the client derives the URL now)
--   * gain numeric          -> double precision
--                             (node-postgres returns numeric as a STRING)
--   * added the indexes the original schema was missing
--   * shared_sound_id on delete cascade, not set null
--                             (set null violates sound_source_check)
--
-- Verify before running: PostgreSQL >= 13 for core gen_random_uuid(), and that
-- you may CREATE EXTENSION. If not, generate UUIDs in the app and drop the
-- extension lines plus the column defaults.
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;  -- gen_random_uuid() on PG < 13

-- ---------------------------------------------------------------------------
-- Identity — there is no table for it
--
-- The identifying claim in this realm is `upn` (an employee number such as
-- T1001001), not `sub`. Ownership columns hold it directly as text, exactly as
-- ../yanshuf3 does. No mirror table, no per-request resolution query.
--
-- An earlier draft had an `app_users` mirror keyed on uuid, purely to bridge the
-- Supabase UUIDs already sitting in user_sounds.user_id and
-- shared_sounds.owner_id. That bridge is now a one-time import step instead:
-- rewrite each user_id from its Supabase UUID to the matching upn, joining on
-- the email in the exported auth.users. Same information, done once and
-- verifiable with a query, rather than lazily on each first login.
--
-- The silent-orphan hazard does not disappear, it moves. A UUID mapped to the
-- wrong upn, or missed, means that user signs in and gets 9 freshly seeded
-- built-ins while their real board sits unreachable. Diff the emails first.
--
-- Normalise upn to uppercase ONCE, at the boundary, and never re-normalise.
-- Now that it is the stored key, inconsistent casing means rows that cannot be
-- found at all.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Audio assets — metadata only. The bytes live in S3.
--
-- Object keys are content-addressed:
--   sounds/<first 2 hex of sha256>/<full sha256 hex>.<ext>
-- which gives free deduplication, idempotent retries (re-PUTting identical
-- content is a no-op), and an ETag for the audio endpoint.
--
-- Fallback: if the S3 bucket turns out to be unavailable, replace object_key
-- with `data bytea` (plus `alter column data set storage external`). Nothing
-- else in this schema changes, and GET /api/shared-sounds/:id/audio does not
-- change either.
-- ---------------------------------------------------------------------------

create table sound_assets (
  id            uuid primary key default gen_random_uuid(),
  bucket        text    not null,
  object_key    text    not null,
  content_type  text    not null default 'audio/mpeg',
  byte_size     bigint  not null check (byte_size > 0),
  sha256        bytea   not null,
  original_name text,
  created_at    timestamptz not null default now(),

  unique (bucket, object_key)
);

-- Content-addressed, so the digest identifies the asset. Enables dedupe on
-- upload: hash first, select by sha256, reuse the row if it already exists.
create unique index sound_assets_sha256_idx on sound_assets (sha256);

-- ---------------------------------------------------------------------------
-- Community library: the shareable uploaded sound
-- ---------------------------------------------------------------------------

create table shared_sounds (
  id         uuid primary key default gen_random_uuid(),
  -- the Keycloak upn, uppercased. No table to reference, so no cascade either:
  -- deleting a user's content is an application concern.
  owner_id   text  not null,
  -- denormalised uploader label, captured at upload time for attribution
  owner_name text  not null default 'Anonymous',
  name       text  not null,
  asset_id   uuid  not null references sound_assets(id) on delete restrict,
  icon       text  not null default 'Volume2',
  color      text  not null default '#f97316',
  gain       double precision not null default 1,
  is_public  boolean not null default true,
  created_at timestamptz not null default now()
);

-- Serves: where is_public order by created_at desc
create index shared_sounds_public_created_idx
  on shared_sounds (is_public, created_at desc);
create index shared_sounds_owner_idx on shared_sounds (owner_id);
create index shared_sounds_asset_idx on shared_sounds (asset_id);

-- ---------------------------------------------------------------------------
-- The board: one row per pad
-- ---------------------------------------------------------------------------

create table user_sounds (
  id              uuid not null primary key default gen_random_uuid(),
  user_id         text not null,
  -- built-in id from packages/shared builtinSounds (e.g. 'vine-boom')
  sound_id        text,
  -- set when the pad points at the shared library
  shared_sound_id uuid references shared_sounds(id) on delete cascade,
  name            text    not null,
  color           text    not null default '#f97316',
  icon            text    not null default 'Volume2',
  gain            double precision not null default 1,
  position        integer not null default 0,
  created_at      timestamptz not null default now(),

  -- a pad must resolve to exactly one source
  constraint sound_source_check check (
    (sound_id is not null and shared_sound_id is null) or
    (sound_id is null     and shared_sound_id is not null)
  )
);

-- Serves the only board read: where user_id = $1 order by position
create index user_sounds_user_position_idx on user_sounds (user_id, position);

-- ---------------------------------------------------------------------------
-- The board read, as one statement.
--
-- Replaces PostgREST's embedded join
--   .select('*, shared_sound:shared_sounds(*)')
-- frontend/src/lib/useUserSounds.ts reads row.shared_sound?.<field>, so the joined
-- columns must be re-nested into an object, not flattened.
--
-- Note it deliberately exposes neither asset_id nor any URL. The client builds
-- /api/shared-sounds/<id>/audio from the shared sound's id.
-- ---------------------------------------------------------------------------

-- select us.id, us.user_id, us.sound_id, us.shared_sound_id, us.name,
--        us.color, us.icon, us.gain, us.position, us.created_at,
--        case when ss.id is null then null else jsonb_build_object(
--          'id',         ss.id,
--          'owner_id',   ss.owner_id,
--          'owner_name', ss.owner_name,
--          'name',       ss.name,
--          'icon',       ss.icon,
--          'color',      ss.color,
--          'gain',       ss.gain,
--          'is_public',  ss.is_public,
--          'created_at', ss.created_at
--        ) end as shared_sound
--   from user_sounds us
--   left join shared_sounds ss on ss.id = us.shared_sound_id
--  where us.user_id = $1
--  order by us.position;

-- ---------------------------------------------------------------------------
-- Reorder in one statement, replacing the two racing UPDATEs in moveSound.
-- $1 = user_id, $2 = uuid[] of pad ids in their new order.
-- The user_id predicate is what stops a caller reordering someone else's board.
-- ---------------------------------------------------------------------------

-- update user_sounds us
--    set position = new_order.pos - 1
--   from unnest($2::uuid[]) with ordinality as new_order(id, pos)
--  where us.id = new_order.id
--    and us.user_id = $1;

-- ---------------------------------------------------------------------------
-- Orphan reconciliation.
--
-- S3 and PostgreSQL cannot share a transaction, so uploads write S3 first and
-- the database second. A failure between the two leaves an object with no row.
-- Run periodically: list the bucket, and for each key check this query. Delete
-- objects that are unreferenced AND older than a grace period long enough to
-- exclude an upload currently in flight.
-- ---------------------------------------------------------------------------

-- select 1 from sound_assets where bucket = $1 and object_key = $2;

-- Assets no longer referenced by any shared sound (safe to delete from S3
-- after deleting the row):
-- select sa.id, sa.bucket, sa.object_key
--   from sound_assets sa
--   left join shared_sounds ss on ss.asset_id = sa.id
--  where ss.id is null
--    and sa.created_at < now() - interval '1 day';

-- ---------------------------------------------------------------------------
-- NOT INCLUDED, deliberately:
--
--   * RLS policies. Ownership is enforced in the API layer, which is required
--     anyway because the client cannot be trusted to send its own user_id.
--     If you connect as a non-superuser role and want defence in depth, RLS can
--     be layered on — but it needs a per-transaction
--     `set local request.jwt.claim.sub` and a locally defined auth.uid().
--     See docs/backend-portability.md for that variant.
--   * password_hash / app_sessions. Keycloak owns credentials, and the session
--     lives in the httpOnly cookie set by our own /auth/callback route. See
--     docs/target-architecture.md.
--   * Keycloak role columns. yanshuf3 uses realm/client roles for two coarse
--     gates only and computes everything finer in the database; Soundboard needs
--     no roles at all, just an ownership check per mutation.
--   * Any Supabase construct: auth.users, auth.uid(), storage.buckets,
--     storage.objects, storage.foldername().
-- ---------------------------------------------------------------------------
