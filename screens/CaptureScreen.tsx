import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { CameraView, useCameraPermissions, type CameraMode } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fileInfo, formatDuration, type Recipe } from '../lib/media';
import { enqueue, subscribe } from '../lib/upload';
import { delay, errorMessage, withTimeout } from '../lib/util';

// Clips stay under Supabase's 50 MB per-file limit (Free plan) at 720p / 2.5 Mbps.
const CLIP_MAX_SECONDS = 120;
const CLIP_MAX_BYTES = 45_000_000;
// iOS does not fire onCameraReady after a picture/video mode change; Android does.
const MODE_SWITCH_FALLBACK_MS = 500;

type VoiceState = 'idle' | 'recording' | 'paused' | 'saving';
type ClipState = 'idle' | 'starting' | 'recording' | 'stopping';

type Props = {
  recipe: Recipe;
  onDone: () => void;
};

/**
 * Full-screen camera with three independent capture controls:
 * - a voice note (start / pause / resume / stop & save) — the only thing using the microphone;
 * - a photo shutter;
 * - a video clip toggle (recorded without sound so the voice note keeps running).
 * Photos and clips remember where in the voice note they were captured.
 */
export default function CaptureScreen({ recipe, onDone }: Props) {
  const insets = useSafeAreaInsets();
  const [camPermission, requestCamPermission] = useCameraPermissions();
  const [micGranted, setMicGranted] = useState<boolean | null>(null);

  const cameraRef = useRef<CameraView>(null);
  const [mode, setMode] = useState<CameraMode>('picture');
  const modeRef = useRef<CameraMode>('picture'); // mode as of the last switch, safe to read from stale closures
  const [cameraReady, setCameraReady] = useState(false);
  const readyResolver = useRef<(() => void) | null>(null);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 250);
  const [voice, setVoice] = useState<VoiceState>('idle');
  const voiceRef = useRef<VoiceState>('idle');
  const sessionId = useRef<string | null>(null);
  const voiceStartedAt = useRef<Date | null>(null);

  const [clip, setClip] = useState<ClipState>('idle');
  const clipStartedAt = useRef<Date | null>(null);
  const clipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [clipElapsed, setClipElapsed] = useState(0);

  const [shooting, setShooting] = useState(false);
  const [pending, setPending] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  // ---- setup -----------------------------------------------------------------

  useEffect(() => {
    requestCamPermission();
    requestRecordingPermissionsAsync().then((p) => setMicGranted(p.granted));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => subscribe((s) => setPending(s.pending)), []);

  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);

  useEffect(() => {
    if (clip !== 'recording') return;
    const started = clipStartedAt.current?.getTime() ?? Date.now();
    const timer = setInterval(() => setClipElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [clip]);

  useEffect(
    () => () => {
      if (clipTimer.current) clearTimeout(clipTimer.current);
      setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    },
    []
  );

  function showToast(message: string) {
    setToast(message);
    setTimeout(() => setToast((t) => (t === message ? null : t)), 1500);
  }

  // ---- leaving ---------------------------------------------------------------

  function handleDone() {
    if (voice === 'recording' || voice === 'paused') {
      Alert.alert('Voice note still recording', 'Tap "Stop & save" first.');
      return;
    }
    if (voice === 'saving' || clip !== 'idle') return;
    onDone();
  }

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      handleDone();
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, clip]);

  // ---- camera mode switching -------------------------------------------------

  function handleCameraReady() {
    setCameraReady(true);
    readyResolver.current?.();
    readyResolver.current = null;
  }

  /** Changes picture/video mode and waits until the camera has re-bound (or the fallback delay passes). */
  async function switchMode(next: CameraMode) {
    if (modeRef.current === next) return;
    modeRef.current = next;
    setCameraReady(false);
    await new Promise<void>((resolve) => {
      readyResolver.current = resolve;
      setMode(next);
      setTimeout(resolve, MODE_SWITCH_FALLBACK_MS);
    });
    readyResolver.current = null;
    setCameraReady(true);
  }

  /** Seconds into the running voice note, or null when none is running. */
  function voiceOffset(): number | null {
    if (voiceRef.current !== 'recording' && voiceRef.current !== 'paused') return null;
    return Math.round(recorder.currentTime * 10) / 10;
  }

  // ---- voice note ------------------------------------------------------------

  async function startVoice() {
    if (micGranted === false) {
      Alert.alert('Microphone needed', 'Allow microphone access in Settings to record voice notes.');
      return;
    }
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      sessionId.current = Crypto.randomUUID();
      voiceStartedAt.current = new Date();
      setVoice('recording');
    } catch (e) {
      Alert.alert('Could not start recording', errorMessage(e));
    }
  }

  function pauseVoice() {
    recorder.pause();
    setVoice('paused');
  }

  function resumeVoice() {
    recorder.record();
    setVoice('recording');
  }

  async function stopVoice() {
    const durationSeconds = Math.round(recorder.currentTime * 10) / 10;
    const startedAt = voiceStartedAt.current ?? new Date();
    const session = sessionId.current;
    setVoice('saving');
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error('no recording file was produced');
      const { mime, ext } = fileInfo('audio');
      enqueue({
        recipeId: recipe.id,
        kind: 'audio',
        localUri: keepAside(uri, `voice-${startedAt.getTime()}.${ext}`),
        mime,
        ext,
        durationSeconds,
        capturedAt: startedAt,
        sessionId: session,
        audioOffsetSeconds: null,
      });
      showToast('Voice note saved');
    } catch (e) {
      Alert.alert('Could not save the voice note', errorMessage(e));
    } finally {
      sessionId.current = null;
      voiceStartedAt.current = null;
      setVoice('idle');
      setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    }
  }

  // ---- photo -----------------------------------------------------------------

  const canShoot = cameraReady && mode === 'picture' && clip === 'idle' && !shooting;

  async function takePhoto() {
    const cam = cameraRef.current;
    if (!cam || !canShoot) return;
    setShooting(true);
    const capturedAt = new Date();
    const offset = voiceOffset();
    const session = sessionId.current;
    try {
      const photo = await withTimeout(
        cam.takePictureAsync({ quality: 0.6, shutterSound: false }),
        10_000,
        'the camera did not respond'
      );
      const { mime, ext } = fileInfo('photo');
      enqueue({
        recipeId: recipe.id,
        kind: 'photo',
        localUri: photo.uri,
        mime,
        ext,
        durationSeconds: null,
        capturedAt,
        sessionId: session,
        audioOffsetSeconds: offset,
      });
      showToast('Photo saved');
    } catch (e) {
      Alert.alert('Could not take the photo', errorMessage(e));
    } finally {
      setShooting(false);
    }
  }

  // ---- video clip ------------------------------------------------------------

  /** Runs the whole life of one clip: switch to video mode, record until stopped, store, switch back. */
  async function startClip() {
    const cam = cameraRef.current;
    if (!cam || clip !== 'idle' || shooting) return;
    setClip('starting');
    try {
      await switchMode('video');
      const capturedAt = new Date();
      const offset = voiceOffset();
      const session = sessionId.current;
      const recording = await armRecording(cam);
      clipStartedAt.current = capturedAt;
      setClipElapsed(0);
      setClip('recording');
      // Hard stop at the limit even if the native maxDuration does not end the recording.
      clipTimer.current = setTimeout(() => cameraRef.current?.stopRecording(), CLIP_MAX_SECONDS * 1000);

      let result: { uri: string } | undefined;
      try {
        result = await recording; // resolves after stopRecording() or when a native limit is hit
      } finally {
        if (clipTimer.current) clearTimeout(clipTimer.current);
        clipTimer.current = null;
        setClip('stopping');
      }
      if (!result?.uri) throw new Error('the camera did not return a video file');

      const durationSeconds = Math.round((Date.now() - capturedAt.getTime()) / 100) / 10;
      const { mime, ext } = fileInfo('video');
      enqueue({
        recipeId: recipe.id,
        kind: 'video',
        localUri: result.uri,
        mime,
        ext,
        durationSeconds,
        capturedAt,
        sessionId: session,
        audioOffsetSeconds: offset,
      });
      showToast('Clip saved');
    } catch (e) {
      Alert.alert('Could not record the clip', errorMessage(e));
    } finally {
      clipStartedAt.current = null;
      await switchMode('picture');
      setClip('idle');
    }
  }

  function stopClip() {
    if (clip !== 'recording') return;
    cameraRef.current?.stopRecording(); // startClip() is awaiting the recording and finishes the job
  }

  // ---- render ----------------------------------------------------------------

  if (!camPermission) {
    return <View style={styles.root} />;
  }
  if (!camPermission.granted) {
    return (
      <View style={[styles.root, styles.centered, { paddingTop: insets.top }]}>
        <Text style={styles.permissionText}>
          The camera is needed to take photos and clips while you record.
        </Text>
        <Pressable style={styles.pill} onPress={requestCamPermission}>
          <Text style={styles.pillText}>Allow camera</Text>
        </Pressable>
        <Pressable style={styles.pill} onPress={onDone}>
          <Text style={styles.pillText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  const voiceSeconds = Math.floor(recorderState.durationMillis / 1000);
  const clipBusy = clip === 'starting' || clip === 'stopping';

  return (
    <View style={styles.root}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        mode={mode}
        mute
        videoQuality="720p"
        videoBitrate={2_500_000}
        animateShutter={false}
        onCameraReady={handleCameraReady}
        onMountError={(e) => Alert.alert('Camera error', e.message)}
      />

      {/* Top bar: leave, voice status, uploads */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable style={styles.pill} onPress={handleDone} hitSlop={8}>
          <Text style={styles.pillText}>Done</Text>
        </Pressable>
        <View style={styles.voiceStatus}>
          {voice === 'recording' ? (
            <Text style={styles.rec}>● REC {formatDuration(voiceSeconds)}</Text>
          ) : voice === 'paused' ? (
            <Text style={styles.pausedText}>PAUSED {formatDuration(voiceSeconds)}</Text>
          ) : voice === 'saving' ? (
            <Text style={styles.pausedText}>Saving…</Text>
          ) : null}
        </View>
        <Text style={styles.pending}>{pending > 0 ? `Uploading ${pending}…` : ''}</Text>
      </View>

      {toast ? (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}

      {/* Bottom: recipe title, voice controls, shutter + clip */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 16 }]}>
        <Text style={styles.recipeTitle} numberOfLines={1}>
          {recipe.title}
        </Text>

        <View style={styles.voiceRow}>
          {voice === 'idle' ? (
            <Pressable style={[styles.voiceButton, styles.voiceStart]} onPress={startVoice}>
              <Text style={styles.voiceButtonText}>● Start voice note</Text>
            </Pressable>
          ) : voice === 'saving' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Pressable
                style={styles.voiceButton}
                onPress={voice === 'recording' ? pauseVoice : resumeVoice}
              >
                <Text style={styles.voiceButtonText}>{voice === 'recording' ? 'Pause' : 'Resume'}</Text>
              </Pressable>
              <Pressable style={[styles.voiceButton, styles.voiceStop]} onPress={stopVoice}>
                <Text style={styles.voiceButtonText}>Stop & save</Text>
              </Pressable>
            </>
          )}
        </View>

        <View style={styles.cameraRow}>
          <View style={styles.side} />
          <Pressable
            style={[styles.shutter, !canShoot && styles.dim]}
            onPress={takePhoto}
            disabled={!canShoot}
          >
            {shooting ? <ActivityIndicator color="#333" /> : <View style={styles.shutterInner} />}
          </Pressable>
          <View style={styles.side}>
            <Pressable
              style={[
                styles.clipButton,
                clip === 'recording' && styles.clipButtonActive,
                (clipBusy || shooting) && styles.dim,
              ]}
              onPress={clip === 'recording' ? stopClip : startClip}
              disabled={clipBusy || shooting}
            >
              <Text style={styles.clipText}>
                {clip === 'recording'
                  ? `■ ${formatDuration(clipElapsed)}`
                  : clip === 'idle'
                    ? '● Clip'
                    : '…'}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

/**
 * Renames a finished voice file to a unique name in the cache directory so the next
 * recording can never overwrite it before the upload has finished. Falls back to the
 * original path if the rename fails.
 */
function keepAside(uri: string, name: string): string {
  try {
    const dest = new File(Paths.cache, name);
    new File(uri).move(dest);
    return dest.uri;
  } catch {
    return uri;
  }
}

/**
 * Starts recording. If the camera rejects immediately (it was not done switching to
 * video mode yet), waits briefly and tries once more.
 */
async function armRecording(cam: CameraView): Promise<Promise<{ uri: string } | undefined>> {
  const options = { maxDuration: CLIP_MAX_SECONDS, maxFileSize: CLIP_MAX_BYTES, codec: 'avc1' as const };
  const first = cam.recordAsync(options);
  const outcome = await Promise.race([
    first.then(
      () => 'ended' as const,
      () => 'failed' as const
    ),
    delay(300).then(() => 'running' as const),
  ]);
  if (outcome !== 'failed') return first;
  await delay(500);
  return cam.recordAsync(options);
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  centered: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 },
  permissionText: { color: '#fff', fontSize: 17, textAlign: 'center', lineHeight: 24 },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  pill: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  pillText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  voiceStatus: { flex: 1, alignItems: 'center' },
  rec: {
    color: '#fff',
    backgroundColor: '#e03131',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: 15,
    fontWeight: '700',
    overflow: 'hidden',
  },
  pausedText: {
    color: '#111',
    backgroundColor: '#ffd43b',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: 15,
    fontWeight: '700',
    overflow: 'hidden',
  },
  pending: { color: '#fff', fontSize: 13, minWidth: 90, textAlign: 'right' },
  toast: {
    position: 'absolute',
    top: '40%',
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  toastText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 14,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  recipeTitle: { color: '#fff', fontSize: 15, textAlign: 'center', opacity: 0.9 },
  voiceRow: { flexDirection: 'row', justifyContent: 'center', gap: 12, minHeight: 48, alignItems: 'center' },
  voiceButton: {
    backgroundColor: 'rgba(255,255,255,0.22)',
    borderRadius: 24,
    paddingHorizontal: 22,
    paddingVertical: 12,
  },
  voiceStart: { backgroundColor: '#e03131' },
  voiceStop: { backgroundColor: '#e8590c' },
  voiceButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cameraRow: { flexDirection: 'row', alignItems: 'center' },
  side: { flex: 1, alignItems: 'center' },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#fff' },
  clipButton: {
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: 'rgba(255,255,255,0.22)',
    minWidth: 92,
    alignItems: 'center',
  },
  clipButtonActive: { backgroundColor: '#e03131' },
  clipText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  dim: { opacity: 0.35 },
});
