---
name: airgap-readiness
description: Make the Soundboard app run in a closed, air-gapped, or on-prem environment with no outbound internet. Use when working on ffmpeg.wasm loading, COOP/COEP cross-origin isolation headers, external CDN dependencies, static asset paths and filenames, production deployment or hosting config, upload size limits, the S3 client configuration, Keycloak connectivity, secrets and the vault service, offline npm installs against the Nexus mirror, or TLS with an internal CA. Also use when the user mentions offline, air-gapped, closed network, on-prem, or intranet deployment.
---

# Air-gap readiness

Closed-environment failure modes that are **not** about porting off Supabase. Most of
them look like unrelated bugs, and several fail in ways that pass a casual smoke
test. Treat this as its own phase of work.

Sections 1 to 5 apply to the app as it stands today. Sections 6 to 11 apply once the
Node API, S3, Keycloak and the vault service are in play — see
`docs/target-architecture.md` for the design and `docs/yanshuf3-conventions.md` for the
sibling project that has already solved most of them.

## 1. ffmpeg.wasm loads its core from unpkg.com — hard failure

`src/lib/ffmpegConvert.ts` does this at runtime:

```ts
const baseURL = 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm';
```

Every video upload goes through `extractAudioFromVideo`, so with no internet the
entire upload flow dies for any `.mov`/`.mp4`/`.mkv`. Audio-only uploads still work,
which makes this easy to miss in testing.

`@ffmpeg/core-mt` is already a dependency. Vendor it:

1. Copy `node_modules/@ffmpeg/core-mt/dist/esm/{ffmpeg-core.js,ffmpeg-core.wasm,ffmpeg-core.worker.js}`
   into `public/ffmpeg/`.
2. Change `baseURL` to `/ffmpeg`.
3. Add an npm script so it cannot drift on the next `npm install`, and wire it into
   `prebuild`.

Keep `toBlobURL` even though the files are now same-origin — the worker needs a blob
URL under `COEP: require-corp`.

Test with devtools throttling set to offline, not just by reading the code.

## 2. COOP/COEP headers only exist in dev

`vite.config.ts` has a `cross-origin-isolation` plugin that sets
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` — but only via `configureServer` and
`configurePreviewServer`. **A production host gets neither.** Without them
`SharedArrayBuffer` is undefined and the multi-threaded ffmpeg core will not load.

Whatever serves `dist/` must send both headers. nginx:

```nginx
add_header Cross-Origin-Opener-Policy   same-origin  always;
add_header Cross-Origin-Embedder-Policy require-corp always;
```

If the app is served by the replacement API process, set them there instead.

Second consequence: under `require-corp`, **every** cross-origin subresource needs
`Cross-Origin-Resource-Policy` or CORS headers, including audio fetched by
`getBuffer` in `App.tsx`. Serving audio from a same-origin `/api/...` route makes
this a non-issue, which is one more reason not to store absolute URLs.

Verify in the browser console: `crossOriginIsolated === true`.

## 3. No other external references at runtime

Current state:

| Reference | File | Impact |
| --- | --- | --- |
| `https://unpkg.com/@ffmpeg/core-mt@…` | `src/lib/ffmpegConvert.ts` | breaks video upload — fix it |
| `https://bolt.new/static/og_default.png` | `index.html` `og:image` | inert; remove for tidiness |
| `http://localhost:3001` (`YOUTUBE_SERVER`) | `src/components/add-sound/constants.ts` | dead code, delete it |

Fonts and icons are safe: `lucide-react` ships SVG components in the bundle, and
there is no webfont link. Tailwind 4 builds at compile time.

Before shipping, re-check with a grep for `https?://` across `src/` and
`index.html`, and load the built app with devtools offline. Anything that 404s in
the network panel is a blocker.

## 4. Built-in audio filenames are hostile

`public/sounds/` contains spaces, `!`, parentheses, and curly quotes:

```
Get out sound effect!! - YSL (360p).mp4
“Fahh” - meme sound effect - Sound effects (1080p).mp4
```

Vite's dev server tolerates them. nginx, IIS, and proxies encode and normalise
differently, and the curly quotes are non-ASCII. Rename them to ASCII slugs
(`get-out.mp4`, `fahh.mp4`) and update `audio_path` in `src/lib/sounds.ts` in the
same commit. `sound_id` values must not change — those are stored in the database
and identify existing pads.

## 5. Upload size limits

No client-side size check exists anywhere. The only limit was Supabase Storage's
`file_size_limit = "50MiB"` in `supabase/config.toml`, and that disappears with
Supabase. Worse, `extractAudioFromVideo` reads the entire file into wasm memory, so
a large `.mkv` can hang or crash the tab before any upload happens.

Add both:

- Client: reject in `UploadSoundPanel` before conversion, with a clear message.
- Server: enforce at the multipart layer and return 413.

Pick a number appropriate for short clips — 15 MiB is generous.

## 6. S3 client configuration — two traps that hang rather than fail

**The default credential chain probes EC2 instance metadata.** If you construct an
`S3Client` without explicit credentials, the AWS SDK walks its provider chain and
eventually tries `http://169.254.169.254`. In a closed network that address is not
refused, it is *unreachable*, so every S3 call pays a connection timeout before
failing. Symptom: uploads and audio playback "randomly" take many seconds, then error.

Pass credentials explicitly and disable the probe:

```ts
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,          // https://s3.internal
  region: process.env.S3_REGION ?? 'us-east-1', // often ignored, still required
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
});
```

Belt and braces: set `AWS_EC2_METADATA_DISABLED=true` in the API's environment.

**Path-style versus virtual-host style.** `forcePathStyle: true` sends
`https://endpoint/bucket/key`. The default sends `https://bucket.endpoint/key`, which
needs a wildcard DNS entry that on-prem object stores usually do not have. MinIO and
Ceph RGW generally require path-style. Getting this wrong produces DNS resolution
errors that look like the endpoint is down.

Use the modular v3 SDK (`@aws-sdk/client-s3`), not the monolithic v2 `aws-sdk`.

**No bucket CORS configuration is needed** as long as audio is proxied through
`GET /api/shared-sounds/:id/audio`. That is one of the reasons the design proxies
rather than handing presigned URLs to the browser — bucket CORS in a locked-down
environment is a request to another team, not a config edit. If you ever switch to
presigned URLs, bucket CORS becomes a hard prerequisite.

## 7. Keycloak connectivity — the issuer URL must be identical on both sides

Two independent network paths have to work, and they are often *not* the same route:

- **browser → Keycloak**, for the login redirect and token exchange
- **auth BFF / API → Keycloak**, for the JWKS document used to verify signatures

The trap: if the browser reaches Keycloak at one hostname and the API configures a
different one, `iss` validation fails on every request even though both hosts are
reachable and login appears to succeed. Errors read as "invalid issuer" or a generic
401 immediately after a successful sign-in.

Use one issuer URL, resolvable and identical from both. Do not paper over a mismatch
by disabling issuer validation.

Also check:

- The realm's client has the app's **redirect URI and post-logout redirect URI**
  registered. Unregistered URIs fail at Keycloak with an error page, not in your app.
- JWKS is fetched lazily and cached. First sign-in after an API restart pays that
  fetch, so a firewall rule that only blocks it intermittently produces intermittent
  401s.
- **Clock skew.** JWT `exp` / `nbf` validation compares against the validating host's
  clock. A closed-network host that has drifted from Keycloak rejects valid tokens.
  Confirm both sync to the same internal NTP source, and allow a small
  `clockTolerance` — `../yanshuf3` passes none, which is a latent fault.
- **JWKS caching.** yanshuf3 memoises the JWKS for the process lifetime with no TTL, so
  a Keycloak key rotation needs a restart. It also runs OIDC discovery at *import* time,
  which means Keycloak being unreachable at boot stops the container starting. Prefer a
  lazy fetch with a TTL and refetch-on-unknown-`kid`.
- Keycloak's own TLS certificate must be trusted by Node — see the TLS section below.

**Develop against mock mode, not Keycloak.** Copy yanshuf3's `IS_BLACK_ENV` switch: with
it set, no IdP is contacted at all, the callback is reached with a mock code, and session
validation synthesizes claims from env vars — while the real cookie-setting path still
runs. Outside the closed network there is no Keycloak to talk to, so without this the
auth stack is undevelopable. The same flag switches storage from S3 to local MinIO.

## 8. Base path and static hosting

If the app is served from a subpath (`https://intranet/soundboard/`), set `base`
in `vite.config.ts`. Note that `assetPath()` in
`src/components/soundboard/soundboardUtils.ts` builds absolute `/`-rooted paths and
`src/lib/sounds.ts` hardcodes `/sounds/...`, so both break under a subpath. Serving
from the domain root avoids the problem entirely — prefer that.

The SPA needs a history fallback to `index.html`, though with a single route this
only matters if someone deep-links or refreshes.

## 9. TLS and internal CAs

Closed environments usually run an internal CA, and there are now four TLS hops.

- **Browser → app.** The host needs a certificate the corporate trust store accepts.
  `SharedArrayBuffer` also requires a secure context, so plain HTTP only works on
  `localhost`. **HTTPS is mandatory for the upload flow.**
- **Browser → Keycloak.** Same trust store. A cert warning mid-redirect is a
  confusing failure because the app never gets to run.
- **API → PostgreSQL.** `pg` may need `ssl: { ca: readFileSync('/path/ca.crt') }`, or
  `sslmode=verify-full` with `PGSSLROOTCERT`.
- **API → S3 and API → Keycloak.** Both go through Node's HTTPS stack, which does
  **not** read the OS trust store on Linux. Set `NODE_EXTRA_CA_CERTS=/path/ca.crt`
  for the API process — one variable covers both.

Never reach for `rejectUnauthorized: false` or `NODE_TLS_REJECT_UNAUTHORIZED=0`. In
a closed network the CA is available; using it is a configuration task, not a
blocker. Disabling verification turns a solved problem into a permanent one.

## 10. Build and install in a closed network

**The npm mirror is Nexus**, and `../yanshuf3` has already solved this — reuse its
tooling from `yanshuf3/scripts/` rather than rediscovering the problems:

- **`stripLockIntegrity.js` must run before `npm ci`**, inside the Dockerfile. A
  Nexus-proxied registry serves tarballs whose integrity hashes do not match a
  `package-lock.json` generated against the public registry, so `npm ci` fails with an
  error that does not obviously point at the mirror. This is the single most likely thing
  to block a first build in the closed environment.
- **`checkNexusPackages.mjs`** reads the lockfile and reports *every* package missing
  from the mirror at once, instead of discovering them one at a time through failing
  installs. `--prepare-upload --tarballs <dir>` builds the `.tgz` bundles to upload.
- **`bundleOfflineDeps.mjs`** stages and archives dependencies for transfer across the
  gap; `bundle.ps1` / `import-bundle.ps1` move build artefacts.

Also:

- `package-lock.json` must be committed and current. After the workspace restructure
  there is still exactly one lockfile at the root.
- Nothing in the build pulls binaries at install time today — no `puppeteer`, `esbuild`
  postinstall downloads or similar. Keep it that way; check any new dependency for
  install-time network access before adding it. `@aws-sdk/client-s3`, `pg`, `jose` and
  `zod` are all pure JS with no postinstall downloads.
- Python services need the internal pip mirror. yanshuf3's `auth-service/Dockerfile` is
  the reference: `ENV PIP_CONFIG_FILE=/opt/etc/pip.conf`.
- The house rule for WASM and other fetched artefacts is **vendor them into the image**,
  never fetch at runtime. That is the same conclusion as section 1's ffmpeg core.

## 11. Secrets come from the vault service

The closed environment runs a vault service with a Redis mirror, and yanshuf3 sources
every credential from it: `getSecret('s3')`, `getSecret('db/postgres/<env>')`,
`getSecret('idp/keycloack/<app>')`. Soundboard should do the same.

Why this matters for air-gap readiness specifically: there is no `.env` file to
distribute to the closed environment, and no secret material in the repository or the
image. In development the same paths resolve to JSON files under `local_secrets/`, which
is gitignored and handed over out of band.

Environment variables stay, but only for non-secret wiring — `VAULT_SERVICE`,
`IS_BLACK_ENV`, `PG_ENV`, `NODE_EXTRA_CA_CERTS`, `AWS_EC2_METADATA_DISABLED`. Validate
them with Zod at boot and exit on failure. Do not add fallback values for things the
architecture guarantees.

## Pre-deployment checklist

Frontend and assets:

- [ ] ffmpeg core served from `public/ffmpeg/`, `baseURL` updated, no unpkg reference
- [ ] `crossOriginIsolated === true` on the production host
- [ ] COOP + COEP set by the production server, not just Vite
- [ ] devtools offline: no failed network requests, video upload still converts
- [ ] built-in audio filenames are ASCII and pads still play
- [ ] upload size limit enforced client and server side
- [ ] `index.html` title and `og:image` no longer say bolt.new / "Python Soundboard"

S3:

- [ ] explicit credentials passed; `AWS_EC2_METADATA_DISABLED=true` set
- [ ] `forcePathStyle` matches what the object store expects
- [ ] a round trip works: upload a clip, play it, confirm the object exists in the
      bucket with the expected content-addressed key
- [ ] bucket has a backup/retention policy — it holds data the database cannot
      reconstruct

Keycloak:

- [ ] the same issuer URL resolves from both the browser and the validating service
- [ ] redirect URI and post-logout redirect URI registered on the client
- [ ] clocks agree, and a non-zero `clockTolerance` is configured
- [ ] sign in, reload the page, confirm the session survives
- [ ] stop the BFF and confirm the app shows a retry, not a redirect loop
- [ ] `IS_BLACK_ENV` mock mode exercises the full cookie path with no Keycloak running

Secrets:

- [ ] every credential comes from the vault service, none from `.env` or the image
- [ ] `local_secrets/` is gitignored and never committed
- [ ] config validated at boot, process exits on anything missing

TLS and build:

- [ ] HTTPS with a cert the environment trusts, for both the app and Keycloak
- [ ] PostgreSQL connection works with the internal CA
- [ ] `NODE_EXTRA_CA_CERTS` set for the API process
- [ ] no `rejectUnauthorized: false` or `NODE_TLS_REJECT_UNAUTHORIZED=0` anywhere
- [ ] `stripLockIntegrity` runs before `npm ci` in the Dockerfile
- [ ] `checkNexusPackages` reports nothing missing from the mirror
- [ ] `npm ci && npm run build && npm run typecheck` from a clean checkout
