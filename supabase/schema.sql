-- Recipe Recorder — Supabase schema.
-- Run once in the Supabase Dashboard → SQL Editor. Safe to re-run.

-- 1) Tables -------------------------------------------------------------------

create table if not exists public.recipes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title      text not null check (char_length(title) between 1 and 200),
  created_at timestamptz not null default now()
);

-- One row per stored file. A recipe accumulates many: voice recordings, photos, video clips.
create table if not exists public.media (
  id                   uuid primary key default gen_random_uuid(),
  recipe_id            uuid not null references public.recipes (id) on delete cascade,
  user_id              uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind                 text not null check (kind in ('audio', 'photo', 'video')),
  storage_path         text not null,          -- object key in the "media" bucket: {user_id}/{recipe_id}/{timestamp}.{ext}
  mime_type            text not null,
  duration_seconds     numeric(8,1),           -- audio/video length; null for photos
  captured_at          timestamptz not null,   -- wall clock: voice start, shutter tap, or clip start
  session_id           uuid,                   -- id of the voice recording that was running when this was captured
                                               -- (audio rows carry their own id here); null when none was running
  audio_offset_seconds numeric(8,1),           -- seconds into that voice recording at capture time; null for audio rows
  created_at           timestamptz not null default now()
);

create index if not exists recipes_user_created_idx  on public.recipes (user_id, created_at desc);
create index if not exists media_recipe_captured_idx on public.media (recipe_id, captured_at);
create index if not exists media_session_idx         on public.media (session_id);

-- 2) Row Level Security: a user only ever sees their own rows -------------------

alter table public.recipes enable row level security;
alter table public.media   enable row level security;

drop policy if exists "recipes select own" on public.recipes;
drop policy if exists "recipes insert own" on public.recipes;
drop policy if exists "recipes update own" on public.recipes;
drop policy if exists "recipes delete own" on public.recipes;
create policy "recipes select own" on public.recipes for select to authenticated using (user_id = auth.uid());
create policy "recipes insert own" on public.recipes for insert to authenticated with check (user_id = auth.uid());
create policy "recipes update own" on public.recipes for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "recipes delete own" on public.recipes for delete to authenticated using (user_id = auth.uid());

drop policy if exists "media select own" on public.media;
drop policy if exists "media insert own" on public.media;
drop policy if exists "media update own" on public.media;
drop policy if exists "media delete own" on public.media;
create policy "media select own" on public.media for select to authenticated using (user_id = auth.uid());
create policy "media insert own" on public.media for insert to authenticated with check (user_id = auth.uid());
create policy "media update own" on public.media for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "media delete own" on public.media for delete to authenticated using (user_id = auth.uid());

-- 3) Storage: one private bucket, files live under {user_id}/... -------------------
-- 50 MB per file is the Free plan's global maximum (raise both the project setting
-- and this limit after upgrading). The app keeps video clips under it (≤ 2 min, 720p).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media', 'media', false, 52428800,
  array['audio/mp4', 'image/jpeg', 'video/mp4', 'video/quicktime']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "media storage read own"   on storage.objects;
drop policy if exists "media storage insert own" on storage.objects;
drop policy if exists "media storage delete own" on storage.objects;
create policy "media storage read own" on storage.objects for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "media storage insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "media storage delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid()::text));
