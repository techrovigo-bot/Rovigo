# Teste ponta a ponta (MVP)

Valida o pipeline inteiro numa máquina: **portal-runner + rank-service + n8n** em Docker, **Supabase** de dev hospedado, e o **painel** à parte. Duas trilhas: a **A** prova o pipeline de backend sem depender de SMTP; a **B** inclui o painel e o login real.

## Atalho: script único

Se você já tem Docker + um projeto Supabase de dev + as chaves, o `scripts/e2e.sh` faz tudo (sobe a stack, aplica migrações, importa/ativa os workflows, roda ingest → embed → onboarding, e imprime a verificação):

```bash
cp .env.example .env    # preencha SUPABASE_*, DATABASE_URL, TEST_EMAIL, tokens, chaves LLM
# crie um usuário de teste em Supabase → Auth → Users → Add user (o mesmo TEST_EMAIL)
bash scripts/e2e.sh
```

Ao final, ele mostra quantas vagas entraram, quantas foram embutidas, os top matches do tenant de teste e o uso de LLM. O passo a passo manual abaixo é a versão detalhada (útil para depurar quando algo falha).

## 0. Pré-requisitos

- Docker + Docker Compose
- Node 18+ (para o painel) e, opcional, a **Supabase CLI**
- Um **projeto Supabase de dev** (crie um novo — não misture com outros bancos)
- Chaves: **OpenRouter** (ranking) e **OpenAI** (embeddings). Evolution/Resend são opcionais.

## 1. Banco: aplicar as migrações

No projeto de dev, aplique `supabase/migrations/0001` … `0011` **em ordem**.

Com a Supabase CLI:
```bash
supabase link --project-ref <ref>
supabase db push
```
Sem a CLI: cole cada arquivo de `supabase/migrations/` no **SQL Editor**, na ordem numérica. A `0006` já semeia buckets e kill-switches.

Confira:
```sql
select count(*) from public.search_buckets where active;   -- > 0
select key, enabled from public.feature_flags;             -- linkedin=false
```

## 2. Subir os serviços

```bash
cp .env.example .env          # preencha SUPABASE_*, os 2 tokens, OPENROUTER e OPENAI
docker compose up -d --build
```

Sanidade:
```bash
curl -s localhost:8080/health   # portal-runner  -> {"status":"ok",...}
curl -s localhost:8090/health   # rank-service   -> {"status":"ok",...}
```

## 3. n8n: importar e ativar os workflows

1. Abra `http://localhost:5678`, crie a conta de owner.
2. *Workflows → Import from File* para cada um em `n8n/workflows/`:
   `ingest-bucket`, `embed-jobs`, `rank-daily`, `notify-daily`, `onboarding-hook`.
3. As variáveis já vêm do container (compose). **Ative** os cinco.

> Se algum Code node reclamar de `$env`, confirme `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (já está no compose) e reinicie o n8n.

## 4. Popular vagas (rodar ingest + embeddings uma vez, à mão)

O `onboarding-hook` **ranqueia vagas que já existem** no banco — ele não faz ingest. Então rode primeiro:

1. Abra `ingest-bucket` → **Execute Workflow**. Confira:
   ```sql
   select source, count(*) from public.jobs group by 1;   -- linhas por portal
   ```
2. Abra `embed-jobs` → **Execute Workflow** (precisa de `OPENAI_API_KEY`). Confira:
   ```sql
   select count(*) filter (where embedding is not null) as com_vetor, count(*) from public.jobs;
   ```
   (Sem OpenAI, pule — o ranking cai no fallback de recência.)

---

## Trilha A — pipeline de backend (sem SMTP)

### A.1 Criar um usuário de teste
Supabase → **Authentication → Users → Add user** (email + senha). O trigger `handle_new_user` cria `tenants` + `profiles` vazios.

### A.2 Preencher o perfil por SQL
```sql
-- pegue o tenant do usuário de teste
select t.id as tenant_id
from public.tenants t join auth.users u on u.id = t.user_id
where u.email = 'teste@exemplo.com';

-- preencha o perfil (troque <TENANT>)
update public.profiles set
  target_roles = array['engenheiro de automação','ai engineer'],
  seniority = 'senior',
  cities = array['Curitiba'],
  accepts_work_models = array['remote','hybrid']::work_model[],
  languages = '[{"lang":"português","level":"native"},{"lang":"inglês","level":"reading"}]'::jsonb,
  skills = array['n8n','python','rag','api rest'],
  contract_preference = 'pj',
  headline = 'Automação e agentes de IA em produção',
  completeness = 100
where tenant_id = '<TENANT>';

-- consentimento de IA (obrigatório para ranquear)
update public.tenants set llm_consent_at = now(), llm_consent_version = 'v1'
where id = '<TENANT>';
```

### A.3 Disparar o onboarding-hook
```bash
curl -s -X POST http://localhost:5678/webhook/onboarding \
  -H "content-type: application/json" -d '{"tenant_id":"<TENANT>"}'
```
Isso embute o perfil → ranqueia → tenta notificar.

### A.4 Verificar
```sql
-- perfil embutido?
select embedding is not null as perfil_embutido from public.profiles where tenant_id='<TENANT>';

-- matches gerados (vetados + avaliados)
select status, verdict, score, (select title from public.jobs j where j.id=m.job_id)
from public.job_matches m where m.tenant_id='<TENANT>' order by score desc nulls last limit 20;

-- custo registrado
select workflow, model, tokens_in, tokens_out from public.llm_usage order by created_at desc limit 10;

-- notificação (se Evolution/Resend configurados)
select channel, status, array_length(match_ids,1) from public.notifications where tenant_id='<TENANT>';
```

**Sucesso da Trilha A:** há linhas em `job_matches` com `score` e `verdict`, `llm_usage` registrou tokens, e as vagas presenciais fora de Curitiba aparecem vetadas (`score` nulo, `location_verdict='fail'`).

---

## Trilha B — incluindo o painel

### B.1 Configurar o e-mail do Auth
Supabase → **Authentication → Providers → Email**: habilite. Para magic link real, configure **SMTP** (Auth → SMTP Settings). Sem SMTP, use a Trilha A ou o provedor de e-mail de teste do Supabase (rate-limited).

### B.2 Rodar o painel
```bash
cd panel
cp .env.example .env.local
# preencha:
#   NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY (do projeto de dev)
#   NEXT_PUBLIC_SITE_URL=http://localhost:3000
#   N8N_ONBOARDING_URL=http://localhost:5678/webhook/onboarding
npm install && npm run dev
```

### B.3 Fluxo
1. `http://localhost:3000` → **Entrar** → magic link → onboarding.
2. Preencha o perfil, marque o consentimento de IA, **Salvar**. A Server Action grava o perfil e chama o `onboarding-hook`.
3. Vá em **Vagas** — os matches aparecem (pode levar alguns segundos; recarregue).
4. **Conta** → *Exportar meus dados* baixa o JSON; *Excluir conta* apaga tudo (cascade).

---

## Critério de aceite (go do E2E)

- [ ] `jobs` populado pelo `ingest-bucket`, com embeddings pelo `embed-jobs`.
- [ ] `onboarding-hook` gera `job_matches` com score/verdito para um perfil de teste.
- [ ] Vagas fora das cidades aceitas saem **vetadas** (não gastam LLM).
- [ ] `llm_usage` registra tokens de embedding e de ranking.
- [ ] (Painel) onboarding grava perfil + consentimentos e as vagas aparecem em `/vagas`.
- [ ] (LGPD) exportar retorna o JSON; excluir remove o tenant e cascateia.

## Troubleshooting

| Sintoma | Causa provável |
|---|---|
| `401` do portal-runner/rank-service | token do `.env` diferente do enviado pelo n8n |
| n8n Code node: `$env is not defined` | `N8N_BLOCK_ENV_ACCESS_IN_NODE` não é `false` |
| `job_matches` só com vetados, sem score | `OPENROUTER_API_KEY` ausente/errada |
| `jobs.embedding` sempre nulo | `OPENAI_API_KEY` ausente; ranking usa fallback de recência |
| Webhook 404 | workflow `onboarding-hook` não está **ativo** |
| PostgREST 401/403 nas escritas | `SUPABASE_SERVICE_KEY` não é a service_role |
| Zero vagas no ingest | todos os buckets inativos, ou portais no kill-switch (`feature_flags`) |

## Limpeza
```bash
docker compose down          # mantém o volume do n8n
docker compose down -v       # apaga também o estado do n8n
```
