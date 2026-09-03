import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

// Set in .env (see .env.example). Expo inlines EXPO_PUBLIC_* variables at bundle time.
export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_KEY = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';

/** False until .env is filled in; App.tsx then shows setup instructions instead of crashing. */
export const isSupabaseConfigured = SUPABASE_URL.startsWith('http') && SUPABASE_KEY.length > 0;

export const supabase = createClient(
  isSupabaseConfigured ? SUPABASE_URL : 'https://not-configured.supabase.co',
  isSupabaseConfigured ? SUPABASE_KEY : 'not-configured',
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  }
);

// Refresh the session only while the app is in the foreground (official Supabase pattern).
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
