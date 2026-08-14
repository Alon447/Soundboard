import { useCallback, useEffect, useState } from 'react';
import { supabase, type UserSound } from './supabase';
import { SOUNDS } from './sounds';
import { useAuth } from './useAuth';

export type BoardSound = {
  // The row id in user_sounds
  dbId: string;
  // The id used for playback / keybinding
  id: string;
  name: string;
  audio_path: string;
  image_path?: string | null;
  icon?: string | null;
  color: string;
  gain: number;
  position: number;
};

function userSoundToBoard(row: UserSound): BoardSound {
  // If it references a built-in sound, merge in the built-in audio_path
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

export function useUserSounds() {
  const { user } = useAuth();
  const [sounds, setSounds] = useState<BoardSound[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSounds = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);

    const { data, error } = await supabase
      .from('user_sounds')
      .select('*')
      .eq('user_id', user.id)
      .order('position', { ascending: true });

    if (error) {
      setError(error.message);
    } else {
      setSounds((data as UserSound[]).map(userSoundToBoard));
    }

    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchSounds();
  }, [fetchSounds]);

  // Add a built-in sound to the user's board
  const addBuiltinSound = useCallback(async (soundId: string) => {
    if (!user) return;

    const builtin = SOUNDS.find((s) => s.id === soundId);
    if (!builtin) return;

    const position = sounds.length;

    const { error } = await supabase.from('user_sounds').insert({
      user_id: user.id,
      sound_id: soundId,
      name: builtin.name,
      color: builtin.color ?? '#f97316',
      icon: builtin.icon ?? 'Volume2',
      gain: builtin.gain ?? 1,
      position,
    });

    if (error) {
      setError(error.message);
    } else {
      await fetchSounds();
    }
  }, [user, sounds.length, fetchSounds]);

  // Add a user-uploaded sound
  const addCustomSound = useCallback(async (file: File, name: string, color: string, icon: string) => {
    if (!user) return;

    // Upload file to storage under user's folder
    const ext = file.name.split('.').pop();
    const filePath = `${user.id}/${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('sounds')
      .upload(filePath, file, { upsert: false });

    if (uploadError) {
      setError(uploadError.message);
      return;
    }

    // Get a signed URL valid for 10 years (effectively permanent for our use)
    const { data: signedData, error: signedError } = await supabase.storage
      .from('sounds')
      .createSignedUrl(filePath, 60 * 60 * 24 * 365 * 10);

    if (signedError || !signedData?.signedUrl) {
      setError(signedError?.message ?? 'Failed to get file URL');
      return;
    }

    const position = sounds.length;

    const { error: insertError } = await supabase.from('user_sounds').insert({
      user_id: user.id,
      sound_id: null,
      custom_file_url: signedData.signedUrl,
      name,
      color,
      icon,
      gain: 1,
      position,
    });

    if (insertError) {
      setError(insertError.message);
    } else {
      await fetchSounds();
    }
  }, [user, sounds.length, fetchSounds]);

  // Remove a sound from the board
  const removeSound = useCallback(async (dbId: string) => {
    const { error } = await supabase.from('user_sounds').delete().eq('id', dbId);
    if (error) {
      setError(error.message);
    } else {
      setSounds((prev) => prev.filter((s) => s.dbId !== dbId));
    }
  }, []);

  // Reorder — swap two positions
  const moveSound = useCallback(async (dbId: string, direction: 'left' | 'right') => {
    const index = sounds.findIndex((s) => s.dbId === dbId);
    const swapIndex = direction === 'left' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= sounds.length) return;

    const a = sounds[index];
    const b = sounds[swapIndex];

    // Optimistic update
    const next = [...sounds];
    next[index] = { ...b, position: a.position };
    next[swapIndex] = { ...a, position: b.position };
    setSounds(next);

    // Persist both rows
    await Promise.all([
      supabase.from('user_sounds').update({ position: b.position }).eq('id', a.dbId),
      supabase.from('user_sounds').update({ position: a.position }).eq('id', b.dbId),
    ]);
  }, [sounds]);

  return { sounds, loading, error, addBuiltinSound, addCustomSound, removeSound, moveSound, refetch: fetchSounds };
}
