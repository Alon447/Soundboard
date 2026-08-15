# Soundboard project instructions

- This project uses local assets, not Supabase.
- Store playable sound files in public/sounds.
- Store optional pad images in public/images.
- Register pads in src/lib/sounds.ts using absolute public paths such as /sounds/airhorn.mp3.
- Prefer mp3 and mp4 support when working on playback behavior.
- Prefer HeroUI components for app UI, but match the installed HeroUI API exactly instead of mixing patterns from other component libraries.
- Define and reuse shared app theme variables in src/index.css for HeroUI-facing colors, surfaces, borders, and form controls instead of scattering ad-hoc colors through components.
- Prefer HeroUI for inputs, tabs, buttons, and sliders. For overlays, use a custom modal/dialog shell if the installed HeroUI primitive fights the product flow or proves unreliable in this app.
- Keep one React component per file. Shared constants, helpers, and types may live alongside them in non-component files.
- Do not reintroduce Supabase or other remote storage unless explicitly requested.
- Keep changes minimal and validate with npm run build and npm run typecheck when app code changes.
