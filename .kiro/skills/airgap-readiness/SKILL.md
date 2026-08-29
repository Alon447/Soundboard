---
name: airgap-readiness
description: Make the Soundboard app run in a closed, air-gapped, or on-prem environment with no outbound internet. Use when working on ffmpeg.wasm loading, COOP/COEP cross-origin isolation headers, external CDN dependencies, static asset paths and filenames, production deployment or hosting config, upload size limits, the S3 client configuration, Keycloak connectivity, secrets and HashiCorp Vault access, the IS_BLACK_ENV development switch, offline npm installs against the Nexus mirror, or TLS with an internal CA. Also use when the user mentions offline, air-gapped, closed network, on-prem, or intranet deployment.
---

# Air-gap readiness

Closed-environment failure modes that are **not** about porting off Supabase. Most of
them look like unrelated bugs, and several fail in ways that pass a casual smoke
test. Treat this as its own phase of work.

Sections 1 to 5 apply to the frontend as it stands today. Sections 6 to 13 cover the
backend, S3, Keycloak and Vault — the secrets and storage layers are built, the rest is
pending. See
`docs/target-architecture.md` for the design and `docs/house-conventions.md` for the
sibling projects that have already solved most of them.

## 1. ffmpeg.wasm core — fixed, keep it that way

`frontend/src/lib/ffmpegConvert.ts` used to fetch its core from `unpkg.com` at runtime.
Every video upload goes through `extractAudioFromVideo`, so with no internet the whole
upload flow died for any `.mov`/`.mp4`/`.mkv` while audio-only uploads kept working — easy
to miss in testing.

It now imports the three core files with `?url`, so Vite emits them into the bundle and
serves them same-origin. Two supporting pieces in `frontend/vite.config.ts` look removable
and are not:

1. `resolve.alias` maps `ffmpeg-core` to the resolved `@ffmpeg/core-mt` esm directory,
   because the package's `exports` map exposes only the root and `./wasm` — deep imports
   fail and the worker has no entry at all.
2. `build.assetsInlineLimit` returns `false` for `ffmpeg-core.worker`. It is 2.8 KB, under
   the default inline threshold, and a `data:` URL cannot back a `Worker`.

`toBlobURL` is no longer used; the assets are already same-origin. Never reintroduce a CDN
`baseURL`.

Test with devtools throttling set to offline, not just by reading the code.

## 2. COOP/COEP headers only exist in dev

`frontend/vite.config.ts` has a `cross-origin-isolation` plugin that sets
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

| Reference                                      | File                                    | Impact                                |
| ---------------------------------------------- | --------------------------------------- | ------------------------------------- |
| ~~`https://unpkg.com/@ffmpeg/core-mt@…`~~      | ~~`frontend/src/lib/ffmpegConvert.ts`~~ | fixed — bundled via `?url`            |
| ~~`https://bolt.new/static/og_default.png`~~   | ~~`index.html` `og:image`~~             | deleted, with the twitter card tags   |
| ~~`http://localhost:3001` (`YOUTUBE_SERVER`)~~ | ~~`add-sound/constants.ts`~~            | deleted, with `YouTubeSoundPanel.tsx` |

Fonts and icons are safe: `lucide-react` ships SVG components in the bundle, and
there is no webfont link. Tailwind 4 builds at compile time.

Before shipping, re-check with a grep for `https?://` across `frontend/src/` and
`index.html`, and load the built app with devtools offline. Anything that 404s in
the network panel is a blocker.

## 4. Built-in audio filenames — fixed, keep it that way

**Done.** All 15 files are ASCII slugs (`get-out.mp4`, `fahh.mp4`, `custom-1.mp3`). The rule
stands for anything added later: no spaces, no `!`, no parentheses, no curly quotes. What it
used to look like, and why it mattered:

```
Get out sound effect!! - YSL (360p).mp4
“Fahh” - meme sound effect - Sound effects (1080p).mp4
```

Vite's dev server tolerates them. nginx, IIS, and proxies encode and normalise
differently, and the curly quotes are non-ASCII.

`audio_path` lives in `frontend/src/lib/sounds.ts`, the only copy — the API has no built-in
list. **`sound_id` values must not change** — they are stored in the database
and identify existing pads. That is why the six adopted uploads are `custom-1` … `custom-6`
and `db/migrations/0002` rewrites the pads that pointed at them.

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
refused, it is _unreachable_, so every S3 call pays a connection timeout before
failing. Symptom: uploads and audio playback "randomly" take many seconds, then error.

Pass credentials explicitly and disable the probe:

```ts
const s3 = new S3Client({
	endpoint: process.env.S3_ENDPOINT, // https://s3.internal
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

Two independent network paths have to work, and they are often _not_ the same route:

- **browser → Keycloak**, for the login redirect
- **backend → Keycloak**, for discovery, the code exchange, and the JWKS document used to
  verify signatures on every request

The trap: if the browser reaches Keycloak at one hostname and the API configures a
different one, `iss` validation fails on every request even though both hosts are
reachable and login appears to succeed. Errors read as "invalid issuer" or a generic
401 immediately after a successful sign-in.

Use one issuer URL, resolvable and identical from both. Do not paper over a mismatch
by disabling issuer validation.

Also check:

- The realm's client has the app's **redirect URI** registered. Unregistered URIs fail
  at Keycloak with an error page, not in your app. There is no logout, so no post-logout
  redirect URI is needed.
- JWKS is fetched lazily and cached. First sign-in after an API restart pays that
  fetch, so a firewall rule that only blocks it intermittently produces intermittent
  401s.
- **Clock skew.** JWT `exp` / `nbf` validation compares against the validating host's
  clock. A closed-network host that has drifted from Keycloak rejects valid tokens.
  Confirm both sync to the same internal NTP source, and allow a small
  `clockTolerance` — `../yanshuf3` passes none, which is a latent fault.
- **JWKS caching.** yanshuf3 memoises the JWKS for the process lifetime with no TTL, so
  a Keycloak key rotation needs a restart. It also runs OIDC discovery at _import_ time,
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
in `frontend/vite.config.ts`. Note that `assetPath()` in
`frontend/src/components/soundboard/soundboardUtils.ts` builds absolute `/`-rooted paths and
`frontend/src/lib/sounds.ts` hardcodes `/sounds/...`, so both break under a subpath. Serving
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
- **API → S3, Keycloak and Vault.** All three go through Node's HTTPS stack, which does
  **not** read the OS trust store on Linux. Set `NODE_EXTRA_CA_CERTS=/path/ca.crt`
  for the backend process — one variable covers all three.

**One scoped exception: PostgreSQL.** `backend/src/utils/pg.ts` sets
`ssl: { rejectUnauthorized: false }` unconditionally, by explicit decision — TLS on,
certificate unverified — so that one connection secret works against both Supabase and an
internal CA without a config knob. The consequence is that a PostgreSQL with SSL _disabled_
cannot be used at all.

Everywhere else, never reach for `rejectUnauthorized: false`, and never for
`NODE_TLS_REJECT_UNAUTHORIZED=0`, which would silently extend the exception to S3, Vault and
Keycloak. In a closed network the CA is available; using it is a configuration task, not a
blocker.

## 10. Build and install in a closed network

**The npm mirror is Nexus**, and `../yanshuf3` has already solved this — reuse its
tooling from `yanshuf3/scripts/` rather than rediscovering the problems:

- **`stripLockIntegrity.js` must run before `npm ci`**, inside the Dockerfile. A
  Nexus-proxied registry serves tarballs whose integrity hashes do not match a
  `package-lock.json` generated against the public registry, so `npm ci` fails with an
  error that does not obviously point at the mirror. This is the single most likely thing
  to block a first build in the closed environment.
- **`checkNexusPackages.mjs`** reads the lockfile and reports _every_ package missing
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

## 11. Diagnose with `npm run api:check`, and beware vanishing error output

`backend/src/checkConnectivity.ts` is the first thing to run in a new environment. Four
checks — the two secrets, PostgreSQL plus its three tables, and an S3 round trip — each
reporting one line with the driver's own error. It prints secret _field names_ only, never
values, so it is safe to run against production.

It stays deliberately thin. An earlier version carried a table of likely causes per failure
mode; that was dropped because guessed remedies go stale faster than they help, and the
underlying errors already name the host, port and database.

Two hard-won details in it, both worth copying into anything similar:

**Node reports a refused connection as an `AggregateError` with an empty `message`.** When
every address family is refused — the normal case for `localhost` with IPv4 and IPv6 — the
useful information is in `error.errors[]`, one entry per address, and `error.message` is the
empty string. A diagnostic that prints `error.message` prints _nothing at all_ for the most
common failure there is. Falling back to `errors[0].message`, then `error.name`, is enough —
three lines, no cause-chain walking.

**Build the report as one string and write it with a single `process.stdout.write`.** During
development, `console.log`/`console.error` calls placed after a failed AWS SDK call produced
no output on either stream — the report simply disappeared while the process still exited
with the right code. One atomic write avoids the problem and also stops the report
interleaving with the structured logger. Set `process.exitCode` rather than calling
`process.exit()`, which can truncate a pending write.

## 12. Secrets come from Vault, read directly

The closed environment runs HashiCorp Vault. Read it **straight from the Node process over
the KV v2 HTTP API** — no intermediary service. hana2trino's
`backend/src/utils/secrets.ts` is the model:

```ts
const res = await axios.get(`${config.VAULT_PATH.replace(/\/+$/, '')}/data/${name}`, {
	headers: { 'X-Vault-Token': config.VAULT_TOKEN, Accept: 'application/json' },
	timeout: 5_000,
});
const data = (res.data as { data?: { data?: unknown } })?.data?.data; // KV v2 double nesting
```

with an `IS_BLACK_ENV` branch reading `local_secrets/<name>` as JSON. yanshuf3's older
approach put a Python microservice in front of Vault; that is one more process to image,
mirror and keep alive in a closed network, for no benefit.

**Built**, in `backend/src/utils/secrets.ts`, using **native `fetch` + `AbortSignal.timeout`**
rather than axios — one less package to mirror into Nexus. Dev secrets live in
`backend/local_secrets/`, one JSON file per path, gitignored.

Why this matters for air-gap readiness specifically: there is **no `.env` file to distribute
to the closed environment**, and no secret material in the repository or the image. In
development the same paths resolve to gitignored JSON files handed over out of band.

**`VAULT_TOKEN` is the bootstrap credential** — the one secret that cannot come from Vault.
It must be injected by the platform, never committed, never logged. Find out its TTL and
whether it needs renewing; a token that silently expires takes the app down at the next
secret read.

**Resolve at call time, never at import.** hana2trino is explicit about why: the process has
to boot with the secret store unreachable. yanshuf3's Python service gets this wrong — it
runs OIDC discovery at import, so Keycloak being down at boot stops the container starting.

**But memoise the derived clients.** hana2trino reads Vault on _every_ call, which buys
rotation without a restart at the cost of a round trip per database call — its own docstring
says so. One `pg.Pool` and one `S3Client`, built lazily and reused, with a TTL on the secret
read, gets both properties. (hana2trino also builds two brand-new pools per call and closes
neither, which exhausts connections under load.)

The counter-example worth naming: hana2trino's own S3 client still **hardcodes** its access
key, secret key, endpoint and bucket as string literals in `backend/src/utils/s3.ts` — it
was not updated when `secrets.ts` landed. Those credentials are in that repo's git history
and need rotating. Do not repeat it; build the S3 client from `getSecret('s3')`.

Environment variables stay, but only for non-secret wiring plus the Vault coordinates —
`VAULT_PATH`, `VAULT_TOKEN`, `IS_BLACK_ENV`, `PG_ENV`, `NODE_EXTRA_CA_CERTS`,
`AWS_EC2_METADATA_DISABLED`. Validate them with Zod at boot and exit on failure. Do not add
fallback values for things the architecture guarantees.

Vault also needs the internal CA — see the TLS section. hana2trino uses
`rejectUnauthorized: false` on its Vault agent; use `NODE_EXTRA_CA_CERTS` instead.

## 13. `IS_BLACK_ENV` must not be a privilege switch

One boolean meaning "am I outside the closed environment". Copy hana2trino's Node
implementation from `backend/src/config/index.ts` and `backend/src/utils/envCheck.ts`:

```ts
IS_BLACK_ENV: z.string().default("false").transform((v) => v.toLowerCase() === "true"),
export const isBlackEnv = () => config.IS_BLACK_ENV;
```

Read it through the helper, never `config.IS_BLACK_ENV` at call sites.

What it should switch: identity (mock claims, Keycloak never contacted, cookie path still
runs), storage (MinIO instead of the internal S3), and secrets (`local_secrets/` instead of
Vault). What it must **never** switch: privileges. hana2trino's flag also returns
`IT: true`, which makes one mistyped environment variable a complete auth bypass with admin
rights.

Ownership checks must behave identically in both modes. If they only run in the closed
environment, they are untested exactly where development happens — and that is the mode
nobody can debug from a desk.

## Pre-deployment checklist

Frontend and assets:

- [x] ffmpeg core bundled by Vite from `@ffmpeg/core-mt`, no unpkg reference, worker not inlined
- [ ] `crossOriginIsolated === true` on the production host
- [ ] COOP + COEP set by the production server, not just Vite
- [ ] devtools offline: no failed network requests, video upload still converts
- [ ] built-in audio filenames are ASCII and pads still play
- [ ] upload size limit enforced client and server side
- [x] `index.html` title and `og:image` no longer say bolt.new / "Python Soundboard"

S3:

- [ ] explicit credentials passed; `AWS_EC2_METADATA_DISABLED=true` set
- [ ] `forcePathStyle` matches what the object store expects
- [ ] a round trip works: upload a clip, play it, confirm the object exists in the
      bucket with the expected content-addressed key
- [ ] bucket has a backup/retention policy — it holds data the database cannot
      reconstruct

Keycloak:

- [ ] the same issuer URL resolves from both the browser and the validating service
- [ ] redirect URI registered on the client
- [ ] clocks agree, and a non-zero `clockTolerance` is configured
- [ ] sign in, reload the page, confirm the session survives
- [ ] make Keycloak unreachable and confirm the app shows a retry, not a redirect loop
- [ ] `IS_BLACK_ENV` mock mode exercises the full cookie path with neither Keycloak nor
      Vault running
- [ ] the redirect URI registered on the client matches what the backend sends, exactly

Secrets:

- [ ] every credential comes from Vault, none from `.env`, source or the image
- [ ] `VAULT_TOKEN` is platform-injected; its TTL and renewal are understood
- [ ] derived clients are memoised, so no request triggers a Vault round trip
- [ ] secrets are Zod-parsed at the boundary
- [ ] `local_secrets/` is gitignored and never committed
- [ ] config validated at boot, process exits on anything missing
- [ ] `IS_BLACK_ENV` grants no privileges, and ownership checks run in both modes

TLS and build:

- [ ] HTTPS with a cert the environment trusts, for both the app and Keycloak
- [ ] PostgreSQL connection works with the internal CA
- [ ] `NODE_EXTRA_CA_CERTS` set for the API process
- [ ] no `NODE_TLS_REJECT_UNAUTHORIZED=0`, and no `rejectUnauthorized: false` outside
      `pg.ts`, where it is the documented exception
- [ ] `stripLockIntegrity` runs before `npm ci` in the Dockerfile
- [ ] `checkNexusPackages` reports nothing missing from the mirror
- [ ] `npm ci && npm run build && npm run typecheck` from a clean checkout
