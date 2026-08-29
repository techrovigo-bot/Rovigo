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
