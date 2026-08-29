# Workflows n8n

Dois workflows do MVP, versionados em git como JSON importável (`workflows/`). O código dos nós Code mora legível em `src/*.code.js` e é embutido pelo builder — nunca edite o JS dentro do JSON à mão.

```bash
bun run build-workflows.ts   # regenera workflows/*.json a partir de src/*.code.js
```

## Os cinco workflows

Cadência diária: **ingest 06:00 → embed-jobs 06:30 → rank 07:00 → notify 08:00**.

### `ingest-bucket` (diário, 06:00)
`Schedule → Ingest vagas`. Lê os buckets ativos, chama o **portal-runner** por bucket×portal×termo, deduplica e faz upsert em `jobs` (dedup por `source,external_id`; `first_seen_at` preservado, `last_seen_at` atualizado). Erro de um portal não derruba a run.

### `embed-jobs` (diário, 06:30)
`Schedule → Embutir vagas`. Pega vagas sem embedding (recentes primeiro, até `EMBED_MAX`), gera vetores no **OpenAI** (`text-embedding-3-small`, 1536 dims) em lotes e grava via RPC `set_job_embeddings`. É o que **liga o estágio 2 de verdade** — sem ele, o `rank-daily` opera no fallback de recência.

### `rank-daily` (diário, 07:00)
`Schedule → Rank por tenant`. Para cada tenant ativo: RPC `jobs_for_tenant` (recentes, não avaliadas, ordenadas por pgvector) → **rank-service** `/prepare` (gates + prompt) → **OpenRouter** (LLM) → `/assemble` (score) → upsert em `job_matches` (vetados + avaliados) → telemetria em `llm_usage`.

### `notify-daily` (diário, 08:00)
`Schedule → Notificar`. RPC `tenants_to_notify` acha os tenants com matches novos + contato. Por tenant, pega o top-N (`NOTIFY_TOP`, score ≥ `NOTIFY_MIN_SCORE`) e envia via **WhatsApp** (Evolution API, se houver número + consentimento) com **fallback e-mail** (Resend). Registra em `notifications` e marca os matches como `notified` — só no envio bem-sucedido.

### `onboarding-hook` (webhook)
`Webhook (POST /webhook/onboarding) → Embutir perfil → Rank por tenant → Notificar`. O painel chama com `{ "tenant_id": "<uuid>" }` no cadastro **e em toda atualização de perfil** (re-embute + re-ranqueia). Embute o perfil primeiro (para o estágio 2 valer já no dia 0), depois ranqueia e notifica. `Embutir perfil`, `Rank` e `Notify` são **os mesmos code files** dos crons, em modo single-tenant (leem/propagam `tenant_id`). Sem duplicação de lógica.

## Importar no n8n

1. n8n → *Workflows* → *Import from File* → escolha cada JSON em `workflows/`.
2. Os workflows não têm credenciais embutidas: usam **variáveis de ambiente** (abaixo). Garanta que o acesso a env no Code node está liberado (`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, que é o default).
3. Ative cada workflow. Ajuste os horários do Schedule se quiser.

## Variáveis de ambiente (na instância n8n)

| Var | Usada por | O quê |
|---|---|---|
| `SUPABASE_URL` | ambos | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | ambos | **service_role** key (ignora RLS; nunca exponha no painel) |
| `PORTAL_RUNNER_URL` | ingest | ex.: `http://portal-runner:8080` |
| `PORTAL_RUNNER_TOKEN` | ingest | Bearer do portal-runner |
| `RANK_SERVICE_URL` | rank | ex.: `http://rank-service:8090` |
| `RANK_SERVICE_TOKEN` | rank | Bearer do rank-service |
| `OPENROUTER_API_KEY` | rank | chave do provedor de LLM |
| `RANK_MODEL` | rank | opcional; default `anthropic/claude-3.5-haiku` |
| `OPENAI_API_KEY` | embed | embeddings (`text-embedding-3-small`) |
| `EMBED_MODEL` `EMBED_MAX` `EMBED_BATCH` | embed | opcionais; default `text-embedding-3-small`, 500, 100 |
| `EVOLUTION_URL` `EVOLUTION_INSTANCE` `EVOLUTION_API_KEY` | notify | WhatsApp via Evolution API (beta) |
| `RESEND_API_KEY` `NOTIFY_FROM_EMAIL` | notify | fallback e-mail |
| `NOTIFY_MIN_SCORE` `NOTIFY_TOP` | notify | opcionais; default 60 e 5 |
| `PANEL_URL` | notify | opcional; link "ver todas" na mensagem |

> **WhatsApp em escala:** Evolution API serve o beta; antes de cobrar em volume, migre para a WhatsApp Business Cloud API oficial (risco de banimento do número em notificação comercial em massa). A troca é isolada nas funções `sendWhatsApp`/`sendEmail` do `src/notify.code.js`.

## Dependências no banco

- Migrações `0001`–`0011` aplicadas. `rank-daily` depende da RPC `jobs_for_tenant` (0009) e de `profiles.contract_preference` (0008); `notify-daily` depende de `tenants_to_notify` (0010); `embed-jobs`/`onboarding-hook` dependem de `set_job_embeddings`/`set_profile_embedding` (0011).
- Escrita via PostgREST com a service_role key (bypassa RLS). Upserts usam `on_conflict` + `Prefer: resolution=merge-duplicates`.

## Escala e cadência

Um cron por dia por workflow. O volume contra os portais cresce com o número de **buckets**, não de clientes (o portal-runner ainda serializa por portal). Rodar em queue mode (workers + Redis) mantém o batch de ranking fora do processo do webhook de onboarding.

## Ainda fora do MVP mínimo (próximas peças)

- Painel Next.js (onboarding com consentimentos LGPD + listagem) — é ele quem chama o `onboarding-hook`.
- `cost_brl` real em `llm_usage` (tabela de preço por modelo; hoje só tokens).
- Teste ponta a ponta numa instância n8n real com 1 tenant.
