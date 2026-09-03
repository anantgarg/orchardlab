# Recipe Recorder

A deliberately small Expo (React Native) app for iOS and Android. You describe a recipe out loud while the camera stays open, grab photos and short video clips as you go, and everything is stored in your own Supabase project.

- **Login**: phone number + SMS code (Supabase Auth).
- **Recipes**: a plain scrollable list of titles. Type a title, tap Add, start talking.
- **Capture screen**: live camera preview with three independent controls:
  - **Voice note** – start, pause, resume, stop & save. The only thing using the microphone.
  - **Photo** – tap the shutter any time while you talk.
  - **Video clip** – start/stop a clip without touching the voice note (clips are recorded without sound; the voice note *is* the audio).
- **Recipe screen**: everything captured for that recipe in order – play voice notes, view photos, play clips. Come back any time and add more.

Transcription is intentionally not built yet. Audio is stored as AAC `.m4a`, which every major speech-to-text API accepts, and each photo/clip remembers where in the voice note it was taken, so a transcript can be lined up with them later.

## 1. Create the Supabase project (once)

1. Go to [supabase.com](https://supabase.com), create a project (any region; remember the database password).
2. Open **SQL Editor**, paste the contents of [`supabase/schema.sql`](supabase/schema.sql), press **Run**. This creates the `recipes` and `media` tables, row-level security, and a private `media` storage bucket. It is safe to run again later.
3. Open **Authentication → Sign In / Providers → Phone** and turn **Enable Phone provider** on.
4. To develop **without paying for SMS**, on the same page add a **Test Phone Number and OTP**, for example number `+15005550006` with code `123456`. Supabase will not send a text for that number; it simply accepts that code. (Delete test numbers before real users sign up.)
5. Open **Project Settings → API Keys** and copy the **Project URL** and the **Publishable key** (a legacy `anon` key works too).

When you want real text messages, connect an SMS provider (Twilio, MessageBird, Vonage or Textlocal) in the Phone provider settings. Nothing in the app changes.

## 2. Run the app

```bash
cp .env.example .env      # then paste the URL and key from step 5
npm install
npx expo start
```

Install **Expo Go** on your phone (the SDK 57 version) and scan the QR code. Log in with your test number and code, add a recipe, and you land on the capture screen. The app remembers the login between launches.

Everything used here (camera, microphone, audio, video) works inside Expo Go. If you later make a standalone build (`npx expo prebuild` / EAS Build), the permission texts in [`app.json`](app.json) are used automatically.

## 3. Check it on a real phone

The one thing the docs cannot promise is how a given phone shares the microphone with the camera, so run through this once on each platform:

1. Add a recipe → **Start voice note**. The red `REC` timer counts up.
2. Take a photo. The timer keeps counting.
3. Tap **● Clip**, film for a few seconds, tap **■**. The voice timer never stops.
4. **Pause**, wait, **Resume**, then **Stop & save**.
5. **Done** → the recipe screen lists the voice note, the photo and the clip in order. Play the voice note (it should include what you said during the clip). Play the clip. View the photo.
6. Force-quit and reopen the app: still logged in, recipe still there.
7. In Supabase: **Table Editor → media** shows the rows; photo/clip rows have `session_id` and `audio_offset_seconds`; **Storage → media** shows the files under `<your user id>/<recipe id>/`.

If the voice timer ever stalls when a clip starts, that phone reconfigured the audio session for the camera. Report which device – the fallback is to re-arm the recorder after the clip starts (see `screens/CaptureScreen.tsx`).

## Limits to know about

- **Clips are silent** by design: a phone lets one recorder use the microphone, and that is the voice note. Clips are capped at **2 minutes / 720p** so each file stays under the 50 MB per-file limit of the Supabase Free plan (raise `CLIP_MAX_SECONDS` in `screens/CaptureScreen.tsx` and the bucket limit in `supabase/schema.sql` on a paid plan).
- **Keep the app in the foreground while recording.** Android stops recorders that go to the background.
- **Uploads run in the background while the app is open** (the recipe screen shows "Uploading N…" and refreshes as they finish). The queue is in memory: if the app is killed mid-upload, that file is not retried.
- A photo cannot be taken *during* a clip (the camera is in video mode); voice controls are always available.

## How data is stored

| Where | What |
| --- | --- |
| `public.recipes` | `id`, `user_id`, `title`, `created_at` |
| `public.media` | one row per file: `kind` (`audio` / `photo` / `video`), `storage_path`, `mime_type`, `duration_seconds`, `captured_at`, `session_id`, `audio_offset_seconds` |
| Storage bucket `media` (private) | `{user_id}/{recipe_id}/{timestamp}-{kind}.{ext}` – `.m4a` voice notes, `.jpg` photos, `.mov` (iOS) / `.mp4` (Android) clips |

`session_id` is generated when a voice note starts and stamped on the voice note itself and on every photo/clip captured while it ran; `audio_offset_seconds` is how far into that voice note the capture happened. Row-level security and storage policies mean each user can only ever read or write their own rows and files.

## Project layout

```
App.tsx                      session check, which screen is showing
lib/supabase.ts              Supabase client (session persisted on the device)
lib/media.ts                 row types, per-platform file types, loading a recipe's media with signed URLs
lib/upload.ts                background upload queue: streams files to Storage, inserts the media row
lib/util.ts                  small helpers
screens/AuthScreen.tsx       phone number → SMS code
screens/RecipeListScreen.tsx recipe titles + add
screens/RecipeDetailScreen.tsx  media list, playback, "Record" button
screens/CaptureScreen.tsx    camera + voice note + photo + clip
supabase/schema.sql          database tables, policies, storage bucket
```
