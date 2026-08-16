# Soundboard project instructions

- This project stores the board in Supabase (`user_sounds`, `shared_sounds`) and requires sign-in. There is no guest/local fallback.
- Auth is email + password (`signInWithPassword` / `signUp`). Do not add magic-link or OTP flows.
- `.env` must hold `VITE_SUPABASE_URL` and the anon key of the *same* project ref; restart the dev server after changing it.
- Schema changes go in supabase/migrations and are applied with `npx supabase db push`.
- Built-in pads are declared in src/lib/sounds.ts; bundled audio lives in public/sounds and pad images in public/images.
- Prefer mp3 and mp4 support when working on playback behavior.
- Prefer HeroUI components for app UI, but match the installed HeroUI API exactly instead of mixing patterns from other component libraries.
- Define and reuse shared app theme variables in src/index.css for HeroUI-facing colors, surfaces, borders, and form controls instead of scattering ad-hoc colors through components.
- Prefer HeroUI for inputs, tabs, buttons, and sliders. For overlays, use a custom modal/dialog shell if the installed HeroUI primitive fights the product flow or proves unreliable in this app.
- Keep one React component per file. Shared constants, helpers, and types may live alongside them in non-component files.
- Keep changes minimal and validate with npm run build and npm run typecheck when app code changes.
