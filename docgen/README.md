# docgen

Geração de CV e carta de apresentação por vaga, com **auditoria de grounding**.

Porta do framework original (`ai-job-search`, comando `/apply`): drafter → reviewer,
com a regra dura de que nada entra no documento sem âncora no perfil do candidato.

## Endpoints

Auth: `Authorization: Bearer <DOCGEN_SERVICE_TOKEN>`. Sem token, POST devolve 503.
Como no `rank-service`, este serviço **não chama LLM** — prepara prompts e valida
saídas; quem chama o modelo é o n8n.

| Rota | Entrada | Saída |
|---|---|---|
| `GET /health` | — | `{status, authConfigured}` |
| `POST /prepare-extract` | `{rawText}` | `{system, user}` |
| `POST /assemble-extract` | `{llm}` | `{history, skills, warnings}` |
| `POST /prepare-draft` | `{profile, job}` | `{system, user}` |
| `POST /assemble-draft` | `{llm}` | `{cv, coverLetter}` |
| `POST /prepare-review` | `{profile, job, draft}` | `{system, user}` |
| `POST /audit` | `{profile, draft, llmReview}` | `{report, clean}` |
| `POST /render` | `{profile, draft}` | `{cvHtml, coverHtml}` |

## A auditoria de grounding

Duas camadas, e a de baixo não depende do LLM cooperar:

1. **Determinística** (`src/grounding.ts`): empresa com marcador societário/acadêmico,
   número/métrica, ano e titulação que não existam no perfil viram violação.
2. **Reviewer LLM** (`prompts/review-system.md`): julgamento semântico, classificando
   cada claim em `grounded` / `stretch` / `ungrounded`.

**Regra dura:** claim `ungrounded` é **removido** do documento (linha inteira), não
apenas sinalizado. `stretch` permanece, mas vai no relatório para o candidato decidir.

Uma exceção deliberada: a checagem de titulação **não roda na carta**. Lá, citar um
diploma quase sempre é reconhecer que não se tem ("a vaga pede PhD; não tenho"), e
apagar essa frase destruiria a honestidade sobre lacunas que o framework preserva.
Na carta esse julgamento é do reviewer, que entende o contexto. Há teste de regressão
para isso (`test/pipeline.test.ts`).

## Rodar

```bash
bun test                       # 38 testes, sem rede
DOCGEN_SERVICE_TOKEN=x bun run src/server.ts
```

## Variáveis

`DOCGEN_SERVICE_TOKEN` (obrigatória), `PORT` (8100), `DOCGEN_DESC_MAX` (6000),
`DOCGEN_CV_MAX` (24000).
