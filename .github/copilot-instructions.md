# Soundboard project instructions

- This project uses local assets, not Supabase.
- Store playable sound files in public/sounds.
- Store optional pad images in public/images.
- Register pads in src/lib/sounds.ts using absolute public paths such as /sounds/airhorn.mp3.
- Prefer mp3 and mp4 support when working on playback behavior.
- Do not reintroduce Supabase or other remote storage unless explicitly requested.
- Keep changes minimal and validate with npm run build when app code changes.