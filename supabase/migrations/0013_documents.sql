-- 0013_documents.sql
-- v2: documentos gerados (CV e carta) por candidato×vaga, com o relatório da
-- auditoria de grounding. O conteúdo é escrito só pelo service_role (n8n); o
-- candidato lê e, no máximo, arquiva.

create type document_kind   as enum ('cv', 'cover_letter');
create type document_status as enum ('generating', 'ready', 'failed', 'archived');

create table public.documents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  job_id       uuid not null references public.jobs(id)    on delete cascade,
  kind         document_kind   not null,
  status       document_status not null default 'generating',

  -- Markdown é a fonte; o PDF é derivado e vive no Storage.
  content_md   text,
  storage_path text,                       -- {tenant_id}/{document_id}.pdf

  -- Auditoria de grounding: claims verificados, removidos e sinalizados.
  -- {claims:[{text,verdict,source|reason}], removed:[...], stretches:[...]}
  grounding_report jsonb not null default '{}',

  model        text,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- Um CV e uma carta por vaga; regerar sobrescreve.
  unique (tenant_id, job_id, kind)
);

comment on table public.documents is
  'CV e cartas gerados por vaga. Conteúdo escrito apenas pelo service_role; grounding_report registra a auditoria anti-alucinação.';
comment on column public.documents.grounding_report is
  'Relatório da auditoria: claims ancorados, removidos por falta de âncora, e os marcados como esticão (decisão do candidato).';

create index documents_tenant_created on public.documents (tenant_id, created_at desc);
create index documents_job            on public.documents (job_id);

create trigger documents_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: o candidato lê os próprios documentos e só pode mexer em `status`
-- (arquivar). Conteúdo, relatório de grounding e caminho no Storage são
-- imutáveis para ele — mesmo princípio do protect_match_scores (0005): o que a
-- IA gerou e auditou não pode ser adulterado pela própria pessoa avaliada.
-- ---------------------------------------------------------------------------
alter table public.documents enable row level security;

create policy documents_select_self on public.documents
  for select using (tenant_id = public.current_tenant_id());

create policy documents_update_self on public.documents
  for update using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create or replace function public.protect_document_content()
returns trigger
language plpgsql
as $$
begin
  if current_user <> 'service_role' then
    new.content_md       := old.content_md;
    new.storage_path     := old.storage_path;
    new.grounding_report := old.grounding_report;
    new.model            := old.model;
    new.kind             := old.kind;
    new.job_id           := old.job_id;
    new.tenant_id        := old.tenant_id;
  end if;
  return new;
end;
$$;

create trigger documents_protect_content
  before update on public.documents
  for each row execute function public.protect_document_content();

-- ---------------------------------------------------------------------------
-- Cota mensal. Conta documentos criados no mês corrente (regeração conta como
-- uso novo, porque gasta token de novo). O limite vive em feature_flags para
-- ser ajustável sem deploy.
-- ---------------------------------------------------------------------------
create or replace function public.documents_used_this_month(p_tenant uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from public.documents
  where tenant_id = p_tenant
    and created_at >= date_trunc('month', now());
$$;

revoke execute on function public.documents_used_this_month(uuid) from public;
grant execute on function public.documents_used_this_month(uuid) to service_role, authenticated;

insert into public.feature_flags (key, enabled, value, description) values
  ('docgen.enabled',       true,  '{}'::jsonb,                'Liga a geração de CV e carta.'),
  ('docgen.monthly_quota', true,  '{"limit": 5}'::jsonb,      'Documentos por tenant por mês (par CV+carta conta 2).')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- LGPD: documentos entram na portabilidade. (A exclusão já cascateia por
-- tenant_id; a limpeza do Storage é feita pelo workflow n8n, ver 0007.)
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
    'notifications', (select coalesce(jsonb_agg(to_jsonb(n)),  '[]') from public.notifications n  where n.tenant_id  = public.current_tenant_id()),
    'documents',     (select coalesce(jsonb_agg(to_jsonb(d)),  '[]') from public.documents     d  where d.tenant_id  = public.current_tenant_id())
  );
$$;

-- ---------------------------------------------------------------------------
-- Storage: bucket privado dos PDFs. Leitura só do dono (o path começa com o
-- tenant_id); escrita e remoção só pelo service_role, que não passa por RLS.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

create policy documents_storage_read_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );
