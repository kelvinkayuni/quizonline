create table if not exists public.semantic_cartographer_non_similar_pairs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  word_a text not null check (length(word_a) between 1 and 80),
  word_b text not null check (length(word_b) between 1 and 80),
  created_at timestamptz not null default now(),
  check (word_a <> word_b)
);

create unique index if not exists semantic_cartographer_non_similar_pairs_owner_words_idx
  on public.semantic_cartographer_non_similar_pairs (
    owner_id,
    least(word_a, word_b),
    greatest(word_a, word_b)
  );

alter table public.semantic_cartographer_non_similar_pairs enable row level security;
revoke all on public.semantic_cartographer_non_similar_pairs from anon, authenticated;
grant select, insert on public.semantic_cartographer_non_similar_pairs to authenticated;

drop policy if exists "teacher manages own semantic cartographer non-similar pairs" on public.semantic_cartographer_non_similar_pairs;
create policy "teacher manages own semantic cartographer non-similar pairs"
on public.semantic_cartographer_non_similar_pairs
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