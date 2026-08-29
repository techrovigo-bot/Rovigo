-- ============================================================
-- migrations/0001_extensions.sql
-- ============================================================
-- 0001_extensions.sql
-- Extensões necessárias para o schema.
-- pgvector: embeddings de perfil e de vaga para a pré-triagem por similaridade (estágio 2 do ranking).
-- pgcrypto: gen_random_uuid() para chaves primárias.
-- No Supabase, extensões vivem no schema "extensions".

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ============================================================
-- migrations/0002_enums_and_helpers.sql
-- ============================================================
-- 0002_enums_and_helpers.sql
-- Tipos enumerados e funções auxiliares reutilizadas pelas tabelas e políticas RLS.

-- Origem da vaga. LinkedIn fica FORA do produto comercial (ToS "personal use only");
-- o valor existe no enum só para não quebrar caso um dado legado seja importado, mas
-- nenhum workflow do produto deve gravar 'linkedin'.
create type public.job_source as enum ('gupy', 'catho', 'vagas', 'linkedin', 'other');

-- Estado de um match candidato×vaga na esteira e no painel.
create type public.match_status as enum (
  'ranked',        -- pontuado pelo LLM, aguardando notificação
  'notified',      -- já enviado ao candidato
  'dismissed',     -- candidato marcou "não me interessa"
  'saved',         -- candidato salvou para depois
  'applied'        -- candidato marcou que aplicou (funil, v3)
);

create type public.notification_channel as enum ('whatsapp', 'email');
create type public.notification_status as enum ('queued', 'sent', 'delivered', 'failed');

-- Tiers de assinatura, alinhados às fases do produto.
create type public.subscription_tier as enum ('trial', 'alertas', 'pro');
create type public.subscription_status as enum ('active', 'past_due', 'canceled', 'expired');

-- Verdito dos gates determinísticos (estágio 1 do ranking) e do gate de idioma.
-- Espelha o vocabulário do framework atual (04-job-evaluation.md).
create type public.gate_verdict as enum ('pass', 'fail', 'flag');

-- Modelo de trabalho aceito pelo candidato / exigido pela vaga.
create type public.work_model as enum ('remote', 'hybrid', 'onsite');

-- Helper current_tenant_id() é criado em 0003, após a tabela tenants existir
-- (funções language sql têm o corpo validado na criação).

-- Trigger genérico de updated_at.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- migrations/0003_core_tables.sql
-- ============================================================
-- 0003_core_tables.sql
-- Tabelas core do MVP. Embeddings usam vector(1536) = OpenAI text-embedding-3-small
-- (barato; troca de modelo exige recriar a coluna e reindexar).

-- ===========================================================================
-- tenants — a conta do candidato. No B2C é 1:1 com auth.users; a tabela própria
-- mantém tenant_id como chave de isolamento e abre espaço para B2B no futuro.
-- ===========================================================================
create table public.tenants (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null unique references auth.users (id) on delete cascade,
  tier                 public.subscription_tier   not null default 'trial',
  subscription_status  public.subscription_status not null default 'active',
  trial_ends_at        timestamptz,
  canceled_at          timestamptz,            -- marca o início da janela de retenção (90 dias)

  -- Contato / entrega
  whatsapp_number      text,                   -- E.164; validado na aplicação

  -- Consentimentos LGPD, com timestamp e versão dos termos aceitos.
  -- Sem consentimento de LLM, o perfil não é enviado a provedores de IA.
  llm_consent_at       timestamptz,
  llm_consent_version  text,
  whatsapp_consent_at  timestamptz,
  whatsapp_consent_version text,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table public.tenants is 'Conta do candidato. tenant_id isola todos os dados pessoais via RLS.';

create trigger tenants_set_updated_at
  before update on public.tenants
  for each row execute function public.set_updated_at();

-- Helper de tenant (criado aqui, após a tabela existir). Todo acesso do painel
-- é isolado por este id; o n8n usa service_role e ignora RLS.
-- SECURITY DEFINER evita recursão de RLS ao consultar a própria tabela tenants.
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.tenants where user_id = auth.uid()
$$;

comment on function public.current_tenant_id() is
  'Retorna o tenant_id do usuário autenticado (auth.uid()). Base de todas as políticas RLS por tenant.';

-- ===========================================================================
-- profiles — perfil estruturado do candidato (equivalente ao /setup).
-- 1:1 com tenants. Não guarda CPF/RG/endereço completo (minimização LGPD:
-- não são necessários para ranking nem geração e nunca vão a um LLM).
-- ===========================================================================
create table public.profiles (
  tenant_id            uuid primary key references public.tenants (id) on delete cascade,
  full_name            text,
  headline             text,
  target_roles         text[]  not null default '{}',   -- funções-alvo, não títulos literais
  seniority            text,                             -- ex.: junior/pleno/senior/especialista
  cities               text[]  not null default '{}',   -- cidades aceitas (base do gate de localização)
  accepts_work_models  public.work_model[] not null default '{}',
  languages            jsonb   not null default '[]',    -- [{lang, level}] — base do gate de idioma
  skills               text[]  not null default '{}',
  salary_expectation   integer,                          -- BRL/mês; opcional
  professional_history jsonb   not null default '[]',    -- detalhe rico (v2, extração de CV)
  embedding            extensions.vector(1536),          -- similaridade perfil×vaga (estágio 2)
  completeness         smallint not null default 0,      -- 0-100, calculado na aplicação
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table public.profiles is 'Perfil estruturado do candidato. Fonte de verdade da auditoria de grounding (v2).';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- search_buckets — taxonomia finita de buscas agregadas (cargo × região).
-- É o que desacopla o volume de scraping do número de clientes.
-- ===========================================================================
create table public.search_buckets (
  id           uuid primary key default gen_random_uuid(),
  key          text not null unique,               -- ex.: 'dados-sp', 'dev-backend-remoto'
  label        text not null,
  category     text not null,                       -- família de cargo
  region       text not null,                       -- UF, cidade ou 'remoto'
  query_terms  jsonb not null default '{}',         -- termos por portal: {gupy:[...], catho:[...]}
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
comment on table public.search_buckets is 'Buckets de busca agregada. Um cron por bucket/dia contra os portais.';

create trigger search_buckets_set_updated_at
  before update on public.search_buckets
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- tenant_buckets — N:N. Cada candidato mapeado para 1-3 buckets no onboarding.
-- ===========================================================================
create table public.tenant_buckets (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  bucket_id  uuid not null references public.search_buckets (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (tenant_id, bucket_id)
);
create index tenant_buckets_bucket_idx on public.tenant_buckets (bucket_id);

-- ===========================================================================
-- jobs — tabela GLOBAL de vagas (sem tenant). Substitui seen_jobs.json.
-- Deduplicada por (source, external_id). O ranking por cliente lê daqui.
-- ===========================================================================
create table public.jobs (
  id           uuid primary key default gen_random_uuid(),
  source       public.job_source not null,
  external_id  text not null,                       -- id do portal
  url          text not null,
  title        text not null,
  company      text,
  location     text,
  work_model   public.work_model,
  description  text,
  posted_at    timestamptz,
  deadline     date,
  raw          jsonb,                                -- payload bruto do CLI, para debug/reprocesso
  embedding    extensions.vector(1536),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (source, external_id)
);
comment on table public.jobs is 'Vagas globais deduplicadas. Escrita apenas pelo n8n (service_role).';

create index jobs_posted_at_idx on public.jobs (posted_at desc);
create index jobs_company_idx on public.jobs (company);
-- Índice ANN para a pré-triagem por similaridade (cosine).
create index jobs_embedding_idx on public.jobs
  using hnsw (embedding extensions.vector_cosine_ops);

-- ===========================================================================
-- job_matches — resultado do ranking, um por (tenant, vaga). Espelha os campos
-- que o /rank hoje grava em seen_jobs.json.
-- ===========================================================================
create table public.job_matches (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  job_id            uuid not null references public.jobs (id) on delete cascade,
  score             smallint,                        -- 0-100 (peso 30/25/15/30)
  score_technical   smallint,
  score_experience  smallint,
  score_behavioral  smallint,
  score_career      smallint,
  location_verdict  public.gate_verdict,
  language_verdict  public.gate_verdict,
  language_note     text,
  verdict           text,                            -- banda: Strong/Good/Moderate/Weak/Poor Fit
  strengths         text[] not null default '{}',
  gaps              text[] not null default '{}',
  rationale         text,
  model             text,                            -- modelo usado no scoring
  status            public.match_status not null default 'ranked',
  ranked_at         timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, job_id)
);
comment on table public.job_matches is 'Score de fit por candidato×vaga. Alimenta painel e notificações.';

create index job_matches_tenant_status_score_idx
  on public.job_matches (tenant_id, status, score desc);
create index job_matches_job_idx on public.job_matches (job_id);

create trigger job_matches_set_updated_at
  before update on public.job_matches
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- notifications — registro de cada envio (WhatsApp/e-mail).
-- ===========================================================================
create table public.notifications (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  channel        public.notification_channel not null,
  status         public.notification_status  not null default 'queued',
  match_ids      uuid[] not null default '{}',       -- job_matches incluídos no push
  payload        jsonb,
  error          text,
  sent_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index notifications_tenant_created_idx
  on public.notifications (tenant_id, created_at desc);

-- ===========================================================================
-- llm_usage — telemetria de custo por execução e por tenant. Insumo de
-- pricing, de alerta de tenant anômalo e do critério de validação do beta.
-- tenant_id é nullable (tarefas sem tenant, ex.: embedding de vaga).
-- ===========================================================================
create table public.llm_usage (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants (id) on delete set null,
  workflow    text not null,                         -- ex.: 'rank-daily', 'generate-cv'
  model       text not null,
  tokens_in   integer not null default 0,
  tokens_out  integer not null default 0,
  cost_brl    numeric(10,5) not null default 0,
  meta        jsonb,
  created_at  timestamptz not null default now()
);
create index llm_usage_tenant_created_idx on public.llm_usage (tenant_id, created_at desc);
create index llm_usage_workflow_created_idx on public.llm_usage (workflow, created_at desc);

-- ===========================================================================
-- execution_errors — log central de falhas (error workflow global do n8n).
-- ===========================================================================
create table public.execution_errors (
  id          uuid primary key default gen_random_uuid(),
  workflow    text not null,
  tenant_id   uuid references public.tenants (id) on delete set null,
  portal      public.job_source,
  message     text not null,
  context     jsonb,
  created_at  timestamptz not null default now()
);
create index execution_errors_created_idx on public.execution_errors (created_at desc);

-- ===========================================================================
-- feature_flags — kill-switch por portal/tenant e chaveamento de features.
-- ===========================================================================
create table public.feature_flags (
  key         text primary key,                      -- ex.: 'portal.catho.enabled'
  enabled     boolean not null default true,
  value       jsonb,
  description text,
  updated_at  timestamptz not null default now()
);

create trigger feature_flags_set_updated_at
  before update on public.feature_flags
  for each row execute function public.set_updated_at();

-- ============================================================
-- migrations/0004_rls.sql
-- ============================================================
-- 0004_rls.sql
-- Row Level Security. Protege o acesso vindo do painel (chaves anon/authenticated).
-- O n8n usa a service_role key, que IGNORA RLS — toda escrita de pipeline passa por lá.
-- Tabelas com RLS habilitado e SEM policy ficam inacessíveis ao painel por padrão
-- (llm_usage, execution_errors, feature_flags): dados internos, só service_role.

alter table public.tenants          enable row level security;
alter table public.profiles         enable row level security;
alter table public.search_buckets   enable row level security;
alter table public.tenant_buckets   enable row level security;
alter table public.jobs             enable row level security;
alter table public.job_matches      enable row level security;
alter table public.notifications    enable row level security;
alter table public.llm_usage        enable row level security;
alter table public.execution_errors enable row level security;
alter table public.feature_flags    enable row level security;

-- tenants: o candidato enxerga e edita só a própria conta. INSERT é feito pelo
-- trigger de criação de usuário (service). DELETE self-service = exclusão de conta.
create policy tenants_select_self on public.tenants
  for select using (user_id = auth.uid());
create policy tenants_update_self on public.tenants
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy tenants_delete_self on public.tenants
  for delete using (user_id = auth.uid());

-- profiles: CRUD restrito ao próprio tenant.
create policy profiles_all_self on public.profiles
  for all using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- search_buckets: leitura para autenticados (onboarding pode listar/mapear);
-- escrita só service_role.
create policy search_buckets_select_auth on public.search_buckets
  for select to authenticated using (true);

-- tenant_buckets: o candidato vê e gerencia os próprios mapeamentos.
create policy tenant_buckets_all_self on public.tenant_buckets
  for all using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- jobs: vagas são públicas; leitura para autenticados (o painel faz join a partir
-- de job_matches). Escrita só service_role.
create policy jobs_select_auth on public.jobs
  for select to authenticated using (true);

-- job_matches: o candidato lê os próprios matches e pode atualizar (dismiss/save/apply).
-- A proteção contra adulteração de score está no trigger em 0005.
create policy job_matches_select_self on public.job_matches
  for select using (tenant_id = public.current_tenant_id());
create policy job_matches_update_self on public.job_matches
  for update using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- notifications: só leitura do próprio histórico.
create policy notifications_select_self on public.notifications
  for select using (tenant_id = public.current_tenant_id());

-- ============================================================
-- migrations/0005_triggers.sql
-- ============================================================
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

-- ============================================================
-- migrations/0006_seed.sql
-- ============================================================
-- 0006_seed.sql
-- Dados iniciais: kill-switches de portal e alguns buckets de exemplo.
-- Os buckets definitivos dependem dos perfis dos betas (semanas 3-4); estes
-- servem só para o pipeline rodar ponta a ponta em teste.

-- Kill-switch por portal. LinkedIn desligado no produto comercial (ToS).
insert into public.feature_flags (key, enabled, description) values
  ('portal.gupy.enabled',     true,  'Gupy — API pública, portal âncora do MVP'),
  ('portal.catho.enabled',    true,  'Catho — scraping HTML, modo conservador'),
  ('portal.vagas.enabled',    true,  'Vagas.com — scraping HTML, modo conservador'),
  ('portal.linkedin.enabled', false, 'LinkedIn — DESLIGADO no produto comercial (ToS personal use only)')
on conflict (key) do nothing;

-- Buckets de exemplo (cargo × região). query_terms traz os termos por portal.
insert into public.search_buckets (key, label, category, region, query_terms) values
  ('automacao-ia-remoto', 'Automação e IA — Remoto', 'automacao-ia', 'remoto',
   '{"gupy": ["automação", "inteligência artificial", "n8n"], "catho": ["automação de processos"], "vagas": ["automação", "inteligência artificial"]}'),
  ('dev-backend-remoto', 'Desenvolvimento Backend — Remoto', 'dev-backend', 'remoto',
   '{"gupy": ["desenvolvedor backend", "engenheiro de software"], "catho": ["desenvolvedor"], "vagas": ["desenvolvedor backend"]}'),
  ('dados-sp', 'Dados — São Paulo', 'dados', 'SP',
   '{"gupy": ["analista de dados", "engenheiro de dados"], "catho": ["analista de dados"], "vagas": ["analista de dados"]}')
on conflict (key) do nothing;

-- ============================================================
-- migrations/0007_lgpd.sql
-- ============================================================
-- 0007_lgpd.sql
-- Direitos do titular: portabilidade (export) e exclusão (delete self-service).
-- Ambas operam sobre o tenant do usuário autenticado.

-- ---------------------------------------------------------------------------
-- Portabilidade: retorna todos os dados pessoais do candidato em um JSON.
-- Usa current_tenant_id(); a RLS já garantiria o isolamento, mas a função
-- centraliza a montagem para o painel chamar num clique.
-- ---------------------------------------------------------------------------
create or replace function public.export_my_data()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'exported_at', now(),
    'tenant',        (select to_jsonb(t) from public.tenants  t where t.id = public.current_tenant_id()),
    'profile',       (select to_jsonb(p) from public.profiles p where p.tenant_id = public.current_tenant_id()),
    'buckets',       (select coalesce(jsonb_agg(to_jsonb(tb)), '[]') from public.tenant_buckets tb where tb.tenant_id = public.current_tenant_id()),
    'matches',       (select coalesce(jsonb_agg(to_jsonb(m)),  '[]') from public.job_matches   m  where m.tenant_id  = public.current_tenant_id()),
    'notifications', (select coalesce(jsonb_agg(to_jsonb(n)),  '[]') from public.notifications n  where n.tenant_id  = public.current_tenant_id())
  );
$$;

comment on function public.export_my_data() is
  'LGPD portabilidade: dump JSON dos dados pessoais do tenant autenticado.';

-- ---------------------------------------------------------------------------
-- Exclusão self-service. Deleta o auth.user do próprio candidato; o
-- ON DELETE CASCADE em tenants.user_id remove tenant, profile, buckets,
-- matches e notifications. Arquivos no Supabase Storage NÃO são cobertos por
-- SQL — um workflow n8n (ou edge function) que escute a exclusão deve limpar
-- o bucket de Storage do tenant (documentos gerados na v2).
-- SECURITY DEFINER com owner postgres para poder apagar em auth.users.
-- ---------------------------------------------------------------------------
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from auth.users where id = auth.uid();
end;
$$;

comment on function public.delete_my_account() is
  'LGPD exclusão: apaga a conta do usuário autenticado; cascade limpa os dados. Storage é limpo por workflow externo.';

-- Expõe as funções às roles do painel.
grant execute on function public.export_my_data()   to authenticated;
grant execute on function public.delete_my_account() to authenticated;

-- ============================================================
-- migrations/0008_profile_contract_preference.sql
-- ============================================================
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

-- ============================================================
-- migrations/0009_match_rpc.sql
-- ============================================================
-- 0009_match_rpc.sql
-- RPC que o rank-daily chama por tenant: devolve as vagas candidatas a ranking —
-- recentes, ainda SEM job_match para este tenant, ordenadas por similaridade
-- pgvector entre o embedding do perfil e o da vaga (estágio 2).
--
-- Fallback gracioso: enquanto embeddings não estiverem populados (perfil ou
-- vaga com embedding NULL), ordena por recência. Assim o MVP roda antes de
-- ligar a geração de embeddings.

create or replace function public.jobs_for_tenant(
  p_tenant uuid,
  p_limit int default 30,
  p_days int default 3
)
returns setof public.jobs
language sql
stable
as $$
  with pe as (
    select embedding from public.profiles where tenant_id = p_tenant
  )
  select j.*
  from public.jobs j
  where j.first_seen_at >= now() - make_interval(days => p_days)
    and not exists (
      select 1 from public.job_matches m
      where m.tenant_id = p_tenant and m.job_id = j.id
    )
  order by
    case
      when j.embedding is not null and (select embedding from pe) is not null
        then (j.embedding <=> (select embedding from pe))
      else null
    end asc nulls last,
    j.first_seen_at desc
  limit p_limit
$$;

comment on function public.jobs_for_tenant(uuid, int, int) is
  'Vagas candidatas a ranking para um tenant: recentes, não-avaliadas, ordenadas por similaridade pgvector (fallback recência).';

-- Segurança: por padrão o Postgres concede EXECUTE a PUBLIC. Revogar e liberar
-- só para service_role (a chave que o n8n usa). O painel (authenticated) não
-- pode chamar — evita que um tenant peça vagas de outro passando p_tenant.
revoke execute on function public.jobs_for_tenant(uuid, int, int) from public;
grant execute on function public.jobs_for_tenant(uuid, int, int) to service_role;

-- ============================================================
-- migrations/0010_notify_rpc.sql
-- ============================================================
-- 0010_notify_rpc.sql
-- RPC que o notify-daily usa para achar quem notificar: tenants ativos que têm
-- pelo menos um job_match novo (ranked + com score), com o contato (WhatsApp do
-- tenant + e-mail do auth.users). SECURITY DEFINER para ler auth.users; exposta
-- só à service_role (o painel nunca chama).
--
-- p_tenant opcional: null = todos os elegíveis (cron); um id = só aquele
-- (onboarding-hook, dia 0).

create or replace function public.tenants_to_notify(p_tenant uuid default null)
returns table (
  tenant_id uuid,
  email text,
  whatsapp_number text,
  whatsapp_consent_at timestamptz
)
language sql
stable
security definer
set search_path = public, auth
as $$
  select t.id, u.email::text, t.whatsapp_number, t.whatsapp_consent_at
  from public.tenants t
  join auth.users u on u.id = t.user_id
  where t.subscription_status = 'active'
    and (p_tenant is null or t.id = p_tenant)
    and exists (
      select 1 from public.job_matches m
      where m.tenant_id = t.id and m.status = 'ranked' and m.score is not null
    )
$$;

comment on function public.tenants_to_notify(uuid) is
  'Tenants ativos com matches novos a notificar + contato (WhatsApp e e-mail). service_role apenas.';

revoke execute on function public.tenants_to_notify(uuid) from public;
grant execute on function public.tenants_to_notify(uuid) to service_role;

-- ============================================================
-- migrations/0011_embedding_rpc.sql
-- ============================================================
-- 0011_embedding_rpc.sql
-- Escrita de embeddings via RPC (o n8n gera o vetor no OpenAI e grava por aqui).
-- Passar o vetor como texto "[...]" e castar para vector no banco evita depender
-- da (frágil) serialização do tipo vector pelo PostgREST. service_role apenas.

-- Grava embeddings de várias vagas de uma vez.
-- p = [{"id":"<uuid>","embedding":[0.1,0.2,...]}, ...]
create or replace function public.set_job_embeddings(p jsonb)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r jsonb;
  n int := 0;
begin
  for r in select * from jsonb_array_elements(p)
  loop
    update public.jobs
      set embedding = (r->>'embedding')::vector
      where id = (r->>'id')::uuid;
    if found then n := n + 1; end if;
  end loop;
  return n;
end;
$$;

comment on function public.set_job_embeddings(jsonb) is
  'Grava embeddings de vagas em lote. p = [{id, embedding[]}]. service_role apenas.';

-- Grava o embedding de um perfil.
create or replace function public.set_profile_embedding(p_tenant uuid, p_embedding text)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  update public.profiles set embedding = p_embedding::vector where tenant_id = p_tenant;
$$;

comment on function public.set_profile_embedding(uuid, text) is
  'Grava o embedding de um perfil (vetor como texto "[...]"). service_role apenas.';

revoke execute on function public.set_job_embeddings(jsonb) from public;
revoke execute on function public.set_profile_embedding(uuid, text) from public;
grant execute on function public.set_job_embeddings(jsonb) to service_role;
grant execute on function public.set_profile_embedding(uuid, text) to service_role;

-- ============================================================
-- migrations/0012_billing.sql
-- ============================================================
-- 0012_billing.sql
-- Vínculo com o Stripe e entitlement por trial. Os tiers (trial/alertas/pro) e
-- subscription_status já existem em tenants (0003). Aqui: campos do Stripe, a
-- varredura de trials expirados e o entitlement no notify.

alter table public.tenants
  add column stripe_customer_id     text,
  add column stripe_subscription_id text,
  add column price_id               text,
  add column current_period_end     timestamptz;

comment on column public.tenants.current_period_end is
  'Fim do período pago atual (Stripe). Para pagos, entitlement vale enquanto status=active.';

-- Marca como 'expired' os trials cujo prazo passou (para a UI e a analítica
-- refletirem a realidade). O rank-daily chama isso no início de cada rodada.
-- O processamento em si já exclui trials expirados no filtro de seleção, mas
-- flipar o status mantém tudo consistente. service_role apenas.
create or replace function public.expire_trials()
returns int
language sql
security definer
set search_path = public
as $$
  with upd as (
    update public.tenants
      set subscription_status = 'expired'
    where tier = 'trial'
      and subscription_status = 'active'
      and trial_ends_at is not null
      and trial_ends_at <= now()
    returning 1
  )
  select count(*)::int from upd;
$$;

revoke execute on function public.expire_trials() from public;
grant execute on function public.expire_trials() to service_role;

-- Redefine tenants_to_notify (0010) para exigir entitlement: pagos ativos, ou
-- trials ainda dentro do prazo. Mesma condição que o rank-daily aplica.
create or replace function public.tenants_to_notify(p_tenant uuid default null)
returns table (
  tenant_id uuid,
  email text,
  whatsapp_number text,
  whatsapp_consent_at timestamptz
)
language sql
stable
security definer
set search_path = public, auth
as $$
  select t.id, u.email::text, t.whatsapp_number, t.whatsapp_consent_at
  from public.tenants t
  join auth.users u on u.id = t.user_id
  where t.subscription_status = 'active'
    and (t.tier <> 'trial' or t.trial_ends_at is null or t.trial_ends_at > now())
    and (p_tenant is null or t.id = p_tenant)
    and exists (
      select 1 from public.job_matches m
      where m.tenant_id = t.id and m.status = 'ranked' and m.score is not null
    )
$$;

