# Database migrations

Schema lives in `supabase/migrations/` as timestamped `.sql` files, applied in order.
Never edit a pushed migration — always add a new one.

Run these in the VS Code terminal (`` Ctrl+` ``) from the project root.
The CLI isn't installed globally, so commands use `npx supabase`.

## One-time setup

```powershell
npx supabase login
npx supabase link --project-ref lhcxmojgkakdgywftomw
```

## Create → write → push

```powershell
# 1. Create the file
npx supabase migration new <short_description>

# 2. Edit the generated supabase/migrations/<timestamp>_<short_description>.sql
#    (tables, alter table, RLS policies, backfills)

# 3. Push to the remote database
npx supabase db push
```

## Handy commands

```powershell
npx supabase db push --dry-run   # preview without applying
npx supabase migration list      # local vs. remote status
npx supabase db reset            # re-run all migrations on local db
```

## Conventions

- One change per migration; enable RLS + policies for new tables.
- After schema changes affecting app code: `npm run typecheck` and `npm run build`.
