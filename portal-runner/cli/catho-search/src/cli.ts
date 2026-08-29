#!/usr/bin/env bun
// Self-contained CLI for searching jobs on catho.com.br (Brazil). No external
// CLI framework and zero runtime dependencies, so it runs anywhere `bun` is
// available with nothing installed beyond the repo clone.
//
// Default behaviour is an honest, self-identifying User-Agent, as the portal
// skill contract requires. Catho's firewall answers that with 403 on a path its
// own robots.txt allows, so browser headers are available as an explicit,
// opt-in escalation (--browser-headers / CATHO_BROWSER_HEADERS=1) rather than a
// silent default. The reasoning is written out at the top of helpers.ts.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { browserHeadersEnabled } from "./helpers.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

/** Accepts both `--flag value` and `--flag=value`. The `=` form is the only way
 *  to pass a negative number, since a bare `-1` reads as the next flag. */
function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  const alias: Record<string, string> = { q: "query", l: "location", n: "limit" }
  const resolve = (k: string): string => alias[k] ?? k

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("-") && a !== "-") {
      const body = a.replace(/^-+/, "")
      const eq = body.indexOf("=")
      if (eq !== -1) {
        flags[resolve(body.slice(0, eq))] = body.slice(eq + 1)
        continue
      }
      const key = resolve(body)
      const next = argv[i + 1]
      if (next === undefined || (next.startsWith("-") && next !== "-")) {
        flags[key] = true
      } else {
        flags[key] = next
        i++
      }
    } else {
      ;(flags._ as string[]).push(a)
    }
  }
  return flags
}

const HELP = `catho-cli — busca vagas na Catho (Brasil)

USO
  bun run src/cli.ts search --query "<termo>" [flags]
  bun run src/cli.ts detail <id|url> [--format json|plain] [--browser-headers]

FLAGS DE BUSCA
  --query, -q <texto>     Palavra-chave (cargo, skill). OBRIGATÓRIA.
  --location, -l <cidade> Cidade com UF: "sao-paulo-sp", "Curitiba PR". Vira slug.
  --jobage <dias>         Publicadas nos últimos N dias (filtro local).
  --page <n>              Página, começando em 1 (20 vagas/página). Padrão 1.
  --limit, -n <n>         Limita quantos resultados sair (corte local).
  --format <fmt>          json (padrão) | table | plain.
  --browser-headers       Manda headers de navegador. Ver ACESSO abaixo.

ACESSO
  O robots.txt da Catho libera os caminhos que este CLI usa (/vagas/<termo>/) e
  proíbe os que ele nunca toca (/buscar/vagas/ e qualquer ?q=). Mesmo assim o
  firewall dela responde 403 pro User-Agent honesto do CLI e 200 pro navegador.
  Por padrão o CLI se identifica honestamente e falha com WAF_BLOCKED. Com
  --browser-headers (ou CATHO_BROWSER_HEADERS=1) ele escala pra headers de
  navegador, que é escolha tua e consciente, não padrão silencioso.

EXEMPLOS
  bun run src/cli.ts search -q "analista de dados" --browser-headers --format table
  bun run src/cli.ts search -q "analista de dados" -l "Curitiba PR" --browser-headers --format table
  CATHO_BROWSER_HEADERS=1 bun run src/cli.ts search -q "engenheiro de dados" --jobage 7 --format table
  bun run src/cli.ts detail 38066988 --browser-headers --format plain
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set([
    "query", "location", "jobage", "page", "limit", "format", "browser-headers", "help", "h",
  ]),
  detail: new Set(["format", "browser-headers", "help", "h"]),
}

function fail(error: string, code: string): number {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
  return 1
}

/** Parse a flag that must be a positive integer. Returns null after writing the
 *  error, so a bad value never reaches the portal as a silently-dropped filter. */
function positiveInt(name: string, raw: string | boolean | string[]): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    fail(`--${name} precisa ser um inteiro positivo, recebi "${String(raw)}"`, "BAD_ARG")
    return null
  }
  const val = parseInt(raw, 10)
  if (val < 1) {
    fail(`--${name} precisa ser >= 1, recebi "${raw}"`, "BAD_ARG")
    return null
  }
  return val
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const flags = parseFlags(argv)
  const cmd = (flags._ as string[])[0]

  if (!cmd || flags.help || flags.h) {
    process.stdout.write(HELP)
    return cmd ? 0 : 1
  }

  const knownFlags = KNOWN_FLAGS[cmd]
  if (!knownFlags) return fail(`Comando desconhecido "${cmd}"`, "BAD_CMD")

  // Unknown flags are rejected rather than dropped: a discarded filter changes
  // what the search returns with no visible error.
  for (const key of Object.keys(flags)) {
    if (key === "_" || knownFlags.has(key)) continue
    return fail(
      `flag desconhecida --${key} em '${cmd}' — flags nunca são ignoradas em silêncio, porque um filtro descartado muda o resultado da busca; veja --help`,
      "UNKNOWN_FLAG",
    )
  }

  const browserHeaders = browserHeadersEnabled(flags["browser-headers"] === true)

  if (cmd === "search") {
    const query = typeof flags.query === "string" ? flags.query : undefined
    if (!query) {
      return fail(
        'a flag --query/-q é obrigatória (a busca da Catho vive no caminho da URL: /vagas/<termo>/)',
        "NO_QUERY",
      )
    }

    const opts: SearchOpts = {
      query,
      location: typeof flags.location === "string" ? flags.location : undefined,
      page: 1,
      format: "json",
      browserHeaders,
    }

    for (const name of ["jobage", "page", "limit"] as const) {
      if (flags[name] === undefined) continue
      const val = positiveInt(name, flags[name])
      if (val === null) return 1
      if (name === "jobage") opts.jobage = val
      if (name === "page") opts.page = val
      if (name === "limit") opts.limit = val
    }

    const fmt = typeof flags.format === "string" ? flags.format : "json"
    if (!["json", "table", "plain"].includes(fmt)) {
      return fail(`--format aceita json, table ou plain; recebi "${fmt}"`, "BAD_ARG")
    }
    opts.format = fmt as SearchOpts["format"]

    return runSearch(opts)
  }

  if (cmd === "detail") {
    const id = (flags._ as string[])[1]
    if (!id) return fail("detail exige um <id|url>", "NO_ID")
    const fmt = typeof flags.format === "string" ? flags.format : "json"
    if (!["json", "plain"].includes(fmt)) {
      return fail(`--format aceita json ou plain; recebi "${fmt}"`, "BAD_ARG")
    }
    const opts: DetailOpts = { id, format: fmt as DetailOpts["format"], browserHeaders }
    return runDetail(opts)
  }

  return fail(`Comando desconhecido "${cmd}"`, "BAD_CMD")
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e), code: "INTERNAL_ERROR" }) + "\n",
    )
    process.exit(1)
  })
