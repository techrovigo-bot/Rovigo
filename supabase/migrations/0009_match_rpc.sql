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
