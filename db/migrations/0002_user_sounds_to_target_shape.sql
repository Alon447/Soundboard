-- Brings the EXISTING Supabase user_sounds table to the shape 0001_init.sql creates from
-- scratch. 0001 is the fresh-database path (closed environment); this is the in-place path
-- for the Supabase database that already holds live rows. Both converge on the same shape.
--
-- DESTRUCTIVE. Review, back up, then run it manually. It aborts rather than losing a pad.

begin;

-- The 6 former uploads now ship as built-ins at /sounds/custom-N.mp3. Match them by the
-- Date.now() stamp the app put in shared_sounds.storage_path when they were uploaded.
update user_sounds us
   set sound_id = m.builtin_id,
       shared_sound_id = null
  from (values
         ('1786794734357', 'custom-1'),
         ('1786865046883', 'custom-2'),
         ('1786865187320', 'custom-3'),
         ('1786865912814', 'custom-4'),
         ('1786964718458', 'custom-5'),
         ('1787581675154', 'custom-6')
       ) as m(stamp, builtin_id),
       shared_sounds ss
 where us.shared_sound_id = ss.id
   and ss.storage_path like '%' || m.stamp || '%';

-- Stop if any pad still resolves through a column this migration is about to remove.
-- Rows backfilled by 20260815120000_shared_sounds.sql have storage_path = null and so
-- cannot be matched above; they need mapping by hand before this can proceed.
do $$
declare
	stranded int;
begin
	select count(*) into stranded
	  from user_sounds
	 where shared_sound_id is not null
	    or (sound_id is null and custom_file_url is not null);

	if stranded > 0 then
		raise exception
			'Aborting: % pad(s) still resolve through shared_sounds or custom_file_url. Map them to a built-in sound_id first.',
			stranded;
	end if;
end $$;

-- auth.uid() is uuid, so the policy and the foreign key both block the type change.
drop policy "Users manage their own sounds" on user_sounds;
alter table user_sounds drop constraint sound_source_check;
alter table user_sounds drop constraint user_sounds_user_id_fkey;

alter table user_sounds
	alter column user_id type text using user_id::text,
	alter column gain type double precision using gain::double precision,
	drop column custom_file_url;

-- Recreated with a cast: the frontend still reads through PostgREST until it moves to
-- /api/user-sounds, and RLS with no policy denies everything.
create policy "Users manage their own sounds"
	on user_sounds
	for all
	using (auth.uid()::text = user_id)
	with check (auth.uid()::text = user_id);

alter table user_sounds add constraint sound_source_check check (
	(sound_id is not null and shared_sound_id is null) or
	(sound_id is null     and shared_sound_id is not null)
);

create index if not exists user_sounds_user_position_idx on user_sounds (user_id, position);

commit;
