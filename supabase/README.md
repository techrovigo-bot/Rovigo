# Schema — rovigo-jobs

Migrações do banco (Supabase/Postgres) para o SaaS de busca de emprego. Ordem de aplicação por nome de arquivo.

| Arquivo | O que cria |
|---|---|
| `0001_extensions.sql` | `vector` (pgvector, embeddings) e `pgcrypto` |
| `0002_enums_and_helpers.sql` | Enums (`job_source`, `match_status`, tiers, gates…) e `set_updated_at()` |
| `0003_core_tables.sql` | Tabelas core + índices + `current_tenant_id()` |
| `0004_rls.sql` | Row Level Security por `tenant_id` |
| `0005_triggers.sql` | Provisionamento de conta e proteção de scores |
| `0006_seed.sql` | Kill-switches de portal e buckets de exemplo |
| `0007_lgpd.sql` | `export_my_data()` e `delete_my_account()` |
| `0008_profile_contract_preference.sql` | Coluna `profiles.contract_preference` (bônus de vínculo do ranking) |
| `0009_match_rpc.sql` | RPC `jobs_for_tenant` (vagas candidatas por pgvector, service_role) |
| `0010_notify_rpc.sql` | RPC `tenants_to_notify` (quem notificar + contato, service_role) |
| `0011_embedding_rpc.sql` | RPCs `set_job_embeddings` / `set_profile_embedding` (grava vetores, service_role) |
| `0012_billing.sql` | Campos Stripe em `tenants`, `expire_trials()` e entitlement no `tenants_to_notify` |

## Modelo de isolamento

- **Painel** (chave `anon`/`authenticated`): RLS filtra tudo por `current_tenant_id()`. O candidato só enxerga a própria conta, perfil, buckets, matches e notificações.
- **n8n** (chave `service_role`): ignora RLS. Toda escrita de pipeline (ingest de vagas, ranking, notificação) passa por aqui.
- `jobs` é **global** (sem tenant), deduplicada por `(source, external_id)` — substitui o antigo `seen_jobs.json`.
- Tabelas internas sem policy (`llm_usage`, `execution_errors`, `feature_flags`) ficam inacessíveis ao painel por padrão.

## Decisões que dependem de operação, não do schema

- **Storage** (documentos gerados na v2): a exclusão de conta (`delete_my_account()`) limpa o Postgres via cascade, mas **não** o Storage. Um workflow n8n que escute a exclusão precisa limpar o bucket do tenant.
- **Dimensão do embedding**: `vector(1536)` = OpenAI `text-embedding-3-small`. Trocar de modelo exige recriar a coluna e reindexar (`jobs_embedding_idx`).
- **LinkedIn**: enum `job_source` inclui `'linkedin'` por compatibilidade, mas `feature_flags` já traz `portal.linkedin.enabled = false`. Não gravar vagas de LinkedIn no produto comercial (ToS).

## Como aplicar

Local, com Supabase CLI:

```bash
supabase db reset          # aplica todas as migrations num banco local limpo
```

Remoto (projeto Supabase existente): revisar antes, então `supabase db push`, ou aplicar via painel SQL/MCP. **Ainda não validado contra um Postgres real** — falta rodar `db reset` num ambiente com as extensões disponíveis.
