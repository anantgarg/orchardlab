import { Platform } from 'react-native';

import { supabase } from './supabase';

export type Recipe = {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
};

export type MediaKind = 'audio' | 'photo' | 'video';

/** One row of the `media` table (see supabase/schema.sql). */
export type MediaRow = {
  id: string;
  recipe_id: string;
  user_id: string;
  kind: MediaKind;
  storage_path: string;
  mime_type: string;
  duration_seconds: number | null;
  captured_at: string;
  session_id: string | null;
  audio_offset_seconds: number | null;
  created_at: string;
};

/** A media row plus a short-lived signed URL for playback / display. */
export type MediaItem = MediaRow & { url: string | null };

export const BUCKET = 'media';

/** File type each capture kind produces on this platform. */
export function fileInfo(kind: MediaKind): { mime: string; ext: string } {
  switch (kind) {
    case 'audio':
      // expo-audio HIGH_QUALITY preset: AAC in an MP4 container on both platforms.
      return { mime: 'audio/mp4', ext: 'm4a' };
    case 'photo':
      return { mime: 'image/jpeg', ext: 'jpg' };
    case 'video':
      // expo-camera writes QuickTime on iOS and MP4 on Android.
      return Platform.OS === 'ios'
        ? { mime: 'video/quicktime', ext: 'mov' }
        : { mime: 'video/mp4', ext: 'mp4' };
  }
}

/** All media for a recipe in capture order, with signed URLs (valid for one hour). */
export async function loadMedia(recipeId: string): Promise<MediaItem[]> {
  const { data, error } = await supabase
    .from('media')
    .select('*')
    .eq('recipe_id', recipeId)
    .order('captured_at', { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as MediaRow[];
  if (rows.length === 0) return [];

  const { data: signed, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(
      rows.map((r) => r.storage_path),
      60 * 60
    );
  if (signError) throw signError;

  const urlByPath = new Map<string, string>();
  for (const s of signed ?? []) {
    if (s.path && s.signedUrl && !s.error) urlByPath.set(s.path, s.signedUrl);
  }
  return rows.map((r) => ({ ...r, url: urlByPath.get(r.storage_path) ?? null }));
}

export function formatDuration(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.round(seconds ?? 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
