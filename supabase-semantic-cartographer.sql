create table if not exists public.semantic_cartographer_documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  source_type text not null check (source_type in ('pdf', 'text')),
  text_content text not null check (length(text_content) between 40 and 300000),
  word_count integer not null default 0 check (word_count >= 0),
  created_at timestamptz not null default now()
);

create index if not exists semantic_cartographer_documents_owner_created_idx
  on public.semantic_cartographer_documents (owner_id, created_at desc);

alter table public.semantic_cartographer_documents enable row level security;
revoke all on public.semantic_cartographer_documents from anon, authenticated;
grant select, insert, delete on public.semantic_cartographer_documents to authenticated;

drop policy if exists "teacher manages own semantic cartographer documents" on public.semantic_cartographer_documents;
create policy "teacher manages own semantic cartographer documents"
on public.semantic_cartographer_documents
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