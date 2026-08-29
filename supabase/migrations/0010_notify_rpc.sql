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
