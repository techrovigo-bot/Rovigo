import { describe, expect, test } from "bun:test"
import { norm, knownYears, knownNumbers, hardCheck, stripUngrounded } from "../src/grounding.ts"
import type { DocProfile } from "../src/types.ts"

const profile: DocProfile = {
  fullName: "Wagner Carneiro Rovigo",
  headline: "Arquiteto de Automação e Agentes de IA",
  targetRoles: ["engenheiro de automação", "ai engineer"],
  seniority: "senior",
  cities: ["Curitiba"],
  skills: ["n8n", "python", "rag", "api rest"],
  languages: [{ lang: "português", level: "native" }],
  history: [
    {
      company: "Preâmbulo Tech",
      role: "Arquiteto de Automação e IA",
      start: "2026-05",
      end: null,
      location: "Brasil, remoto",
      bullets: [
        "Responde pela plataforma de automação: 115 workflows publicados, 68 ativos em produção",
        "Introduziu a medição de custo de IA por execução",
      ],
    },
    {
      company: "Preâmbulo Tech",
      role: "Gerente de Operações",
      start: "2023-05",
      end: "2026-04",
      location: "Brasil",
      bullets: ["Gerência de 46 pessoas em cinco áreas"],
    },
  ],
}

describe("norm", () => {
  test("ignora acento, caixa e pontuação", () => {
    expect(norm("Preâmbulo Tech.")).toBe(norm("preambulo tech"))
  })
})

describe("knownYears", () => {
  test("expande o intervalo de cada emprego", () => {
    const y = knownYears(profile)
    expect(y.has("2023")).toBe(true)
    expect(y.has("2024")).toBe(true) // meio do intervalo
    expect(y.has("2026")).toBe(true)
    expect(y.has("2019")).toBe(false)
  })

  test("emprego atual (end null) vai até o ano corrente", () => {
    const y = knownYears({
      ...profile,
      history: [{ company: "X", role: "Y", start: "2020-01", end: null, bullets: [] }],
    })
    expect(y.has(String(new Date().getUTCFullYear()))).toBe(true)
  })
})

describe("knownNumbers", () => {
  test("captura métricas dos bullets", () => {
    const n = knownNumbers(profile)
    expect(n.has("115")).toBe(true)
    expect(n.has("68")).toBe(true)
    expect(n.has("46")).toBe(true)
  })
})

describe("hardCheck — o que a auditoria PRECISA barrar", () => {
  test("empresa inventada é violação", () => {
    const r = hardCheck("Atuei como arquiteto na Globex Corporation Ltda. por dois anos.", profile)
    expect(r.violations.length).toBeGreaterThan(0)
    expect(r.unknownCompanies.join(" ")).toContain("Globex")
  })

  test("métrica inflada é violação (46 -> 60)", () => {
    const r = hardCheck("Liderei um time de 60 pessoas.", profile)
    expect(r.violations.some((v) => v.includes("60"))).toBe(true)
  })

  test("ano fora dos períodos declarados é violação", () => {
    const r = hardCheck("Entre 2015 e 2016 atuei com automação.", profile)
    expect(r.violations.some((v) => v.includes("2015"))).toBe(true)
  })

  test("percentual inventado é violação", () => {
    const r = hardCheck("Reduzi custos em 87% no primeiro trimestre.", profile)
    expect(r.violations.some((v) => v.includes("87"))).toBe(true)
  })
})

describe("hardCheck — titulação (vetor clássico de fabricação)", () => {
  test("PhD inventado é violação", () => {
    const r = hardCheck("PhD em Machine Learning pela Stanford University.", profile)
    expect(r.unknownCredentials).toContain("phd")
    expect(r.violations.length).toBeGreaterThan(0)
  })

  test("universidade inventada é violação", () => {
    const r = hardCheck("Formado pela Stanford University em 2024.", profile)
    expect(r.unknownCompanies.join(" ")).toContain("Stanford")
  })

  test("titulação declarada no perfil passa", () => {
    const comTitulo: DocProfile = {
      ...profile,
      history: [
        {
          ...profile.history[0],
          bullets: [...profile.history[0].bullets, "Tecnólogo em Gestão da Tecnologia da Informação"],
        },
        profile.history[1],
      ],
    }
    const r = hardCheck("Tecnólogo em Gestão da Tecnologia da Informação.", comTitulo)
    expect(r.unknownCredentials).toEqual([])
  })
})

describe("hardCheck — o que NÃO pode ser barrado (falso positivo)", () => {
  test("métrica real do perfil passa", () => {
    const r = hardCheck("Mantenho 115 workflows publicados, 68 ativos em produção.", profile)
    expect(r.violations).toEqual([])
  })

  test("empresa do perfil passa, mesmo com acento diferente", () => {
    const r = hardCheck("Na Preambulo Tech, construí a plataforma de automação.", profile)
    expect(r.unknownCompanies).toEqual([])
  })

  test("ano dentro do intervalo passa", () => {
    const r = hardCheck("Desde 2023 lidero a frente de automação.", profile)
    expect(r.violations).toEqual([])
  })

  test("número pequeno em prosa não vira métrica", () => {
    const r = hardCheck("Atuei em cinco áreas, com 5 squads.", profile)
    expect(r.violations).toEqual([])
  })

  test("texto puramente qualitativo passa limpo", () => {
    const r = hardCheck("Construo agentes de IA e automação de processos ponta a ponta.", profile)
    expect(r.violations).toEqual([])
  })
})

describe("stripUngrounded", () => {
  test("remove a linha inteira que contém o trecho não-ancorado", () => {
    const doc = ["- Entrega real ancorada", "- Liderei 60 pessoas na Globex", "- Outra entrega real"].join("\n")
    const { text, removed } = stripUngrounded(doc, ["60"])
    expect(text).not.toContain("Globex")
    expect(text).toContain("Entrega real ancorada")
    expect(text).toContain("Outra entrega real")
    expect(removed).toHaveLength(1)
  })

  test("sem ofensores, o documento passa intacto", () => {
    const doc = "- Uma linha\n- Outra linha"
    expect(stripUngrounded(doc, []).text).toBe(doc)
  })
})
