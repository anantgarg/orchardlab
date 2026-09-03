import type { Session } from '@supabase/supabase-js';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { Recipe } from './lib/media';
import { isSupabaseConfigured, supabase } from './lib/supabase';
import AuthScreen from './screens/AuthScreen';
import CaptureScreen from './screens/CaptureScreen';
import RecipeDetailScreen from './screens/RecipeDetailScreen';
import RecipeListScreen from './screens/RecipeListScreen';

// The whole "navigation": which screen is showing, and for which recipe.
type Screen =
  | { name: 'list' }
  | { name: 'detail'; recipe: Recipe }
  | { name: 'capture'; recipe: Recipe };

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState<Screen>({ name: 'list' });

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) setScreen({ name: 'list' });
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Android hardware back pops one level. CaptureScreen owns its own back handling
  // (it must not be left while a recording is running), so it is not handled here.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen.name === 'detail') {
        setScreen({ name: 'list' });
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [screen]);

  let content;
  if (!isSupabaseConfigured) {
    content = <SetupMessage />;
  } else if (!ready) {
    content = (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  } else if (!session) {
    content = <AuthScreen />;
  } else if (screen.name === 'list') {
    content = (
      <RecipeListScreen
        onOpen={(recipe, startCapture) =>
          setScreen(startCapture ? { name: 'capture', recipe } : { name: 'detail', recipe })
        }
      />
    );
  } else if (screen.name === 'detail') {
    const recipe = screen.recipe;
    content = (
      <RecipeDetailScreen
        recipe={recipe}
        onBack={() => setScreen({ name: 'list' })}
        onCapture={() => setScreen({ name: 'capture', recipe })}
      />
    );
  } else {
    const recipe = screen.recipe;
    content = (
      <CaptureScreen recipe={recipe} onDone={() => setScreen({ name: 'detail', recipe })} />
    );
  }

  const onCamera = isSupabaseConfigured && !!session && screen.name === 'capture';

  return (
    <SafeAreaProvider>
      <StatusBar style={onCamera ? 'light' : 'dark'} />
      {content}
    </SafeAreaProvider>
  );
}

function SetupMessage() {
  return (
    <View style={styles.center}>
      <Text style={styles.setupTitle}>Supabase is not configured</Text>
      <Text style={styles.setupText}>
        Copy .env.example to .env, fill in EXPO_PUBLIC_SUPABASE_URL and
        EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY from your Supabase project, then restart the dev
        server. See README.md for the full setup.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: '#fff' },
  setupTitle: { fontSize: 20, fontWeight: '700', color: '#111', marginBottom: 12 },
  setupText: { fontSize: 16, color: '#444', textAlign: 'center', lineHeight: 22 },
});
