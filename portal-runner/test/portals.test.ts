import { test, expect } from "bun:test"
import { buildSearchArgs, buildDetailArgs, isPortal } from "../src/portals.js"

test("isPortal aceita só os 3 portais brasileiros", () => {
  expect(isPortal("gupy")).toBe(true)
  expect(isPortal("catho")).toBe(true)
  expect(isPortal("vagas")).toBe(true)
  expect(isPortal("linkedin")).toBe(false)
  expect(isPortal("freehire")).toBe(false)
  expect(isPortal(42)).toBe(false)
})

test("buildSearchArgs monta flags e força --format json", () => {
  const r = buildSearchArgs("gupy", { portal: "gupy", query: "automação", jobage: 14, page: 2 })
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.args).toEqual(["--query", "automação", "--jobage", "14", "--page", "2", "--format", "json"])
  }
})

test("buildSearchArgs rejeita campo não suportado pelo portal", () => {
  // vagas.com não tem --state nem --remote
  const r = buildSearchArgs("vagas", { portal: "vagas", query: "dev", state: "SP" })
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.status).toBe(400)
    expect(r.code).toBe("UNSUPPORTED_FIELD")
  }
})

test("buildSearchArgs valida inteiros positivos", () => {
  const r = buildSearchArgs("gupy", { portal: "gupy", query: "x", limit: 0 })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.code).toBe("BAD_ARG")
})

test("buildSearchArgs valida modo remoto", () => {
  const r = buildSearchArgs("gupy", { portal: "gupy", query: "x", remote: "qualquer" })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.code).toBe("BAD_ARG")
})

test("catho aceita browserHeaders como flag booleana", () => {
  const r = buildSearchArgs("catho", { portal: "catho", query: "dados", location: "Curitiba PR", browserHeaders: true })
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.args).toContain("--browser-headers")
    expect(r.args).toEqual(["--query", "dados", "--location", "Curitiba PR", "--browser-headers", "--format", "json"])
  }
})

test("buildDetailArgs exige id e força json", () => {
  const bad = buildDetailArgs("gupy", { portal: "gupy" })
  expect(bad.ok).toBe(false)
  if (!bad.ok) expect(bad.code).toBe("NO_ID")

  const ok = buildDetailArgs("gupy", { portal: "gupy", id: "12223403" })
  expect(ok.ok).toBe(true)
  if (ok.ok) expect(ok.args).toEqual(["12223403", "--format", "json"])
})
