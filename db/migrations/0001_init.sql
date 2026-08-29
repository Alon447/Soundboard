create extension if not exists pgcrypto;

create table sound_assets (
	id            uuid primary key default gen_random_uuid(),
	bucket        text   not null,
	object_key    text   not null,
	content_type  text   not null default 'audio/mpeg',
	byte_size     bigint not null check (byte_size > 0),
	sha256        bytea  not null,
	original_name text,
	created_at    timestamptz not null default now(),

	unique (bucket, object_key)
);

create unique index sound_assets_sha256_idx on sound_assets (sha256);

create table shared_sounds (
	id         uuid    not null primary key default gen_random_uuid(),
	-- The identity claim itself. There is no users table, so nothing to reference.
	owner_id   text    not null,
	owner_name text    not null default 'Anonymous',
	name       text    not null,
	asset_id   uuid    not null references sound_assets(id) on delete restrict,
	icon       text    not null default 'Volume2',
	color      text    not null default '#f97316',
	-- Not numeric: node-postgres returns numeric as a string.
	gain       double precision not null default 1,
	is_public  boolean not null default true,
	created_at timestamptz not null default now()
);

create index shared_sounds_public_created_idx on shared_sounds (is_public, created_at desc);
create index shared_sounds_owner_idx on shared_sounds (owner_id);
create index shared_sounds_asset_idx on shared_sounds (asset_id);

create table user_sounds (
	id              uuid    not null primary key default gen_random_uuid(),
	user_id         text    not null,
	sound_id        text,
	shared_sound_id uuid references shared_sounds(id) on delete cascade,
	name            text    not null,
	color           text    not null default '#f97316',
	icon            text    not null default 'Volume2',
	gain            double precision not null default 1,
	position        integer not null default 0,
	created_at      timestamptz not null default now(),

	constraint sound_source_check check (
		(sound_id is not null and shared_sound_id is null) or
		(sound_id is null     and shared_sound_id is not null)
	)
);

create index user_sounds_user_position_idx on user_sounds (user_id, position);
