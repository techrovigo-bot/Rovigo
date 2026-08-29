# Rovigo Jobs (nome de trabalho)

SaaS B2C para candidatos brasileiros: você diz o que procura uma vez, e todo dia buscamos as vagas novas nos portais, pontuamos o fit contra o seu perfil e mandamos só as melhores por WhatsApp/e-mail. Backend orquestrado por **n8n auto-hospedado**.

> Deriva do framework MIT de Mads Lorentzen — ver `NOTICE`. Nome/branding "AI Job Search" e a mascote não são reusados.

## Arquitetura

```
Painel Next.js (Vercel) ──┐
Candidato ── WhatsApp ─────┤
                           ▼
              n8n self-hosted (workflows compartilhados, tenant_id nos dados)
                           │
   ┌───────────────┬───────┴────────┬───────────────┐
   ▼               ▼                ▼               ▼
portal-runner   Supabase          rank-service    OpenAI/OpenRouter
(CLIs bun)      (Postgres+pgvector (gates+prompt   (embeddings, LLM)
                 +Auth+RLS)         +score)
```

Ranking em 3 estágios por custo: **gates determinísticos** (localização/idioma/senioridade, zero token) → **pgvector** (top-N por similaridade) → **LLM** (4 dimensões 30/25/15/30). O overall é calculado em código, não pelo LLM.

## Componentes

| Pasta | O quê | Estado |
|---|---|---|
| `supabase/` | 12 migrações (schema, RLS, RPCs, billing) | validado no Postgres real |
| `portal-runner/` | serviço HTTP sobre os CLIs de portal (Gupy/Catho/Vagas) | testado ao vivo |
| `ranking/` | pacote de ranking + `rank-service` HTTP + prompt + golden set | 20 testes, harness 5/5 |
| `n8n/` | 5 workflows (`ingest-bucket`, `embed-jobs`, `rank-daily`, `notify-daily`, `onboarding-hook`) | JSON gerado e validado |
| `panel/` | painel Next.js (onboarding LGPD, vagas, planos/billing Stripe, conta) | código pronto, não buildado aqui |

## Rodar

Teste ponta a ponta completo: **[TESTING.md](TESTING.md)**. Atalho de um comando:

```bash
cp .env.example .env                 # Supabase, DATABASE_URL, TEST_EMAIL, tokens, chaves LLM
bash scripts/e2e.sh                  # sobe a stack, migra, roda ingest→embed→onboarding, verifica
# Painel: cd panel && npm install && npm run dev
```

## Cadência diária

`ingest 06:00 → embed-jobs 06:30 → rank 07:00 → notify 08:00`. O `onboarding-hook` (webhook) faz embute→ranqueia→notifica na hora, para o candidato ter vagas no dia 0.

## Fora do escopo (por decisão)

Auto-apply (candidatura automática) — risco de ToS e de dano ao cliente. LinkedIn no produto comercial — ToS "personal use only".

## Próximos passos

Teste ponta a ponta real · golden set de ~50 pares + calibração do prompt · política de privacidade + DPAs · `cost_brl` real em `llm_usage` · migrar WhatsApp para a Cloud API oficial antes de escalar.

## Licença

MIT (ver `LICENSE` e `NOTICE`). Fontes Lato/Raleway sob SIL OFL.
