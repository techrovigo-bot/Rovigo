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
