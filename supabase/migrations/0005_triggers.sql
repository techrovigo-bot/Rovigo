-- 0005_triggers.sql
-- Provisionamento de conta e proteção de integridade dos scores.

-- ---------------------------------------------------------------------------
-- Ao criar um auth.user, provisiona tenant (trial de 14 dias) + profile vazio.
-- SECURITY DEFINER para escrever nas tabelas apesar da RLS.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_tenant_id uuid;
begin
  insert into public.tenants (user_id, tier, subscription_status, trial_ends_at)
  values (new.id, 'trial', 'active', now() + interval '14 days')
  returning id into new_tenant_id;

  insert into public.profiles (tenant_id, full_name)
  values (new_tenant_id, new.raw_user_meta_data ->> 'full_name');

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Impede que o painel (role authenticated) altere as colunas de scoring de um
-- match. O candidato só pode mexer em status (dismiss/save/apply). O n8n
-- (service_role) passa livre para gravar os scores.
-- Usa current_user: o PostgREST faz SET ROLE para 'authenticated'/'anon'/
-- 'service_role', então current_user reflete a chave usada, sem depender de
-- helpers do schema auth.
-- ---------------------------------------------------------------------------
create or replace function public.protect_match_scores()
returns trigger
language plpgsql
as $$
begin
  if current_user <> 'service_role' then
    new.score            := old.score;
    new.score_technical  := old.score_technical;
    new.score_experience := old.score_experience;
    new.score_behavioral := old.score_behavioral;
    new.score_career     := old.score_career;
    new.location_verdict := old.location_verdict;
    new.language_verdict := old.language_verdict;
    new.language_note    := old.language_note;
    new.verdict          := old.verdict;
    new.strengths        := old.strengths;
    new.gaps             := old.gaps;
    new.rationale        := old.rationale;
    new.model            := old.model;
    new.ranked_at        := old.ranked_at;
  end if;
  return new;
end;
$$;

create trigger job_matches_protect_scores
  before update on public.job_matches
  for each row execute function public.protect_match_scores();
