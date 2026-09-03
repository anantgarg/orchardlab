import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { formatDuration, formatTime, loadMedia, type MediaItem, type Recipe } from '../lib/media';
import { subscribe } from '../lib/upload';
import { errorMessage } from '../lib/util';

type Props = {
  recipe: Recipe;
  onBack: () => void;
  onCapture: () => void;
};

const KIND_LABEL = { audio: 'Voice note', photo: 'Photo', video: 'Video clip' } as const;

export default function RecipeDetailScreen({ recipe, onBack, onCapture }: Props) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(0);
  const [viewing, setViewing] = useState<MediaItem | null>(null);

  // One shared player serves every voice note in the list.
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await loadMedia(recipe.id));
    } catch (e) {
      Alert.alert('Could not load recordings', errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [recipe.id]);

  useEffect(() => {
    load();
    // Speaker playback (the capture screen switches the session into recording mode).
    setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
  }, [load]);

  // Show in-flight uploads and reload the list each time one finishes.
  const completedRef = useRef<number | null>(null);
  useEffect(
    () =>
      subscribe(({ pending: count, completed }) => {
        setPending(count);
        if (completedRef.current !== null && completed !== completedRef.current) load();
        completedRef.current = completed;
      }),
    [load]
  );

  useEffect(() => {
    if (status.didJustFinish) setPlayingId(null);
  }, [status.didJustFinish]);

  function stopAudio() {
    if (playingId) {
      player.pause();
      setPlayingId(null);
    }
  }

  function togglePlay(item: MediaItem) {
    if (playingId === item.id) {
      stopAudio();
      return;
    }
    if (!item.url) {
      Alert.alert('Not available', 'This recording has no playable link right now. Pull to refresh.');
      return;
    }
    player.replace({ uri: item.url });
    player.play();
    setPlayingId(item.id);
  }

  function openItem(item: MediaItem) {
    if (!item.url) {
      Alert.alert('Not available', 'This file has no link right now. Pull to refresh.');
      return;
    }
    stopAudio();
    setViewing(item);
  }

  function subtitle(item: MediaItem) {
    const parts = [formatTime(item.captured_at)];
    if (item.duration_seconds != null) parts.push(formatDuration(item.duration_seconds));
    if (item.audio_offset_seconds != null) {
      parts.push(`at ${formatDuration(item.audio_offset_seconds)} of voice note`);
    }
    return parts.join(' · ');
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>‹ Recipes</Text>
        </Pressable>
        <Text style={styles.pending}>{pending > 0 ? `Uploading ${pending}…` : ''}</Text>
      </View>
      <Text style={styles.title} numberOfLines={2}>
        {recipe.title}
      </Text>

      {loading ? (
        <ActivityIndicator style={styles.spinner} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(m) => m.id}
          onRefresh={load}
          refreshing={false}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            <Text style={styles.empty}>Nothing recorded yet. Tap Record below to start.</Text>
          }
          renderItem={({ item }) => (
            <View style={styles.row}>
              {item.kind === 'photo' ? (
                <Pressable onPress={() => openItem(item)}>
                  {item.url ? (
                    <Image source={{ uri: item.url }} style={styles.thumb} />
                  ) : (
                    <View style={[styles.thumb, styles.thumbMissing]} />
                  )}
                </Pressable>
              ) : (
                <View style={[styles.thumb, styles.iconBox]}>
                  <Text style={styles.icon}>{item.kind === 'audio' ? '🎙️' : '🎬'}</Text>
                </View>
              )}
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{KIND_LABEL[item.kind]}</Text>
                <Text style={styles.rowSub}>{subtitle(item)}</Text>
              </View>
              <Pressable
                style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
                onPress={() => (item.kind === 'audio' ? togglePlay(item) : openItem(item))}
              >
                <Text style={styles.actionText}>
                  {item.kind === 'audio' ? (playingId === item.id ? 'Stop' : 'Play') : item.kind === 'video' ? 'Play' : 'View'}
                </Text>
              </Pressable>
            </View>
          )}
        />
      )}

      <Pressable
        style={({ pressed }) => [styles.recordButton, pressed && styles.recordButtonPressed]}
        onPress={() => {
          stopAudio();
          onCapture();
        }}
      >
        <Text style={styles.recordButtonText}>● Record</Text>
      </Pressable>

      <Modal
        visible={viewing !== null}
        animationType="slide"
        onRequestClose={() => setViewing(null)}
      >
        <View style={styles.viewer}>
          {viewing?.kind === 'video' && viewing.url ? <VideoBody url={viewing.url} /> : null}
          {viewing?.kind === 'photo' && viewing.url ? (
            <Image source={{ uri: viewing.url }} style={styles.viewerImage} resizeMode="contain" />
          ) : null}
          <SafeAreaView style={styles.viewerBar} edges={['top']}>
            <Pressable onPress={() => setViewing(null)} hitSlop={12} style={styles.viewerClose}>
              <Text style={styles.viewerCloseText}>Close</Text>
            </Pressable>
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/** Mounted only while the viewer is open, so each clip gets a fresh player that is released on close. */
function VideoBody({ url }: { url: string }) {
  const videoPlayer = useVideoPlayer(url, (p) => {
    p.play();
  });
  return <VideoView player={videoPlayer} style={styles.viewerVideo} nativeControls contentFit="contain" />;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  back: { color: '#e8590c', fontSize: 17 },
  pending: { color: '#777', fontSize: 14 },
  title: { fontSize: 26, fontWeight: '700', color: '#111', paddingHorizontal: 20, paddingVertical: 12 },
  spinner: { marginTop: 32 },
  listContent: { flexGrow: 1 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: '#ddd', marginLeft: 20 },
  empty: { color: '#777', fontSize: 16, textAlign: 'center', marginTop: 48, paddingHorizontal: 32 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 10, gap: 12 },
  thumb: { width: 56, height: 56, borderRadius: 8, backgroundColor: '#eee' },
  thumbMissing: { backgroundColor: '#ddd' },
  iconBox: { alignItems: 'center', justifyContent: 'center' },
  icon: { fontSize: 26 },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 16, color: '#111', fontWeight: '600' },
  rowSub: { fontSize: 13, color: '#666', marginTop: 2 },
  action: {
    borderWidth: 1,
    borderColor: '#e8590c',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minWidth: 64,
    alignItems: 'center',
  },
  actionPressed: { backgroundColor: '#fff0e6' },
  actionText: { color: '#e8590c', fontSize: 15, fontWeight: '600' },
  recordButton: {
    margin: 20,
    backgroundColor: '#e8590c',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  recordButtonPressed: { opacity: 0.8 },
  recordButtonText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  viewer: { flex: 1, backgroundColor: '#000' },
  viewerImage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  viewerVideo: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  viewerBar: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'flex-end' },
  viewerClose: {
    margin: 12,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  viewerCloseText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
