-- Shareable sound library: split the uploaded asset from a user's board pad.
-- A shared_sounds row is the canonical uploaded sound, browsable by all users.

create table shared_sounds (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade not null,
  -- denormalized uploader label for attribution (email or display name at upload time)
  owner_name text not null default 'Anonymous',
  name text not null,
  -- storage object path (null for rows backfilled from legacy signed URLs)
  storage_path text,
  -- long-lived signed URL; signed URLs are readable cross-user regardless of RLS
  file_url text not null,
  icon text not null default 'Volume2',
  color text not null default '#f97316',
  gain numeric not null default 1,
  is_public boolean not null default true,
  created_at timestamptz not null default now()
);

alter table shared_sounds enable row level security;

create policy "Anyone can read public shared sounds"
  on shared_sounds
  for select
  using (is_public = true or auth.uid() = owner_id);

create policy "Owners insert their shared sounds"
  on shared_sounds
  for insert
  with check (auth.uid() = owner_id);

create policy "Owners update their shared sounds"
  on shared_sounds
  for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "Owners delete their shared sounds"
  on shared_sounds
  for delete
  using (auth.uid() = owner_id);

-- A board pad may now reference a shared sound (in addition to built-in / own upload).
alter table user_sounds
  add column shared_sound_id uuid references shared_sounds(id) on delete set null;

-- Backfill: promote every existing custom upload into the shared library and
-- link the originating board row to its new shared_sounds row.
with inserted as (
  insert into shared_sounds (owner_id, owner_name, name, file_url, icon, color, gain)
  select
    us.user_id,
    coalesce(u.raw_user_meta_data->>'name', u.email, 'Anonymous'),
    us.name,
    us.custom_file_url,
    us.icon,
    us.color,
    us.gain
  from user_sounds us
  join auth.users u on u.id = us.user_id
  where us.custom_file_url is not null
  returning id, owner_id, file_url
)
update user_sounds us
set shared_sound_id = inserted.id
from inserted
where us.user_id = inserted.owner_id
  and us.custom_file_url = inserted.file_url;

-- Allow a third valid source: a reference to a shared sound.
alter table user_sounds drop constraint sound_source_check;
alter table user_sounds add constraint sound_source_check check (
  (sound_id is not null) or (custom_file_url is not null) or (shared_sound_id is not null)
);
