import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ---- Types that mirror the database schema ----

export type UserSound = {
  id: string;
  user_id: string;
  // references a built-in sound id (e.g. "vine-boom"), null if custom upload
  sound_id: string | null;
  // public URL of a user-uploaded file, null if built-in
  custom_file_url: string | null;
  name: string;
  color: string;
  icon: string;
  gain: number;
  position: number;
  created_at: string;
};
