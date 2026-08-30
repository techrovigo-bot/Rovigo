import { describe, expect, test } from "bun:test"
import { parseJson, normMonth, assembleExtract, assembleDraft, audit } from "../src/pipeline.ts"
import { mdToHtml } from "../src/render.ts"
import type { DocProfile } from "../src/types.ts"

const profile: DocProfile = {
  fullName: "Wagner Carneiro Rovigo",
  targetRoles: ["ai engineer"],
  cities: ["Curitiba"],
  skills: ["n8n", "python"],
  languages: [],
  history: [
    {
      company: "Preâmbulo Tech",
      role: "Arquiteto de Automação e IA",
      start: "2026-05",
      end: null,
      bullets: ["115 workflows publicados, 68 ativos em produção"],
    },
  ],
}

describe("parseJson", () => {
  test("aceita JSON puro", () => {
    expect(parseJson('{"a":1}').a).toBe(1)
  })
  test("aceita JSON em cerca de código", () => {
    expect(parseJson('```json\n{"a":2}\n```').a).toBe(2)
  })
  test("recorta prosa em volta", () => {
    expect(parseJson('Segue o resultado:\n{"a":3}\nEspero ter ajudado.').a).toBe(3)
  })
  test("lixo devolve objeto vazio, não estoura", () => {
    expect(parseJson("não é json")).toEqual({})
  })
})

describe("normMonth", () => {
  test.each([
    ["2024-3", "2024-03"],
    ["2024-03", "2024-03"],
    ["03/2024", "2024-03"],
    ["2024", "2024-01"],
    ["ontem", ""],
  ])("%s -> %s", (input, expected) => {
    expect(normMonth(input)).toBe(expected)
  })
})

describe("assembleExtract", () => {
  test("normaliza datas e mantém bullets", () => {
    const r = assembleExtract(
      JSON.stringify({
        history: [{ company: "Acme", role: "Dev", start: "2020", end: "12/2022", bullets: ["fez x"] }],
        skills: ["go"],
      }),
    )
    expect(r.history[0].start).toBe("2020-01")
    expect(r.history[0].end).toBe("2022-12")
    expect(r.history[0].bullets).toEqual(["fez x"])
    expect(r.skills).toEqual(["go"])
  })

  test("emprego atual fica com end null", () => {
    const r = assembleExtract(JSON.stringify({ history: [{ company: "A", role: "B", start: "2021-01", end: null }] }))
    expect(r.history[0].end).toBeNull()
  })

  test("descarta entrada sem empresa e avisa", () => {
    const r = assembleExtract(JSON.stringify({ history: [{ role: "Dev", start: "2020-01" }] }))
    expect(r.history).toHaveLength(0)
    expect(r.warnings.length).toBeGreaterThan(0)
  })
})

describe("audit — a regra dura", () => {
  const draft = {
    cv: ["## Experiência", "- 115 workflows publicados", "- Liderei 60 pessoas"].join("\n"),
    coverLetter: "Reduzi custos em 87% no trimestre.",
  }

  test("remove do CV o claim marcado como ungrounded", () => {
    const review = JSON.stringify({
      claims: [{ kind: "cv", text: "Liderei 60 pessoas", verdict: "ungrounded", reason: "não está no perfil" }],
    })
    const { clean, report } = audit(profile, draft, review)
    expect(clean.cv).not.toContain("60 pessoas")
    expect(clean.cv).toContain("115 workflows")
    expect(report.removed.length).toBeGreaterThan(0)
  })

  test("a camada determinística pega o que o reviewer deixou passar", () => {
    // reviewer diz que está tudo certo — a rede de baixo tem que segurar
    const { clean, report } = audit(profile, draft, JSON.stringify({ claims: [] }))
    expect(report.hardViolations.length).toBeGreaterThan(0)
    expect(clean.cv).not.toContain("60 pessoas")
    expect(clean.coverLetter).not.toContain("87%")
  })

  test("stretch fica no documento mas é reportado", () => {
    const review = JSON.stringify({
      claims: [{ kind: "cv", text: "115 workflows publicados", verdict: "stretch", reason: "esticado" }],
    })
    const { clean, report } = audit(profile, draft, review)
    expect(clean.cv).toContain("115 workflows")
    expect(report.stretches).toHaveLength(1)
  })

  test("NÃO apaga o reconhecimento honesto de lacuna na carta", () => {
    // Regressão: a checagem de titulação chegou a remover a frase em que o
    // candidato diz que NÃO tem o diploma exigido — matando exatamente a
    // honestidade que a feature existe para preservar.
    const comLacuna = {
      cv: "## Experiência\n- 115 workflows publicados",
      coverLetter: "Reconheço que a vaga exige PhD ou mestrado em ML. Não tenho esse perfil; minha formação é prática.",
    }
    const { clean, report } = audit(profile, comLacuna, JSON.stringify({ claims: [] }))
    expect(clean.coverLetter).toContain("Não tenho esse perfil")
    expect(report.removed).toHaveLength(0)
  })

  test("mas titulação inventada no CV continua sendo removida", () => {
    const mentira = { cv: "## Formação\n- PhD em Machine Learning", coverLetter: "" }
    const { clean } = audit(profile, mentira, JSON.stringify({ claims: [] }))
    expect(clean.cv).not.toContain("PhD")
  })

  test("veredicto desconhecido do LLM cai para ungrounded (fail closed)", () => {
    const review = JSON.stringify({ claims: [{ kind: "cv", text: "115 workflows publicados", verdict: "talvez" }] })
    const { report } = audit(profile, draft, review)
    expect(report.claims[0].verdict).toBe("ungrounded")
  })
})

describe("mdToHtml", () => {
  test("converte títulos, listas e negrito", () => {
    const html = mdToHtml("# Nome\n\n## Experiência\n\n- **Cargo** — Empresa\n- outro")
    expect(html).toContain("<h1>Nome</h1>")
    expect(html).toContain("<h2>Experiência</h2>")
    expect(html).toContain("<strong>Cargo</strong>")
    expect(html).toContain("<li>")
  })

  test("escapa HTML vindo do LLM", () => {
    expect(mdToHtml("<script>alert(1)</script>")).not.toContain("<script>")
  })
})
