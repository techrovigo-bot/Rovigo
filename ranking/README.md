# ranking

Decide o fit candidato×vaga em 3 estágios por custo crescente. Parametrizado pelo perfil do candidato (não hardcoded), derivado do framework 30/25/15/30.

```
vagas do bucket
      │
 (1) gates determinísticos ── FAIL → vetada, sem gastar LLM
      │  localização · idioma · senioridade        (zero token)
   sobreviventes
      │
 (2) pré-triagem pgvector (SQL/n8n) ── corta para top ~30/candidato/dia
      │
 (3) LLM em lote ── 4 dimensões (0-100) + strengths/gaps
      │
 score determinístico (código) ── pesos + bônus de vínculo → overall + banda
```

## Estágios

**1 — Gates (`src/gates.ts`).** Cortam o grosso do volume sem token. Regra: na dúvida, **FLAG** (humano decide), nunca FAIL silencioso.
- **Localização** — o maior eliminador. Remoto aceito → pass; cidade+modelo aceitos → pass; presencial/híbrido fora das cidades → **fail**; ambíguo → flag.
- **Idioma** — conservador. Só **fail** quando a vaga *exige* (não "desejável") um idioma que o perfil não declara; nível acima do declarado → flag.
- **Senioridade** — só **fail** no óbvio: estágio/trainee para perfil pleno+.

**2 — pgvector.** Fora deste pacote: roda no banco/n8n, só encurta a lista de sobreviventes.

**3 — LLM (`prompts/rank-system.md` + `src/pipeline.ts`).** O modelo devolve **só as 4 dimensões** (0-100) e strengths/gaps, em JSON estrito (`schema/rank-output.schema.json`). O modelo **não** calcula a nota geral.

**Score (`src/score.ts`).** O código aplica os pesos (Technical 30 / Experience 25 / Behavioral 15 / Career 30), o **bônus de vínculo** (+10 em Career quando o `contractType` da vaga bate com a `contractPreference` do candidato) e a banda de verdito. Aritmética fica no código de propósito — o framework avisa para não confiar na conta do LLM.

## Uso no n8n (nó Code + nó LLM)

```ts
import { partitionByGates, buildUserMessage, parseJudgements, assemble } from "./src/pipeline.js"

const { survivors, vetoed } = partitionByGates(jobs, profile)   // 1
// ... (2) pgvector encurta `survivors` ...
const userMsg = buildUserMessage(profile, survivors)            // → nó LLM (system = prompts/rank-system.md)
const judgements = parseJudgements(llmRawOutput)                // 3
const results = assemble(survivors, profile, judgements)        // + score
// grava vetoed ++ results em job_matches; soma tokens em llm_usage
```

## Validação (golden set)

```bash
bun test                              # gates + score (sem rede)
bun run src/eval.ts                   # gates contra o golden de exemplo
OPENROUTER_API_KEY=... bun run src/eval.ts golden/meu.jsonl   # + scoring do LLM
```

Estado atual: **20 testes unitários passam**; harness com **5/5 de concordância de veto** no golden de exemplo. O scoring do LLM precisa de uma chave para rodar; critério de aceite em `golden/README.md` (banda igual ≥70%, MAE ≤~12).

## Generalização vs. o framework original

O `04-job-evaluation.md` é escrito para um candidato. Aqui, tudo que era pessoal virou campo do perfil: `cities`/`acceptsWorkModels` (localização), `languages` (idioma), `seniority`, `contractPreference` (o bônus 4b, que no original era fixo "PJ +10"). **Falta um campo no schema Supabase**: `profiles.contract_preference` — adicionar numa próxima migração para o bônus de vínculo ligar por candidato.
