import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase, type UserSound } from './supabase';
import { SOUNDS } from './sounds';
import { useAuth } from './useAuth';

export type BoardSound = {
	dbId: string;
	id: string;
	name: string;
	audio_path: string;
	image_path?: string | null;
	icon?: string | null;
	color: string;
	gain: number;
	position: number;
};

export const soundKeys = {
	all: (userId: string) => ['user_sounds', userId] as const,
};

function userSoundToBoard(row: UserSound): BoardSound {
	const builtin = row.sound_id ? SOUNDS.find((s) => s.id === row.sound_id) : null;
	return {
		dbId: row.id,
		id: row.sound_id ?? row.id,
		name: row.name,
		// The two legacy fallbacks keep pre-migration pads audible; db/migrations/0002
		// converts them to built-in sound_ids, after which only the first branch is hit.
		audio_path: builtin?.audio_path ?? row.shared_sound?.file_url ?? row.custom_file_url ?? '',
		image_path: builtin?.image_path ?? null,
		icon: row.icon,
		color: row.color,
		gain: row.gain,
		position: row.position,
	};
}

async function fetchUserSounds(userId: string): Promise<BoardSound[]> {
	const { data, error } = await supabase
		.from('user_sounds')
		.select('*, shared_sound:shared_sounds(*)')
		.eq('user_id', userId)
		.order('position', { ascending: true });

	if (error) throw new Error(error.message);

	const rows = data as UserSound[];
	if (rows.length > 0) return rows.map(userSoundToBoard);

	const seededRows = SOUNDS.map((sound, index) => ({
		user_id: userId,
		sound_id: sound.id,
		name: sound.name,
		color: sound.color ?? '#f97316',
		icon: sound.icon ?? 'Volume2',
		gain: sound.gain ?? 1,
		position: index,
	}));

	const { data: inserted, error: insertError } = await supabase.from('user_sounds').insert(seededRows).select('*');

	if (insertError) throw new Error(insertError.message);
	return (inserted as UserSound[]).map(userSoundToBoard);
}

export function useUserSounds() {
	const { user } = useAuth();
	const qc = useQueryClient();

	const {
		data: sounds = [],
		isLoading: loading,
		error: queryError,
	} = useQuery({
		queryKey: soundKeys.all(user?.id ?? ''),
		queryFn: () => fetchUserSounds(user!.id),
		enabled: Boolean(user),
	});

	const error = queryError ? (queryError as Error).message : null;

	const invalidate = () => qc.invalidateQueries({ queryKey: soundKeys.all(user?.id ?? '') });

	const addBuiltinMutation = useMutation({
		mutationFn: async (soundId: string) => {
			if (!user) throw new Error('Not authenticated');
			const builtin = SOUNDS.find((s) => s.id === soundId);
			if (!builtin) throw new Error(`Unknown sound: ${soundId}`);

			const { error } = await supabase.from('user_sounds').insert({
				user_id: user.id,
				sound_id: soundId,
				name: builtin.name,
				color: builtin.color ?? '#f97316',
				icon: builtin.icon ?? 'Volume2',
				gain: builtin.gain ?? 1,
				position: sounds.length,
			});
			if (error) throw new Error(error.message);
		},
		onSuccess: invalidate,
	});

	const removeMutation = useMutation({
		mutationFn: async (dbId: string) => {
			const { error } = await supabase.from('user_sounds').delete().eq('id', dbId);
			if (error) throw new Error(error.message);
		},
		onMutate: async (dbId) => {
			await qc.cancelQueries({ queryKey: soundKeys.all(user?.id ?? '') });
			const previous = qc.getQueryData<BoardSound[]>(soundKeys.all(user?.id ?? ''));
			qc.setQueryData<BoardSound[]>(soundKeys.all(user?.id ?? ''), (old = []) => old.filter((s) => s.dbId !== dbId));
			return { previous };
		},
		onError: (_err, _dbId, ctx) => {
			if (ctx?.previous) qc.setQueryData(soundKeys.all(user?.id ?? ''), ctx.previous);
		},
		onSettled: invalidate,
	});

	const moveMutation = useMutation({
		mutationFn: async ({ dbId, direction }: { dbId: string; direction: 'left' | 'right' }) => {
			const index = sounds.findIndex((s) => s.dbId === dbId);
			const swapIndex = direction === 'left' ? index - 1 : index + 1;
			if (swapIndex < 0 || swapIndex >= sounds.length) return;

			const a = sounds[index];
			const b = sounds[swapIndex];

			await Promise.all([
				supabase.from('user_sounds').update({ position: b.position }).eq('id', a.dbId),
				supabase.from('user_sounds').update({ position: a.position }).eq('id', b.dbId),
			]);
		},
		onMutate: async ({ dbId, direction }) => {
			await qc.cancelQueries({ queryKey: soundKeys.all(user?.id ?? '') });
			const previous = qc.getQueryData<BoardSound[]>(soundKeys.all(user?.id ?? ''));

			qc.setQueryData<BoardSound[]>(soundKeys.all(user?.id ?? ''), (old = []) => {
				const next = [...old];
				const index = next.findIndex((s) => s.dbId === dbId);
				const swapIndex = direction === 'left' ? index - 1 : index + 1;
				if (swapIndex < 0 || swapIndex >= next.length) return old;
				const a = next[index];
				const b = next[swapIndex];
				next[index] = { ...b, position: a.position };
				next[swapIndex] = { ...a, position: b.position };
				return next;
			});

			return { previous };
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.previous) qc.setQueryData(soundKeys.all(user?.id ?? ''), ctx.previous);
		},
		onSettled: invalidate,
	});

	const updateGainMutation = useMutation({
		mutationFn: async ({ dbId, gain }: { dbId: string; gain: number }) => {
			const { error } = await supabase.from('user_sounds').update({ gain }).eq('id', dbId);
			if (error) throw new Error(error.message);
		},
		onMutate: async ({ dbId, gain }) => {
			await qc.cancelQueries({ queryKey: soundKeys.all(user?.id ?? '') });
			const previous = qc.getQueryData<BoardSound[]>(soundKeys.all(user?.id ?? ''));
			qc.setQueryData<BoardSound[]>(soundKeys.all(user?.id ?? ''), (old = []) => old.map((s) => (s.dbId === dbId ? { ...s, gain } : s)));
			return { previous };
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.previous) qc.setQueryData(soundKeys.all(user?.id ?? ''), ctx.previous);
		},
	});

	return {
		sounds,
		loading,
		error,

		addBuiltinSound: (soundId: string) => addBuiltinMutation.mutateAsync(soundId),

		// Parked: Supabase Storage is gone and the S3 upload route lands in phase 6.
		addCustomSound: async () => {
			throw new Error('Uploads are temporarily unavailable while storage is being migrated.');
		},

		removeSound: (dbId: string) => removeMutation.mutate(dbId),

		moveSound: (dbId: string, direction: 'left' | 'right') => moveMutation.mutate({ dbId, direction }),

		updateGain: (dbId: string, gain: number) => updateGainMutation.mutate({ dbId, gain }),

		refetch: () => invalidate(),
	};
}
