-- Create user_sounds table
create table user_sounds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  -- null = built-in sound, value = the id from the built-in library (e.g. "vine-boom")
  sound_id text,
  -- only set when the user uploaded their own file
  custom_file_url text,
  name text not null,
  color text not null default '#f97316',
  icon text not null default 'Volume2',
  gain numeric not null default 1,
  -- order of the pad on the board (0-indexed)
  position integer not null default 0,
  created_at timestamptz not null default now(),

  -- a sound must either reference a built-in sound or have a custom file
  constraint sound_source_check check (
    (sound_id is not null) or (custom_file_url is not null)
  )
);

-- Enable Row Level Security
alter table user_sounds enable row level security;

-- Users can only read, insert, update, and delete their own rows
create policy "Users manage their own sounds"
  on user_sounds
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Storage bucket for user-uploaded audio files
insert into storage.buckets (id, name, public)
values ('sounds', 'sounds', false);

-- Users can only manage files under their own user-id folder
-- e.g. storage path: <user_id>/my-sound.mp3
create policy "Users manage their own sound files"
  on storage.objects
  for all
  using (
    bucket_id = 'sounds'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'sounds'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
