// Tipos do ranking. O framework original (04-job-evaluation.md) é hardcoded para
// um candidato; aqui tudo é parametrizado pelo perfil, para servir N tenants.

export type WorkModel = "remote" | "hybrid" | "onsite"
export type Verdict = "pass" | "fail" | "flag"
export type ContractPreference = "clt" | "pj" | "any"

/** Nível de idioma numa escala ordenável. As strings livres do mundo real
 *  ("fluente", "avançado", "C1", "professional working") são mapeadas para cá. */
export type LangLevel = "reading" | "basic" | "conversational" | "intermediate" | "advanced" | "fluent" | "native"

export interface CandidateLanguage {
  lang: string          // "português", "inglês", "espanhol" (normalizado)
  level: LangLevel
}

export interface CandidateProfile {
  targetRoles: string[]
  seniority?: string                 // "junior" | "pleno" | "senior" | "especialista" | ...
  cities: string[]                   // cidades aceitas (base do gate de localização)
  acceptsWorkModels: WorkModel[]
  languages: CandidateLanguage[]
  skills: string[]
  contractPreference: ContractPreference
  // Texto livre de experiência/comportamento para o estágio LLM.
  summary?: string
}

export interface Job {
  id: string
  source: string
  title: string
  company?: string | null
  location?: string | null
  workModel?: WorkModel | null
  description?: string | null
  contractType?: "clt" | "pj" | "unknown" | null
  deadline?: string | null           // YYYY-MM-DD
}

export interface GateResult {
  passed: boolean                    // false se QUALQUER gate deu 'fail'
  location: Verdict
  language: Verdict
  languageNote?: string
  seniority: Verdict
  reason?: string                    // motivo do veto, quando passed=false
}

/** As 4 dimensões pontuadas pelo LLM (0-100 cada). O OVERALL não vem do LLM:
 *  é calculado em código com os pesos, para não depender de aritmética do modelo. */
export interface DimensionScores {
  technical: number
  experience: number
  behavioral: number
  career: number
}

export interface LlmJudgement extends DimensionScores {
  strengths: string[]                // 1-3 bullets, do texto da vaga
  gaps: string[]                     // 1-3 bullets, honestos
  languageObservation?: string       // só se o LLM notar algo que o gate não pegou
  rationale?: string
}

export type Band = "Strong Fit" | "Good Fit" | "Moderate Fit" | "Weak Fit" | "Poor Fit"

export interface RankResult {
  jobId: string
  gate: GateResult
  scored: boolean                    // false quando vetado pelo gate (não foi ao LLM)
  scores?: DimensionScores
  overall?: number                   // 0-100, calculado
  verdict?: Band
  contractBonusApplied: number       // 0 ou +10 (modificador 4b)
  strengths: string[]
  gaps: string[]
  languageVerdict: Verdict
  languageNote?: string
  locationVerdict: Verdict
}
