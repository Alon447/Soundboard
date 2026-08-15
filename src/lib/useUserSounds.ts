import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase, type UserSound } from './supabase';
import { SOUNDS } from './sounds';
import { useAuth } from './useAuth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BoardSound = {
  dbId: string;       // user_sounds.id (UUID) — used for DB ops
  id: string;         // sound_id for builtins, dbId for custom — used for keybinding / activeId
  name: string;
  audio_path: string; // resolved: built-in path or Supabase signed URL
  image_path?: string | null;
  icon?: string | null;
  color: string;
  gain: number;
  position: number;
};

// ---------------------------------------------------------------------------
// Query key factory — single source of truth for cache keys
// ---------------------------------------------------------------------------

export const soundKeys = {
  all: (userId: string) => ['user_sounds', userId] as const,
};

// ---------------------------------------------------------------------------
// Row → BoardSound mapper
// ---------------------------------------------------------------------------

function userSoundToBoard(row: UserSound): BoardSound {
  const builtin = row.sound_id ? SOUNDS.find((s) => s.id === row.sound_id) : null;
  return {
    dbId: row.id,
    id: row.sound_id ?? row.id,
    name: row.name,
    audio_path: builtin?.audio_path ?? row.custom_file_url ?? '',
    image_path: builtin?.image_path ?? null,
    icon: row.icon,
    color: row.color,
    gain: row.gain,
    position: row.position,
  };
}

// ---------------------------------------------------------------------------
// Fetcher (used by useQuery)
// ---------------------------------------------------------------------------

async function fetchUserSounds(userId: string): Promise<BoardSound[]> {
  const { data, error } = await supabase
    .from('user_sounds')
    .select('*')
    .eq('user_id', userId)
    .order('position', { ascending: true });

  if (error) throw new Error(error.message);
  return (data as UserSound[]).map(userSoundToBoard);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useUserSounds() {
  const { user } = useAuth();
  const qc = useQueryClient();

  // ---- Query ---------------------------------------------------------------

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

  // Helper to invalidate the sounds list after a write
  const invalidate = () => qc.invalidateQueries({ queryKey: soundKeys.all(user?.id ?? '') });

  // ---- Add built-in --------------------------------------------------------

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

  // ---- Add custom (upload + insert) ----------------------------------------

  const addCustomMutation = useMutation({
    mutationFn: async ({
      file,
      name,
      color,
      icon,
    }: {
      file: File;
      name: string;
      color: string;
      icon: string;
    }) => {
      if (!user) throw new Error('Not authenticated');

      const ext = file.name.split('.').pop();
      const filePath = `${user.id}/${Date.now()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from('sounds')
        .upload(filePath, file, { upsert: false });
      if (uploadError) throw new Error(uploadError.message);

      const { data: signedData, error: signedError } = await supabase.storage
        .from('sounds')
        .createSignedUrl(filePath, 60 * 60 * 24 * 365 * 10);
      if (signedError || !signedData?.signedUrl)
        throw new Error(signedError?.message ?? 'Failed to get file URL');

      const { error: insertError } = await supabase.from('user_sounds').insert({
        user_id: user.id,
        sound_id: null,
        custom_file_url: signedData.signedUrl,
        name,
        color,
        icon,
        gain: 1,
        position: sounds.length,
      });
      if (insertError) throw new Error(insertError.message);
    },
    onSuccess: invalidate,
  });

  // ---- Remove --------------------------------------------------------------

  const removeMutation = useMutation({
    mutationFn: async (dbId: string) => {
      const { error } = await supabase.from('user_sounds').delete().eq('id', dbId);
      if (error) throw new Error(error.message);
    },
    // Optimistic: remove from cache immediately, restore on error
    onMutate: async (dbId) => {
      await qc.cancelQueries({ queryKey: soundKeys.all(user?.id ?? '') });
      const previous = qc.getQueryData<BoardSound[]>(soundKeys.all(user?.id ?? ''));
      qc.setQueryData<BoardSound[]>(
        soundKeys.all(user?.id ?? ''),
        (old = []) => old.filter((s) => s.dbId !== dbId),
      );
      return { previous };
    },
    onError: (_err, _dbId, ctx) => {
      if (ctx?.previous)
        qc.setQueryData(soundKeys.all(user?.id ?? ''), ctx.previous);
    },
    onSettled: invalidate,
  });

  // ---- Move (swap positions) -----------------------------------------------

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
    // Optimistic swap
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
      if (ctx?.previous)
        qc.setQueryData(soundKeys.all(user?.id ?? ''), ctx.previous);
    },
    onSettled: invalidate,
  });

  // ---- Update gain ---------------------------------------------------------

  const updateGainMutation = useMutation({
    mutationFn: async ({ dbId, gain }: { dbId: string; gain: number }) => {
      const { error } = await supabase
        .from('user_sounds')
        .update({ gain })
        .eq('id', dbId);
      if (error) throw new Error(error.message);
    },
    // Optimistic: update gain in cache immediately
    onMutate: async ({ dbId, gain }) => {
      await qc.cancelQueries({ queryKey: soundKeys.all(user?.id ?? '') });
      const previous = qc.getQueryData<BoardSound[]>(soundKeys.all(user?.id ?? ''));
      qc.setQueryData<BoardSound[]>(
        soundKeys.all(user?.id ?? ''),
        (old = []) => old.map((s) => (s.dbId === dbId ? { ...s, gain } : s)),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous)
        qc.setQueryData(soundKeys.all(user?.id ?? ''), ctx.previous);
    },
    // No invalidate needed — optimistic update is already the final state
  });

  // ---- Stable callsite API (same shape as before) --------------------------

  return {
    sounds,
    loading,
    error,

    addBuiltinSound: (soundId: string) => addBuiltinMutation.mutateAsync(soundId),

    addCustomSound: (file: File, name: string, color: string, icon: string) =>
      addCustomMutation.mutateAsync({ file, name, color, icon }),

    removeSound: (dbId: string) => removeMutation.mutate(dbId),

    moveSound: (dbId: string, direction: 'left' | 'right') =>
      moveMutation.mutate({ dbId, direction }),

    updateGain: (dbId: string, gain: number) =>
      updateGainMutation.mutate({ dbId, gain }),

    refetch: () => invalidate(),
  };
}
