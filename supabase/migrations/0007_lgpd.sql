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
