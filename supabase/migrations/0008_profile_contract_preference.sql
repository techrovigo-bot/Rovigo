-- 0008_profile_contract_preference.sql
-- Preferência de vínculo do candidato. Alimenta o bônus 4b do ranking:
-- +10 em Career Alignment quando o contractType da vaga bate com esta preferência.
-- 'any' = sem preferência (nenhum bônus). Default 'any' para não beneficiar
-- ninguém sem escolha explícita.

create type public.contract_preference as enum ('clt', 'pj', 'any');

alter table public.profiles
  add column contract_preference public.contract_preference not null default 'any';

comment on column public.profiles.contract_preference is
  'Preferência de vínculo do candidato; alimenta o bônus de vínculo (4b) no ranking.';
