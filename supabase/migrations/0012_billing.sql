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
