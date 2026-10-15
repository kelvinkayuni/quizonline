create table if not exists public.semantic_cartographer_coordinates (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  term text not null check (length(term) between 1 and 100),
  x double precision not null check (x between -1 and 1),
  y double precision not null check (y between -1 and 1),
  model_signature text not null check (length(model_signature) between 1 and 80),
  updated_at timestamptz not null default now(),
  primary key (owner_id, term)
);

alter table public.semantic_cartographer_coordinates enable row level security;
revoke all on public.semantic_cartographer_coordinates from anon, authenticated;
grant select, insert, update, delete on public.semantic_cartographer_coordinates to authenticated;

drop policy if exists "teacher manages own semantic cartographer coordinates" on public.semantic_cartographer_coordinates;
create policy "teacher manages own semantic cartographer coordinates"
on public.semantic_cartographer_coordinates
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