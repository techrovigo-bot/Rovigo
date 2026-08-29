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
