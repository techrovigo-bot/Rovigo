// Harness de avaliação do ranking contra um golden set (JSONL).
//
// Sempre roda os gates (estágio 1) e mede a concordância do veto com o rótulo
// humano — sem custo, sem rede. Se houver um caller de LLM (OPENROUTER_API_KEY),
// também pontua as vagas que passam no gate e compara o overall calculado com o
// overall humano (MAE, taxa dentro de ±TOL, taxa de banda igual).
//
// Uso:
//   bun run src/eval.ts [caminho.jsonl]           # só gates
//   OPENROUTER_API_KEY=... bun run src/eval.ts     # gates + LLM

import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { CandidateProfile, Job } from "./types.js"
import { runGates } from "./gates.js"
import { computeScore } from "./score.js"
import { buildUserMessage, parseJudgements } from "./pipeline.js"
import { makeOpenRouterCaller, type LlmCaller } from "./callers.js"

interface GoldenRow {
  note?: string
  profile: CandidateProfile
  job: Job
  human: { overall: number; band: string; gate: "pass" | "fail" }
}

const TOL = Number(process.env.RANK_EVAL_TOL ?? 12)

function loadRows(path: string): GoldenRow[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as GoldenRow)
}

async function main() {
  const path = process.argv[2] ?? join(import.meta.dir, "..", "golden", "golden-set.example.jsonl")
  const rows = loadRows(path)
  const system = readFileSync(join(import.meta.dir, "..", "prompts", "rank-system.md"), "utf-8")

  let caller: LlmCaller | null = null
  if (process.env.OPENROUTER_API_KEY) {
    try { caller = makeOpenRouterCaller() } catch { caller = null }
  }

  // --- Estágio 1: gates ---
  let gateCorrect = 0
  const gateMiss: string[] = []
  for (const r of rows) {
    const g = runGates(r.job, r.profile)
    const predicted = g.passed ? "pass" : "fail"
    if (predicted === r.human.gate) gateCorrect++
    else gateMiss.push(`  ${r.job.id}: gate previu '${predicted}', humano '${r.human.gate}' (${r.note ?? ""})`)
  }
  console.log(`\n=== Gates (estágio 1) ===`)
  console.log(`Concordância de veto: ${gateCorrect}/${rows.length}`)
  if (gateMiss.length) console.log("Divergências:\n" + gateMiss.join("\n"))

  if (!caller) {
    console.log(`\n(LLM pulado: defina OPENROUTER_API_KEY para avaliar o scoring. Gates validados acima.)\n`)
    return
  }

  // --- Estágio 3: LLM + score, só nas vagas que o humano espera 'pass' ---
  const scored = rows.filter((r) => r.human.gate === "pass")
  let absErr = 0, within = 0, bandMatch = 0, n = 0
  console.log(`\n=== Scoring (estágio 3, modelo ${process.env.RANK_MODEL ?? "default"}) ===`)
  for (const r of scored) {
    const g = runGates(r.job, r.profile)
    if (!g.passed) { console.log(`  ${r.job.id}: gate reprovou (esperado pass) — pulado no scoring`); continue }
    const user = buildUserMessage(r.profile, [r.job])
    let raw: string
    try { raw = await caller(system, user) } catch (e) { console.log(`  ${r.job.id}: erro LLM ${(e as Error).message}`); continue }
    const j = parseJudgements(raw).get(r.job.id)
    if (!j) { console.log(`  ${r.job.id}: LLM não devolveu o jobId`); continue }
    const s = computeScore(j, r.job, r.profile)
    const err = Math.abs(s.overall - r.human.overall)
    absErr += err; n++
    if (err <= TOL) within++
    if (s.verdict === r.human.band) bandMatch++
    console.log(`  ${r.job.id}: overall calc ${s.overall} (${s.verdict}) vs humano ${r.human.overall} (${r.human.band}) — Δ${err}`)
  }
  if (n > 0) {
    console.log(`\nMAE overall: ${(absErr / n).toFixed(1)}`)
    console.log(`Dentro de ±${TOL}: ${within}/${n} (${Math.round((100 * within) / n)}%)`)
    console.log(`Banda igual: ${bandMatch}/${n} (${Math.round((100 * bandMatch) / n)}%)\n`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
