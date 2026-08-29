# Golden set do ranking

Pares perfil×vaga com uma nota humana, usados para validar o ranking antes de trocar modelo ou prompt. Meta: **~50 pares** cobrindo os buckets reais dos betas.

## Formato (JSONL, um par por linha)

```json
{
  "note": "descrição curta do caso",
  "profile": { "targetRoles": [], "seniority": "senior", "cities": [], "acceptsWorkModels": [], "languages": [{"lang":"","level":""}], "skills": [], "contractPreference": "pj|clt|any", "summary": "" },
  "job": { "id": "", "source": "", "title": "", "company": "", "location": "", "workModel": "remote|hybrid|onsite", "contractType": "pj|clt|unknown", "description": "" },
  "human": { "overall": 0-100, "band": "Strong Fit|Good Fit|Moderate Fit|Weak Fit|Poor Fit", "gate": "pass|fail" }
}
```

Níveis de idioma válidos: `reading, basic, conversational, intermediate, advanced, fluent, native`.

## Como montar os 50

1. Puxe vagas reais dos buckets via portal-runner e escolha ~50 variadas.
2. Para cada uma, escreva a nota humana como se estivesse decidindo aplicar: `gate` (a vaga deveria ser vetada por localização/idioma/senioridade?), `overall` 0-100 e a `band`.
3. Cubra os casos difíceis de propósito: remoto com inglês fluente exigido (flag), presencial em outra cidade (fail de localização), estágio para sênior (fail de senioridade), vaga adjacente de fit médio, vaga PJ vs CLT para candidato com preferência.
4. Balanceie: nem só Strong Fit, nem só lixo. O valor está nas bordas.

## Rodar

```bash
# só gates (sem custo, sem rede)
bun run src/eval.ts golden/golden-set.example.jsonl

# gates + scoring do LLM
OPENROUTER_API_KEY=... RANK_MODEL=anthropic/claude-haiku-4.5 bun run src/eval.ts golden/meu-golden.jsonl
```

## Critério de aceite (antes de promover um prompt/modelo)

- **Gates:** 100% de concordância nos `fail` esperados (um veto errado descarta vaga boa; um veto perdido gasta LLM à toa, menos grave).
- **Scoring:** banda igual ≥ 70% e MAE do overall ≤ ~12. Abaixo disso, ajuste o prompt (`prompts/rank-system.md`) e re-rode — não mexa nos pesos, que são o framework.

O arquivo de exemplo (`golden-set.example.jsonl`) traz 5 casos-semente; não é o golden de produção.
