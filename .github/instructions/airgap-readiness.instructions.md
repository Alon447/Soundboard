---
applyTo: "src/lib/ffmpegConvert.ts,vite.config.ts,index.html,src/lib/sounds.ts,src/components/add-sound/**,public/**,apps/web/vite.config.ts,apps/api/src/storage/**,apps/api/src/auth/**,apps/api/src/config.ts"
description: "Offline / air-gapped deployment blockers: the ffmpeg.wasm core fetched from unpkg.com, COOP/COEP headers, external references, asset filenames, upload size limits, the S3 client's metadata probe, and Keycloak issuer-URL mismatches."
---

# Air-gap readiness

The deployment target is a closed environment with no outbound internet. Most of these
failure modes look like unrelated bugs, and several pass a casual smoke test. Full
checklist in `.kiro/skills/airgap-readiness/SKILL.md` (mirrored under
`.claude/skills/`).

Sections 1 to 5 apply to the app as it stands. Sections 6 and 7 apply once the Node
API, S3 and Keycloak are in play.

## 1. ffmpeg.wasm loads its core from unpkg.com — hard failure

`src/lib/ffmpegConvert.ts`:

```ts
const baseURL = 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm';
```

Every video upload goes through `extractAudioFromVideo`, so offline this kills
uploads for `.mov`/`.mp4`/`.mkv`. Audio-only uploads still work, which makes it easy
to miss.

`@ffmpeg/core-mt` is already a dependency. Copy
`node_modules/@ffmpeg/core-mt/dist/esm/{ffmpeg-core.js,ffmpeg-core.wasm,ffmpeg-core.worker.js}`
into `public/ffmpeg/`, point `baseURL` at `/ffmpeg`, and add an npm script wired
into `prebuild` so it cannot drift on the next `npm install`. Keep `toBlobURL` —
the worker still needs a blob URL under `COEP: require-corp`.

Test with devtools set to offline, not by reading the code.

## 2. COOP/COEP headers only exist in dev

`vite.config.ts` sets `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` via `configureServer` and
`configurePreviewServer` only. Production gets neither, so `SharedArrayBuffer` is
undefined and the multi-threaded ffmpeg core will not load.

Whatever serves `dist/` must send both headers. Verify `crossOriginIsolated === true`
in the browser console.

Second consequence: under `require-corp`, every cross-origin subresource needs
`Cross-Origin-Resource-Policy` or CORS headers — including audio fetched by
`getBuffer` in `App.tsx`. Serving audio from a same-origin `/api/...` route makes
this a non-issue, which is another reason not to store absolute URLs.

## 3. Do not add external runtime references

No CDN links, no webfonts, no remote scripts. `lucide-react` ships SVG components in
the bundle and Tailwind 4 builds at compile time, so the current bundle is clean
apart from the ffmpeg core.

Existing references: the unpkg URL above (must fix), `https://bolt.new/static/og_default.png`
as `og:image` in `index.html` (inert, remove for tidiness), and
`YOUTUBE_SERVER = 'http://localhost:3001'` in `src/components/add-sound/constants.ts`
(dead code, delete).

Before shipping, grep `src/` and `index.html` for `https?://` and load the built app
with devtools offline. Anything that 404s in the network panel is a blocker.

## 4. Built-in audio filenames are hostile

`public/sounds/` contains spaces, `!`, parentheses and curly quotes, e.g.
`“Fahh” - meme sound effect - Sound effects (1080p).mp4`. Vite's dev server tolerates
them; nginx, IIS and proxies encode and normalise differently. Rename to ASCII slugs
and update `audio_path` in `src/lib/sounds.ts` in the same commit.

**Do not change `sound_id` values** — they are stored in the database and identify
existing pads.

## 5. Upload size limits

No client-side size check exists anywhere, and `extractAudioFromVideo` reads the
whole file into wasm memory, so a large `.mkv` can hang the tab before any upload.
The only limit was Supabase Storage's 50 MiB, which disappears with Supabase. Add a
check in `UploadSoundPanel` before conversion, and enforce it server-side too.

## 6. S3 client — two traps that hang rather than fail

**The AWS SDK's default credential chain probes EC2 instance metadata**
(`169.254.169.254`). In a closed network that address is unreachable rather than
refused, so every S3 call pays a connection timeout first. Symptom: uploads and
playback "randomly" take many seconds, then error. Pass credentials explicitly and set
`AWS_EC2_METADATA_DISABLED=true`.

**Path-style versus virtual-host style.** Set `forcePathStyle: true` for MinIO and
Ceph RGW; the default builds `https://bucket.endpoint/key`, which needs wildcard DNS
that on-prem object stores usually lack. Failures look like the endpoint is down.

Use the modular v3 SDK (`@aws-sdk/client-s3`), not the monolithic v2 `aws-sdk`. No
bucket CORS configuration is needed while audio is proxied through
`GET /api/shared-sounds/:id/audio` — one of the reasons the design proxies rather than
issuing presigned URLs.

## 7. Keycloak — the issuer URL must be identical on both sides

Two network paths must work, and they are often different routes: **browser → Keycloak**
for the login redirect, and **API → Keycloak** for the JWKS document. If the browser
reaches Keycloak at one hostname and the API is configured with another, `iss`
validation fails on every request even though login appears to succeed. Use one issuer
URL resolvable from both; never disable issuer validation to get past it.

Also: register the redirect URI *and* post-logout redirect URI on the client; expect
the first request after an API restart to pay the JWKS fetch; and make sure the API
host and Keycloak agree on the time, because clock skew rejects valid tokens via
`exp` / `nbf`.

## 8. Base path, TLS, and offline builds

- Serving from a subpath needs `base` in the Vite config, and note that `assetPath()`
  and `src/lib/sounds.ts` produce `/`-rooted absolute paths that break under a
  subpath. Prefer the domain root.
- `SharedArrayBuffer` requires a secure context, so **HTTPS is mandatory** for the
  upload flow anywhere but `localhost`. The cert must be trusted by the environment,
  and so must Keycloak's.
- Node does not read the OS trust store on Linux. Set `NODE_EXTRA_CA_CERTS` for the
  API process — it covers both the S3 and Keycloak connections. PostgreSQL needs
  `ssl: { ca }` or `PGSSLROOTCERT` separately.
- Never use `rejectUnauthorized: false` or `NODE_TLS_REJECT_UNAUTHORIZED=0`. The CA is
  available in a closed network; using it is configuration, not a blocker.
- `npm ci` needs a reachable registry: build outside the closed network, or use an
  internal mirror. Keep `package-lock.json` committed and current.
- Check any new dependency for install-time network access before adding it. Nothing
  in the build pulls binaries at install today; keep it that way.
