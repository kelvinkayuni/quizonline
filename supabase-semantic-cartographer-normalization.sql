create table if not exists public.semantic_cartographer_glossary (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  alias text not null check (length(alias) between 3 and 80),
  canonical_term text not null check (length(canonical_term) between 3 and 80),
  created_at timestamptz not null default now()
);

create unique index if not exists semantic_cartographer_glossary_owner_alias_idx
  on public.semantic_cartographer_glossary (owner_id, lower(alias));

create index if not exists semantic_cartographer_glossary_owner_canonical_idx
  on public.semantic_cartographer_glossary (owner_id, lower(canonical_term));

alter table public.semantic_cartographer_glossary enable row level security;
revoke all on public.semantic_cartographer_glossary from anon, authenticated;
grant select, insert, delete on public.semantic_cartographer_glossary to authenticated;

drop policy if exists "teacher manages own semantic cartographer glossary" on public.semantic_cartographer_glossary;
create policy "teacher manages own semantic cartographer glossary"
on public.semantic_cartographer_glossary
for all
to authenticated
using (
  auth.uid() = owner_id
  and coalesce(auth.jwt()->'app_metadata'->>'role', '') = 'teacher'
)
with check (
  auth.uid() = owner_id
  and coalesce(auth.jwt()->'app_metadata'->>'role', '') = 'teacher'
);