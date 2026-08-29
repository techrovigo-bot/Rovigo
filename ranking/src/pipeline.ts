// Cola do ranking, para o nó Code do n8n:
//   1. partitionByGates — roda os gates (estágio 1) e separa quem vai ao LLM.
//   2. buildUserMessage — monta a mensagem do LLM só com os sobreviventes.
//   3. parseJudgements — valida a saída JSON do LLM.
//   4. assemble — funde gate + julgamento + score determinístico em RankResult[].
//
// O estágio 2 (pré-triagem por pgvector) fica no SQL/n8n, entre 1 e 3, e apenas
// reduz a lista de sobreviventes; não altera nada aqui.

import type { CandidateProfile, Job, LlmJudgement, RankResult } from "./types.js"
import { runGates } from "./gates.js"
import { computeScore } from "./score.js"

const DESC_MAX = Number(process.env.RANK_DESC_MAX ?? 1200)

export interface Partition {
  survivors: Job[]        // passaram nos gates → vão ao LLM
  vetoed: RankResult[]    // reprovados no gate → não gastam LLM, já viram resultado
}

/** Estágio 1: roda os gates e separa sobreviventes de vetados. */
export function partitionByGates(jobs: Job[], p: CandidateProfile): Partition {
  const survivors: Job[] = []
  const vetoed: RankResult[] = []
  for (const job of jobs) {
    const gate = runGates(job, p)
    if (gate.passed) {
      survivors.push(job)
    } else {
      vetoed.push({
        jobId: job.id,
        gate,
        scored: false,
        contractBonusApplied: 0,
        strengths: [],
        gaps: gate.reason ? [gate.reason] : [],
        languageVerdict: gate.language,
        languageNote: gate.languageNote,
        locationVerdict: gate.location,
      })
    }
  }
  return { survivors, vetoed }
}

/** Monta a mensagem de usuário do LLM: um perfil + o lote de sobreviventes. */
export function buildUserMessage(p: CandidateProfile, jobs: Job[]): string {
  const profileBlock = [
    "## PERFIL DO CANDIDATO",
    `Funções-alvo: ${p.targetRoles.join(", ") || "—"}`,
    `Senioridade: ${p.seniority ?? "—"}`,
    `Skills: ${p.skills.join(", ") || "—"}`,
    `Idiomas: ${p.languages.map((l) => `${l.lang} (${l.level})`).join(", ") || "—"}`,
    p.summary ? `Resumo/experiência e preferências:\n${p.summary}` : "",
  ].filter(Boolean).join("\n")

  const jobsBlock = jobs
    .map((j, i) => {
      const desc = (j.description ?? "").slice(0, DESC_MAX)
      return [
        `### VAGA ${i + 1} (jobId: ${j.id})`,
        `Título: ${j.title}`,
        `Empresa: ${j.company ?? "—"}`,
        `Local: ${j.location ?? "—"}${j.workModel ? ` | modelo: ${j.workModel}` : ""}`,
        `Descrição: ${desc || "—"}`,
      ].join("\n")
    })
    .join("\n\n")

  return `${profileBlock}\n\n## VAGAS PARA AVALIAR (${jobs.length})\n\n${jobsBlock}\n\nDevolva o JSON no formato especificado, um objeto por vaga, com o jobId idêntico.`
}

const clampInt = (n: unknown): number => {
  const x = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(x)) return 50 // ausência de sinal → neutro, nunca NaN
  return Math.max(0, Math.min(100, Math.round(x)))
}

const strArray = (v: unknown, max = 3): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : []

/** Parseia a saída do LLM em um mapa jobId → julgamento, tolerando ruído.
 *  Aceita tanto {results:[...]} quanto um array direto. */
export function parseJudgements(raw: string | unknown): Map<string, LlmJudgement> {
  let obj: unknown = raw
  if (typeof raw === "string") {
    // Remove cercas de código eventuais e pega o primeiro bloco JSON.
    const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim()
    obj = JSON.parse(cleaned)
  }
  const arr: unknown[] = Array.isArray(obj)
    ? obj
    : Array.isArray((obj as { results?: unknown }).results)
      ? ((obj as { results: unknown[] }).results)
      : []

  const map = new Map<string, LlmJudgement>()
  for (const item of arr) {
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    const jobId = typeof o.jobId === "string" ? o.jobId : undefined
    if (!jobId) continue
    map.set(jobId, {
      technical: clampInt(o.technical),
      experience: clampInt(o.experience),
      behavioral: clampInt(o.behavioral),
      career: clampInt(o.career),
      strengths: strArray(o.strengths),
      gaps: strArray(o.gaps),
      languageObservation: typeof o.languageObservation === "string" ? o.languageObservation : undefined,
      rationale: typeof o.rationale === "string" ? o.rationale : undefined,
    })
  }
  return map
}

/** Estágio 3 → resultado: funde gate + julgamento do LLM + score determinístico. */
export function assemble(
  survivors: Job[],
  p: CandidateProfile,
  judgements: Map<string, LlmJudgement>,
): RankResult[] {
  const out: RankResult[] = []
  for (const job of survivors) {
    const gate = runGates(job, p) // barato; recomputa o veredito por vaga
    const j = judgements.get(job.id)
    if (!j) {
      // O LLM não devolveu esta vaga: registra sem score, para reprocessar.
      out.push({
        jobId: job.id, gate, scored: false, contractBonusApplied: 0,
        strengths: [], gaps: ["LLM não retornou avaliação para esta vaga"],
        languageVerdict: gate.language, languageNote: gate.languageNote, locationVerdict: gate.location,
      })
      continue
    }
    const s = computeScore(j, job, p)
    out.push({
      jobId: job.id,
      gate,
      scored: true,
      scores: s.scores,
      overall: s.overall,
      verdict: s.verdict,
      contractBonusApplied: s.contractBonusApplied,
      strengths: j.strengths,
      gaps: j.gaps,
      languageVerdict: gate.language,
      languageNote: gate.languageNote ?? j.languageObservation,
      locationVerdict: gate.location,
    })
  }
  return out
}
