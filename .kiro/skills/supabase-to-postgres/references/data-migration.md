# Getting the data out of Supabase

**Do this first, before anything else in the port.** The 10-year signed URLs in
`shared_sounds.file_url` are the only handle you have on the uploaded audio. Once the
Supabase project is paused, deleted, or simply unreachable from the closed
environment, those bytes are unrecoverable. Nothing later in the migration can fix
that.

## Where the export lives: not in the repository

`export/` is a **gitignored staging area on the machine running the migration**, not a
project asset. Do not commit the audio.

- Git stores every version of a binary forever, and audio does not diff or compress.
  A few hundred clips would bloat the clone permanently, and the closed environment
  clones this repo.
- The bytes have a destination: the S3 bucket. Once they are uploaded and verified
  (step 3), `export/` is a backup, not a source.
- Keep it offline until the new environment has its own verified backups, then delete
  it. Until that point it is the only copy.

The one exception: if some uploaded clips are genuinely house sounds that everyone
should get by default, promote *those* into `public/sounds/` and declare them in the
built-in `SOUNDS` list. That is a deliberate product decision about a handful of files,
not a way to store user uploads.

## 1. Export the rows

Two options.

**Via the Postgres connection** (also gets `auth.users`, which the REST API will not
give you):

```powershell
# connection string from Supabase dashboard > Project Settings > Database
pg_dump --data-only --inserts `
  --table=public.user_sounds --table=public.shared_sounds `
  "$env:SUPABASE_DB_URL" > export/public-data.sql

psql "$env:SUPABASE_DB_URL" -At -c `
  "select json_agg(row_to_json(u)) from (select id, email, raw_user_meta_data, created_at from auth.users) u" `
  > export/users.json
```

`encrypted_password` is deliberately **not** exported. Keycloak owns credentials now,
so the bcrypt hashes are dead weight — and exporting password material you do not
need is a liability. What you do need is `id` and `email`: the id keeps every foreign
key valid, and the email is what links a row to its Keycloak account.

**Via the REST API with the service-role key**, if you cannot get the database
password. This cannot reach `auth.users`; use the Admin API
(`GET /auth/v1/admin/users`) for that. Prefer the direct database route.

## 2. Download the audio bytes

Signed URLs work from anywhere while the project is live, so this step needs no auth.

```ts
// scripts/export-sounds.ts — run with: npx tsx scripts/export-sounds.ts
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const supabase = createClient(process.env.VITE_SUPABASE_URL!, process.env.SERVICE_ROLE_KEY!);

const { data, error } = await supabase
  .from('shared_sounds')
  .select('id, name, file_url, storage_path');
if (error) throw error;

await mkdir('export/audio', { recursive: true });
const manifest: unknown[] = [];

for (const row of data!) {
  const res = await fetch(row.file_url);
  if (!res.ok) {
    console.error(`FAILED ${row.id} (${row.name}): HTTP ${res.status}`);
    continue;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ext = (row.storage_path?.split('.').pop() ?? 'mp3').toLowerCase();
  const file = `export/audio/${row.id}.${ext}`;
  await writeFile(file, bytes);
  manifest.push({
    id: row.id,
    name: row.name,
    file,
    bytes: bytes.length,
    sha256,
    ext,
    content_type: res.headers.get('content-type') ?? 'audio/mpeg',
    // the S3 key this will become
    object_key: `sounds/${sha256.slice(0, 2)}/${sha256}.${ext}`,
  });
  console.log(`ok ${row.id} ${bytes.length} bytes ${row.name}`);
}

await writeFile('export/manifest.json', JSON.stringify(manifest, null, 2));
console.log(`${manifest.length}/${data!.length} downloaded`);
```

Computing the sha256 here means the manifest already carries the content-addressed
object key, so the import is a straight copy with no re-hashing.

**Verify the count matches before going further.** Rows backfilled by the second
migration have `storage_path = null` and a legacy URL — those are the most likely to
fail. A zero-byte or HTML response means the URL expired or the object is gone; log
it and decide whether to drop the row or re-source the clip.

Also copy the whole bucket as a belt-and-braces backup:

```powershell
npx supabase storage cp --recursive ss:///sounds ./export/bucket
```

## 3. Upload to S3

Content-addressed keys make this idempotent, so a partial run can simply be re-run.

```ts
// for each manifest entry
await s3.send(new PutObjectCommand({
  Bucket: process.env.S3_BUCKET,
  Key: entry.object_key,
  Body: await readFile(entry.file),
  ContentType: entry.content_type,
}));
```

Deduplicate by `object_key` first — two `shared_sounds` rows can legitimately point at
identical bytes, and after content addressing they collapse to one object.

Verify with a `HeadObject` per key and compare `ContentLength` against the manifest.
Do not trust that a `PutObject` without an exception means the bytes are intact.

## 4. Load into the new database

Order matters, because of the foreign keys:

1. **`app_users`** — from `export/users.json`. Map `id` → `id` (**keep the original
   Supabase UUIDs**; every `user_sounds.user_id` and `shared_sounds.owner_id`
   references them), `email` → `email`, `raw_user_meta_data->>'name'` →
   `display_name`. Leave `upn` **null** — it gets attached on first Keycloak login.
2. **`sound_assets`** — one row per deduplicated manifest entry: `bucket`,
   `object_key`, `content_type`, `byte_size`, `sha256` (as `bytea`, from the hex).
3. **`shared_sounds`** — original `id`, `owner_id`, `owner_name`, `name`, `icon`,
   `color`, `gain`, `is_public`, `created_at`; `asset_id` resolved through the
   manifest. Drop `file_url` and `storage_path`.
4. **`user_sounds`** — original `id`, `user_id`, `sound_id`, `shared_sound_id`,
   `name`, `color`, `icon`, `gain`, `position`, `created_at`. Drop
   `custom_file_url` (see step 6 first).

Preserving the original UUIDs throughout makes the whole import idempotent and
re-runnable.

## 5. Identity: connecting Supabase users to Keycloak accounts

This is the step that decides whether people's boards survive, and it is easy to get
wrong because nothing fails loudly — users simply sign in and see an empty board that
gets seeded with the 9 built-ins, silently orphaning their old pads.

The mechanism is the resolve sequence in the API: look up `upn`, fall back to `email`,
and attach the `upn` to the matched row. Imported rows start with `upn = null`, so the
first Keycloak login of each user takes the email branch and binds the two identities.

`upn` is the identifying claim in this realm — an employee number like `T1001001`, and
what `../yanshuf3` keys all its user-owned rows on. Uppercase it once here and keep that
form everywhere.

**It only works if the email addresses match.** Before cutover, diff them:

```sql
-- imported users not yet bound to a Keycloak identity
select email from app_users where upn is null;
```

Compare that against the realm's user list. For every mismatch, decide explicitly:
correct the `app_users.email` to the Keycloak one, ask for a Keycloak account to be
created, or accept that the board is abandoned. Do not leave it to chance.

After cutover, the same query is a progress report — rows still `null` are users who
have not signed in yet.

Two failure modes to watch:

- **Case or domain differences** (`A.User@corp.com` vs `auser@corp.example`). `citext`
  handles case; domains need a mapping decision.
- **Two `app_users` rows with the same person's email**, which the unique constraint
  prevents on insert but which can happen if you import twice with different ids.
  Import once, idempotently, keyed on the original id.

## 6. Handle the legacy `custom_file_url` rows

`user_sounds.custom_file_url` predates `shared_sounds`. The second migration
backfilled most of them, but the join it used was
`us.custom_file_url = inserted.file_url`, which is fragile. Check for stragglers
before dropping the column:

```sql
select id, user_id, name, custom_file_url
  from user_sounds
 where custom_file_url is not null
   and shared_sound_id is null;
```

Any rows returned need their audio downloaded and promoted into `sound_assets` +
`shared_sounds` the same way, or the pad loses its sound.

## 7. Sanity checks after the import

```sql
-- every pad resolves to exactly one source
select count(*) from user_sounds
 where (sound_id is null) = (shared_sound_id is null);                            -- 0

-- every shared sound has an asset
select count(*) from shared_sounds ss
  left join sound_assets sa on sa.id = ss.asset_id where sa.id is null;           -- 0

-- no assets with an impossible size
select count(*) from sound_assets where byte_size <= 0;                           -- 0

-- every built-in sound_id still exists in the shared SOUNDS list
select distinct sound_id from user_sounds where sound_id is not null;

-- users not yet bound to a Keycloak identity
select count(*) from app_users where upn is null;   -- expected pre-cutover

-- row counts match the export
select (select count(*) from app_users), (select count(*) from user_sounds),
       (select count(*) from shared_sounds), (select count(*) from sound_assets);
```

Then, in the browser: sign in as an imported user, confirm their pre-migration board
appears, and play one imported upload. A row that exists but does not decode means
the bytes are truncated — the failure SQL cannot detect. A board that comes up empty
and freshly seeded means the identity mapping did not bind.

## 8. Clean up

Only after the new environment is verified working:

- Remove `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from `.env`.
- Rotate the anon key regardless — it is committed in this repo's history.
- Never commit the service-role key, and clear it from your shell history after the
  export.
- `npm uninstall @supabase/supabase-js supabase`.
- Keep `export/` out of git and retain it offline until the new environment has its
  own verified backups. It is the only copy of the audio until then.
