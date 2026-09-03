import { File, UploadType } from 'expo-file-system';
import { Alert } from 'react-native';

import { BUCKET, type MediaKind } from './media';
import { SUPABASE_KEY, SUPABASE_URL, supabase } from './supabase';
import { delay, errorMessage } from './util';

/** A captured file waiting to be stored on the server. */
export type UploadItem = {
  recipeId: string;
  kind: MediaKind;
  localUri: string;
  mime: string;
  ext: string;
  durationSeconds: number | null;
  capturedAt: Date;
  sessionId: string | null;
  audioOffsetSeconds: number | null;
};

export type UploadState = {
  /** Files still waiting to be stored (including the one in flight). */
  pending: number;
  /** Files stored since the app started; increments once per success. */
  completed: number;
};

type Listener = (state: UploadState) => void;

// Module-level so uploads keep going after the capture screen is closed
// (while the app stays in the foreground). Not persisted: killing the app
// drops whatever is still queued; the local files stay in the cache directory.
const queue: UploadItem[] = [];
const listeners = new Set<Listener>();
let completed = 0;
let running = false;

const LABELS: Record<MediaKind, string> = {
  audio: 'voice note',
  photo: 'photo',
  video: 'video clip',
};

/** Subscribe to queue changes. Calls back immediately with the current state. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener({ pending: queue.length, completed });
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  const state: UploadState = { pending: queue.length, completed };
  listeners.forEach((listener) => listener(state));
}

export function enqueue(item: UploadItem) {
  queue.push(item);
  notify();
  void drain();
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const item = queue[0];
      try {
        await storeWithRetry(item);
        completed += 1;
      } catch (e) {
        Alert.alert('Upload failed', `Your ${LABELS[item.kind]} could not be saved: ${errorMessage(e)}`);
      }
      queue.shift();
      notify();
    }
  } finally {
    running = false;
  }
}

async function storeWithRetry(item: UploadItem) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error('not signed in');

  // Object key inside the private "media" bucket. The first folder must be the
  // user's id: the storage policies in supabase/schema.sql key off it.
  const path = `${session.user.id}/${item.recipeId}/${item.capturedAt.getTime()}-${item.kind}.${item.ext}`;

  let uploaded = false;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!uploaded) {
        await putObject(item, path, session.access_token);
        uploaded = true;
      }
      await insertRow(item, path);
      try {
        new File(item.localUri).delete();
      } catch {
        // Leftover cache files are harmless.
      }
      return;
    } catch (e) {
      lastError = e;
      await delay(1500 * (attempt + 1));
    }
  }
  throw lastError;
}

/** Streams the file from disk straight to Supabase Storage (no JS-side buffering, so large clips are fine). */
async function putObject(item: UploadItem, path: string, accessToken: string) {
  const res = await new File(item.localUri).upload(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,
    {
      httpMethod: 'POST',
      uploadType: UploadType.BINARY_CONTENT,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: SUPABASE_KEY,
        'Content-Type': item.mime,
        'x-upsert': 'false',
      },
    }
  );
  if (res.status >= 200 && res.status < 300) return;
  // A retry after a lost response: the object is already there, carry on to the row insert.
  if (res.status === 400 && /already exists/i.test(res.body ?? '')) return;
  throw new Error(`storage responded ${res.status}: ${res.body}`);
}

async function insertRow(item: UploadItem, path: string) {
  const { error } = await supabase.from('media').insert({
    recipe_id: item.recipeId,
    kind: item.kind,
    storage_path: path,
    mime_type: item.mime,
    duration_seconds: item.durationSeconds,
    captured_at: item.capturedAt.toISOString(),
    session_id: item.sessionId,
    audio_offset_seconds: item.audioOffsetSeconds,
  });
  if (error) throw error;
}
