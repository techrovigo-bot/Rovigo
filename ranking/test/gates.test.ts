import { test, expect } from "bun:test"
import { runGates, locationGate, languageGate, seniorityGate } from "../src/gates.js"
import type { CandidateProfile, Job } from "../src/types.js"

const base: CandidateProfile = {
  targetRoles: ["engenheiro de automação"],
  seniority: "senior",
  cities: ["Curitiba", "São José dos Pinhais"],
  acceptsWorkModels: ["remote", "hybrid"],
  languages: [
    { lang: "português", level: "native" },
    { lang: "inglês", level: "reading" },
  ],
  skills: ["n8n", "python"],
  contractPreference: "pj",
}

const job = (o: Partial<Job>): Job => ({ id: "j1", source: "gupy", title: "Vaga", ...o })

// ---- localização ----
test("remoto aceito → pass", () => {
  expect(locationGate(job({ workModel: "remote" }), base).verdict).toBe("pass")
  expect(locationGate(job({ location: "Home Office" }), base).verdict).toBe("pass")
})
test("cidade aceita + modelo aceito → pass", () => {
  // base aceita remote/hybrid; híbrido em Curitiba passa.
  expect(locationGate(job({ location: "Curitiba, PR", workModel: "hybrid" }), base).verdict).toBe("pass")
  // quem aceita onsite também passa em presencial na cidade.
  const pOnsite = { ...base, acceptsWorkModels: ["onsite" as const] }
  expect(locationGate(job({ location: "Curitiba, PR", workModel: "onsite" }), pOnsite).verdict).toBe("pass")
})
test("cidade aceita mas modelo não aceito → flag", () => {
  // base não marcou onsite; presencial na cidade vira flag (humano decide).
  expect(locationGate(job({ location: "Curitiba, PR", workModel: "onsite" }), base).verdict).toBe("flag")
})
test("presencial em outra cidade → fail", () => {
  expect(locationGate(job({ location: "São Paulo, SP", workModel: "onsite" }), base).verdict).toBe("fail")
})
test("localização ausente → flag", () => {
  expect(locationGate(job({ location: null }), base).verdict).toBe("flag")
})
test("remoto que o candidato não aceita → flag", () => {
  const p = { ...base, acceptsWorkModels: ["onsite" as const] }
  expect(locationGate(job({ workModel: "remote" }), p).verdict).toBe("flag")
})

// ---- idioma ----
test("inglês fluente exigido e candidato só tem leitura → flag", () => {
  const r = languageGate(job({ description: "Buscamos alguém com inglês fluente para o dia a dia." }), base)
  expect(r.verdict).toBe("flag")
})
test("inglês avançado exigido e candidato sem inglês → fail", () => {
  const p = { ...base, languages: [{ lang: "português", level: "native" as const }] }
  const r = languageGate(job({ description: "Advanced English is required." }), p)
  expect(r.verdict).toBe("fail")
})
test("inglês só como desejável → pass", () => {
  const r = languageGate(job({ description: "Inglês avançado é desejável, um diferencial." }), base)
  expect(r.verdict).toBe("pass")
})
test("sem exigência de idioma → pass", () => {
  expect(languageGate(job({ description: "Vaga de automação com n8n." }), base).verdict).toBe("pass")
})

// ---- senioridade ----
test("candidato sênior + estágio → fail", () => {
  expect(seniorityGate(job({ title: "Estágio em Automação" }), base).verdict).toBe("fail")
})
test("candidato sênior + vaga normal → pass", () => {
  expect(seniorityGate(job({ title: "Engenheiro de Automação Sênior" }), base).verdict).toBe("pass")
})
test("candidato júnior + estágio → pass (não veta)", () => {
  const p = { ...base, seniority: "junior" }
  expect(seniorityGate(job({ title: "Estágio em TI" }), p).verdict).toBe("pass")
})

// ---- composição ----
test("runGates reprova quando qualquer gate falha", () => {
  const r = runGates(job({ location: "Recife, PE", workModel: "onsite" }), base)
  expect(r.passed).toBe(false)
  expect(r.location).toBe("fail")
  expect(r.reason).toBeDefined()
})
test("runGates aprova vaga remota limpa", () => {
  const r = runGates(job({ workModel: "remote", description: "n8n e python" }), base)
  expect(r.passed).toBe(true)
})
