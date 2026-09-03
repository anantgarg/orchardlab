import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Recipe } from '../lib/media';
import { supabase } from '../lib/supabase';

type Props = {
  /** Open a recipe; `startCapture` jumps straight to the camera/voice screen. */
  onOpen: (recipe: Recipe, startCapture: boolean) => void;
};

const COLUMNS = 'id, user_id, title, created_at';

export default function RecipeListScreen({ onOpen }: Props) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('recipes')
      .select(COLUMNS)
      .order('created_at', { ascending: false });
    if (error) Alert.alert('Could not load recipes', error.message);
    else setRecipes(data as Recipe[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function addRecipe() {
    const t = title.trim();
    if (!t || adding) return;
    setAdding(true);
    const { data, error } = await supabase
      .from('recipes')
      .insert({ title: t })
      .select(COLUMNS)
      .single();
    setAdding(false);
    if (error) {
      Alert.alert('Could not add recipe', error.message);
      return;
    }
    const recipe = data as Recipe;
    setTitle('');
    setRecipes((prev) => [recipe, ...prev]);
    onOpen(recipe, true);
  }

  const canAdd = title.trim().length > 0 && !adding;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <Text style={styles.title}>Recipes</Text>
        <Pressable onPress={() => supabase.auth.signOut()} hitSlop={8}>
          <Text style={styles.link}>Log out</Text>
        </Pressable>
      </View>

      <View style={styles.addRow}>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="New recipe title"
          placeholderTextColor="#999"
          returnKeyType="done"
          onSubmitEditing={addRecipe}
          editable={!adding}
        />
        <Pressable
          style={[styles.addButton, !canAdd && styles.addButtonDim]}
          onPress={addRecipe}
          disabled={!canAdd}
        >
          {adding ? <ActivityIndicator color="#fff" /> : <Text style={styles.addButtonText}>Add</Text>}
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator style={styles.spinner} />
      ) : (
        <FlatList
          data={recipes}
          keyExtractor={(r) => r.id}
          onRefresh={refresh}
          refreshing={refreshing}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            <Text style={styles.empty}>No recipes yet. Type a title above to start one.</Text>
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => onOpen(item, false)}
            >
              <Text style={styles.rowTitle} numberOfLines={2}>
                {item.title}
              </Text>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  title: { fontSize: 28, fontWeight: '700', color: '#111' },
  link: { color: '#e8590c', fontSize: 15 },
  addRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingBottom: 12 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 17,
    color: '#111',
  },
  addButton: {
    backgroundColor: '#e8590c',
    borderRadius: 10,
    paddingHorizontal: 18,
    justifyContent: 'center',
    minWidth: 64,
    alignItems: 'center',
  },
  addButtonDim: { opacity: 0.4 },
  addButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  spinner: { marginTop: 32 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: '#ddd', marginLeft: 20 },
  empty: { color: '#777', fontSize: 16, textAlign: 'center', marginTop: 48, paddingHorizontal: 32 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  rowPressed: { backgroundColor: '#f6f6f6' },
  rowTitle: { flex: 1, fontSize: 18, color: '#111' },
  chevron: { fontSize: 24, color: '#bbb', marginLeft: 12 },
});
