# portal-runner

Serviço HTTP fino que o n8n chama para buscar vagas nos portais brasileiros. Envolve os CLIs bun (`cli/`) preservando o **contrato JSON** deles: uma atualização do CLI não exige mexer no runner.

Portais expostos: **gupy** (API pública, baixo risco), **catho** e **vagas** (scraping HTML, conservador). LinkedIn e freehire ficam de fora de propósito.

## Endpoints

| Método | Rota | Auth | Corpo |
|---|---|---|---|
| GET | `/health` | aberto | — |
| POST | `/search` | Bearer | `{portal, query?, location?, state?, remote?, jobage?, page?, limit?, browserHeaders?}` |
| POST | `/detail` | Bearer | `{portal, id, browserHeaders?}` |

Campos aceitos por portal (um campo não suportado é **400**, não ignorado):

| Portal | search | detail |
|---|---|---|
| gupy | query, location, state, remote, jobage, page, limit | — |
| catho | query, location, jobage, page, limit, browserHeaders | browserHeaders |
| vagas | query, location, jobage, page, limit | — |

`--format json` é sempre forçado. `location` na Catho precisa incluir a UF (ex.: `"Curitiba PR"`).

### Respostas

- **200** — o JSON verbatim do CLI: `{"meta":{count,page,total}, "results":[{id,title,company,location,date,url,...}]}`.
- **400** `BAD_PORTAL` / `UNSUPPORTED_FIELD` / `BAD_ARG` / `NO_ID` — requisição inválida.
- **401** `UNAUTHORIZED` — token ausente/errado. **503** `AUTH_NOT_CONFIGURED` — servidor sem token (fail closed).
- **429** `RATE_LIMITED` — fila do portal cheia.
- **502** `CLI_ERROR` / `BAD_OUTPUT` — o CLI falhou (repassa `{error,code}` do CLI). **504** `TIMEOUT`.
- **503** `PORTAL_DISABLED` — portal no kill-switch.

## Rodar local

```bash
cp .env.example .env   # defina PORTAL_RUNNER_TOKEN
bun run src/server.ts
```

```bash
curl -s localhost:8080/health
curl -s -X POST localhost:8080/search \
  -H "authorization: Bearer $PORTAL_RUNNER_TOKEN" -H "content-type: application/json" \
  -d '{"portal":"gupy","query":"automação","limit":5}'
```

## Docker

```bash
docker build -t portal-runner .
docker run -p 8080:8080 -e PORTAL_RUNNER_TOKEN=segredo portal-runner
```

## Rate limit e escala

Execução **serial por portal** (concorrência 1) com intervalo mínimo (gupy 1,5s; catho/vagas 4s), em memória. Vale para **uma instância** — que é o desenho do MVP, porque o volume contra o portal é desacoplado do número de clientes pelos *search buckets*, não pela escala horizontal do runner. Rodar N instâncias exigiria mover o lock para Redis.

## Variáveis de ambiente

Ver `.env.example`. Destaques: `PORTAL_RUNNER_TOKEN` (obrigatório para os POST), `PORTAL_RUNNER_DISABLED` (kill-switch por portal, ex.: `catho,vagas`), `PORTAL_RUNNER_TIMEOUT_MS`.

## Testes

```bash
bun test          # unitários do runner + testes originais dos CLIs
```

Validação ponta a ponta feita: `/health`, auth 401, kill-switch 503, rejeição de campo 400, e `search`/`detail` reais na Gupy retornando o contrato correto.

## Atribuição

Os CLIs em `cli/` e `tools/robots_check.py` derivam do projeto MIT de Mads Lorentzen — ver `../NOTICE`. `tools/robots_check.py` é utilitário de auditoria manual (RFC 9309), não está no caminho de request; os CLIs tratam robots/WAF por conta própria (Catho expõe `browserHeaders` como escalonamento explícito).
