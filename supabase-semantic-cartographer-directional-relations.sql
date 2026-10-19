create table if not exists public.semantic_cartographer_directional_relations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source_document_id uuid not null references public.semantic_cartographer_documents(id) on delete cascade,
  source_text text not null check (length(source_text) between 1 and 3000),
  subject text not null check (length(btrim(subject)) between 1 and 200),
  action text not null check (length(btrim(action)) between 1 and 80),
  object text not null check (length(btrim(object)) between 1 and 200),
  polarity smallint not null default 1 check (polarity in (-1, 1)),
  created_at timestamptz not null default now()
);

create unique index if not exists semantic_cartographer_directional_relations_source_idx
  on public.semantic_cartographer_directional_relations (owner_id, source_document_id, md5(lower(source_text)));

create index if not exists semantic_cartographer_directional_relations_owner_created_idx
  on public.semantic_cartographer_directional_relations (owner_id, created_at desc);

alter table public.semantic_cartographer_directional_relations enable row level security;
revoke all on public.semantic_cartographer_directional_relations from anon, authenticated;
grant select, insert, delete on public.semantic_cartographer_directional_relations to authenticated;

drop policy if exists "teacher manages own semantic cartographer directional relations" on public.semantic_cartographer_directional_relations;
create policy "teacher manages own semantic cartographer directional relations"
on public.semantic_cartographer_directional_relations
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