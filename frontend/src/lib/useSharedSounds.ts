import { useQuery } from '@tanstack/react-query';
import { supabase, type SharedSound } from './supabase';
import { useAuth } from './useAuth';

export const sharedSoundKeys = {
	all: ['shared_sounds'] as const,
};

async function fetchSharedSounds(): Promise<SharedSound[]> {
	const { data, error } = await supabase.from('shared_sounds').select('*').eq('is_public', true).order('created_at', { ascending: false });

	if (error) throw new Error(error.message);
	return data as SharedSound[];
}

// Browse the community library of shared uploads.
export function useSharedSounds() {
	const { user } = useAuth();

	const {
		data: sharedSounds = [],
		isLoading: loading,
		error: queryError,
	} = useQuery({
		queryKey: sharedSoundKeys.all,
		queryFn: fetchSharedSounds,
		enabled: Boolean(user),
	});

	return {
		sharedSounds,
		loading,
		error: queryError ? (queryError as Error).message : null,
	};
}
