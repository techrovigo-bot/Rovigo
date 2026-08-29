// Cálculo determinístico do score final. O LLM devolve as 4 dimensões (0-100);
// aqui aplicamos os pesos, o modificador de vínculo (4b) e a banda de verdito.
// Manter isto em código evita erro de aritmética do modelo (o framework avisa).

import type { Band, CandidateProfile, DimensionScores, Job } from "./types.js"

// Pesos do framework: Technical 30% / Experience 25% / Behavioral 15% / Career 30%.
export const WEIGHTS = { technical: 0.30, experience: 0.25, behavioral: 0.15, career: 0.30 } as const

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n))

/** Modificador de vínculo (seção 4b): +10 em Career Alignment quando o vínculo
 *  da vaga bate com a PREFERÊNCIA do candidato. Generalizado: quem prefere PJ
 *  ganha bônus em vaga PJ; quem prefere CLT, em vaga CLT. 'any' não aplica bônus.
 *  Nunca penaliza. Career satura em 100. */
export function contractBonus(job: Job, p: CandidateProfile): number {
  if (p.contractPreference === "any") return 0
  const ct = job.contractType ?? "unknown"
  if (ct === "unknown") return 0
  return ct === p.contractPreference ? 10 : 0
}

export function bandFor(overall: number): Band {
  if (overall >= 75) return "Strong Fit"
  if (overall >= 60) return "Good Fit"
  if (overall >= 45) return "Moderate Fit"
  if (overall >= 30) return "Weak Fit"
  return "Poor Fit"
}

export interface ScoreOutput {
  scores: DimensionScores
  overall: number
  verdict: Band
  contractBonusApplied: number
}

/** Aplica pesos + bônus de vínculo e devolve o overall (0-100) e a banda. */
export function computeScore(dims: DimensionScores, job: Job, p: CandidateProfile): ScoreOutput {
  const bonus = contractBonus(job, p)
  const career = clamp(dims.career + bonus)
  const scores: DimensionScores = {
    technical: clamp(dims.technical),
    experience: clamp(dims.experience),
    behavioral: clamp(dims.behavioral),
    career,
  }
  const overall = Math.round(
    scores.technical * WEIGHTS.technical +
    scores.experience * WEIGHTS.experience +
    scores.behavioral * WEIGHTS.behavioral +
    scores.career * WEIGHTS.career,
  )
  return { scores, overall, verdict: bandFor(overall), contractBonusApplied: bonus }
}
