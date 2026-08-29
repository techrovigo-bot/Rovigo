import { test, expect } from "bun:test"
import { computeScore, contractBonus, bandFor, WEIGHTS } from "../src/score.js"
import type { CandidateProfile, Job } from "../src/types.js"

const p = (pref: CandidateProfile["contractPreference"]): CandidateProfile => ({
  targetRoles: [], cities: [], acceptsWorkModels: [], languages: [], skills: [],
  contractPreference: pref,
})
const job = (o: Partial<Job>): Job => ({ id: "j", source: "gupy", title: "t", ...o })

test("pesos somam 1", () => {
  expect(WEIGHTS.technical + WEIGHTS.experience + WEIGHTS.behavioral + WEIGHTS.career).toBeCloseTo(1)
})

test("overall é a média ponderada arredondada", () => {
  const r = computeScore({ technical: 80, experience: 80, behavioral: 80, career: 80 }, job({}), p("any"))
  expect(r.overall).toBe(80)
  const r2 = computeScore({ technical: 90, experience: 60, behavioral: 50, career: 70 }, job({}), p("any"))
  // 90*.3 + 60*.25 + 50*.15 + 70*.3 = 27 + 15 + 7.5 + 21 = 70.5 → 71
  expect(r2.overall).toBe(71)
})

test("bônus de vínculo PJ aplica +10 em career quando bate a preferência", () => {
  expect(contractBonus(job({ contractType: "pj" }), p("pj"))).toBe(10)
  expect(contractBonus(job({ contractType: "clt" }), p("pj"))).toBe(0)
  expect(contractBonus(job({ contractType: "pj" }), p("any"))).toBe(0)
  expect(contractBonus(job({ contractType: "unknown" }), p("pj"))).toBe(0)
})

test("career satura em 100 com o bônus", () => {
  const r = computeScore({ technical: 50, experience: 50, behavioral: 50, career: 95 }, job({ contractType: "pj" }), p("pj"))
  expect(r.scores.career).toBe(100)
  expect(r.contractBonusApplied).toBe(10)
})

test("bandas do verdito", () => {
  expect(bandFor(80)).toBe("Strong Fit")
  expect(bandFor(75)).toBe("Strong Fit")
  expect(bandFor(74)).toBe("Good Fit")
  expect(bandFor(60)).toBe("Good Fit")
  expect(bandFor(45)).toBe("Moderate Fit")
  expect(bandFor(30)).toBe("Weak Fit")
  expect(bandFor(29)).toBe("Poor Fit")
})
