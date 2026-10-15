alter table public.semantic_cartographer_non_similar_pairs
  add column if not exists negative_form text,
  add column if not exists base_word text;

update public.semantic_cartographer_non_similar_pairs
set negative_form = case
      when (lower(word_a) = 'is' and lower(word_b) = 'isn''t') or (lower(word_b) = 'is' and lower(word_a) = 'isn''t') then 'isn''t'
      when (lower(word_a) = 'has' and lower(word_b) = 'hasn''t') or (lower(word_b) = 'has' and lower(word_a) = 'hasn''t') then 'hasn''t'
      when (lower(word_a) in ('doe', 'does') and lower(word_b) = 'doesn''t') or (lower(word_b) in ('doe', 'does') and lower(word_a) = 'doesn''t') then 'doesn''t'
      when (lower(word_a) = 'can' and lower(word_b) = 'can''t') or (lower(word_b) = 'can' and lower(word_a) = 'can''t') then 'can''t'
      when (lower(word_a) = 'will' and lower(word_b) = 'won''t') or (lower(word_b) = 'will' and lower(word_a) = 'won''t') then 'won''t'
      when (lower(word_a) = 'did' and lower(word_b) = 'didn''t') or (lower(word_b) = 'did' and lower(word_a) = 'didn''t') then 'didn''t'
      else negative_form
    end,
    base_word = case
      when (lower(word_a) = 'is' and lower(word_b) = 'isn''t') or (lower(word_b) = 'is' and lower(word_a) = 'isn''t') then 'is'
      when (lower(word_a) = 'has' and lower(word_b) = 'hasn''t') or (lower(word_b) = 'has' and lower(word_a) = 'hasn''t') then 'has'
      when (lower(word_a) in ('doe', 'does') and lower(word_b) = 'doesn''t') or (lower(word_b) in ('doe', 'does') and lower(word_a) = 'doesn''t') then 'does'
      when (lower(word_a) = 'can' and lower(word_b) = 'can''t') or (lower(word_b) = 'can' and lower(word_a) = 'can''t') then 'can'
      when (lower(word_a) = 'will' and lower(word_b) = 'won''t') or (lower(word_b) = 'will' and lower(word_a) = 'won''t') then 'will'
      when (lower(word_a) = 'did' and lower(word_b) = 'didn''t') or (lower(word_b) = 'did' and lower(word_a) = 'didn''t') then 'did'
      else base_word
    end
where negative_form is null and base_word is null;

create unique index if not exists semantic_cartographer_non_similar_pairs_owner_direction_idx
  on public.semantic_cartographer_non_similar_pairs (owner_id, lower(negative_form), lower(base_word))
  where negative_form is not null and base_word is not null;