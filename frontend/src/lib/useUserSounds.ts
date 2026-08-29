import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { SOUNDS } from './sounds';
import { useAuth } from './useAuth';

export type UserSound = {
	id: string;
	user_id: string;
	sound_id: string | null;
	shared_sound_id: string | null;
	name: string;
	color: string;
	icon: string;
	gain: number;
	position: number;
	created_at: string;
};

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
		// Empty for a pad still pointing at shared_sounds, which means db/migrations/0002
		// has not run: the API serves no audio URL and the pad is silent.
		audio_path: builtin?.audio_path ?? '',
		image_path: builtin?.image_path ?? null,
		icon: row.icon,
		color: row.color,
		gain: row.gain,
		position: row.position,
	};
}

const seedPads = () =>
	SOUNDS.map((sound) => ({
		sound_id: sound.id,
		name: sound.name,
		color: sound.color ?? '#f97316',
		icon: sound.icon ?? 'Volume2',
		gain: sound.gain ?? 1,
	}));

async function loadBoard(): Promise<BoardSound[]> {
	const rows = await api.get<UserSound[]>('/user-sounds');

	// The API has no built-in list, so it cannot seed. A first-time board is posted whole.
	const board = rows.length > 0 ? rows : await api.post<UserSound[]>('/user-sounds', seedPads());

	return board.map(userSoundToBoard);
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
		queryFn: loadBoard,
		enabled: Boolean(user),
	});

	const error = queryError ? (queryError as Error).message : null;

	const key = soundKeys.all(user?.id ?? '');
	const invalidate = () => qc.invalidateQueries({ queryKey: key });

	/** Snapshot the board so an optimistic mutation can roll back. */
	const snapshot = async () => {
		await qc.cancelQueries({ queryKey: key });
		return { previous: qc.getQueryData<BoardSound[]>(key) };
	};

	const rollback = (ctx: { previous?: BoardSound[] } | undefined) => {
		if (ctx?.previous) qc.setQueryData(key, ctx.previous);
	};

	const addBuiltinMutation = useMutation({
		mutationFn: async (soundId: string) => {
			const builtin = SOUNDS.find((s) => s.id === soundId);
			if (!builtin) throw new Error(`Unknown sound: ${soundId}`);

			await api.post('/user-sounds', [
				{
					sound_id: builtin.id,
					name: builtin.name,
					color: builtin.color ?? '#f97316',
					icon: builtin.icon ?? 'Volume2',
					gain: builtin.gain ?? 1,
				},
			]);
		},
		onSuccess: invalidate,
	});

	const removeMutation = useMutation({
		mutationFn: (dbId: string) => api.remove(`/user-sounds/${dbId}`),
		onMutate: async (dbId) => {
			const ctx = await snapshot();
			qc.setQueryData<BoardSound[]>(key, (old = []) => old.filter((s) => s.dbId !== dbId));
			return ctx;
		},
		onError: (_err, _dbId, ctx) => rollback(ctx),
		onSettled: invalidate,
	});

	const moveMutation = useMutation({
		mutationFn: async ({ dbId, direction }: { dbId: string; direction: 'left' | 'right' }) => {
			const index = sounds.findIndex((s) => s.dbId === dbId);
			const swapIndex = direction === 'left' ? index - 1 : index + 1;
			if (swapIndex < 0 || swapIndex >= sounds.length) return;

			// One transactional reorder, replacing the two racing UPDATEs this used to do.
			const order = sounds.map((s) => s.dbId);
			[order[index], order[swapIndex]] = [order[swapIndex], order[index]];
			await api.post('/user-sounds/reorder', { order });
		},
		onMutate: async ({ dbId, direction }) => {
			const ctx = await snapshot();

			qc.setQueryData<BoardSound[]>(key, (old = []) => {
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

			return ctx;
		},
		onError: (_err, _vars, ctx) => rollback(ctx),
		onSettled: invalidate,
	});

	const updateGainMutation = useMutation({
		mutationFn: ({ dbId, gain }: { dbId: string; gain: number }) =>
			api.patch(`/user-sounds/${dbId}`, { gain }),
		onMutate: async ({ dbId, gain }) => {
			const ctx = await snapshot();
			qc.setQueryData<BoardSound[]>(key, (old = []) =>
				old.map((s) => (s.dbId === dbId ? { ...s, gain } : s)),
			);
			return ctx;
		},
		onError: (_err, _vars, ctx) => rollback(ctx),
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

		moveSound: (dbId: string, direction: 'left' | 'right') =>
			moveMutation.mutate({ dbId, direction }),

		updateGain: (dbId: string, gain: number) => updateGainMutation.mutate({ dbId, gain }),
	};
}
