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
