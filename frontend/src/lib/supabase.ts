import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
	throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type UserSound = {
	id: string;
	user_id: string;
	// a built-in sound id, e.g. "vine-boom"
	sound_id: string | null;
	name: string;
	color: string;
	icon: string;
	gain: number;
	position: number;
	created_at: string;
	// Legacy audio sources, both removed by db/migrations/0002. Read only as a fallback
	// so pads stay audible until that migration has run.
	custom_file_url?: string | null;
	shared_sound?: { file_url: string } | null;
};
