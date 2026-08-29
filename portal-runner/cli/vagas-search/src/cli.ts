#!/usr/bin/env bun
// Self-contained CLI for searching jobs on vagas.com.br (Brazil). No external
// CLI framework and zero runtime dependencies, so it runs anywhere `bun` is
// available with nothing installed beyond the repo clone.
//
// vagas.com.br serves `User-agent: * / Allow: /` and answers an honest,
// self-identifying User-Agent with a normal 200, so this CLI never impersonates
// a browser. See url-reference.md for the robots.txt content-signal detail.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"

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

const HELP = `vagas-cli — busca vagas no vagas.com.br (Brasil)

USO
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <id|url> [--format json|plain]

FLAGS DE BUSCA
  --query, -q <texto>     Palavra-chave (cargo, skill). Ex: "analista de dados".
  --location, -l <cidade> Cidade. Acento e maiúscula não importam: vira slug de URL.
  --jobage <dias>         Publicadas nos últimos N dias (filtro local).
  --page <n>              Página, começando em 1 (40 vagas/página). Padrão 1.
  --limit, -n <n>         Limita quantos resultados sair (corte local).
  --format <fmt>          json (padrão) | table | plain.

Pelo menos --query ou --location precisa ser informado.

EXEMPLOS
  bun run src/cli.ts search -q "analista de dados" --format table
  bun run src/cli.ts search -q "analista de dados" -l "Curitiba" --format table
  bun run src/cli.ts search -l "São Paulo" --jobage 7 --format table
  bun run src/cli.ts search -q "automação industrial" --page 2 --format table
  bun run src/cli.ts detail 2819206 --format plain

Sem credencial e sem impersonação de navegador: o robots.txt do portal libera.
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "location", "jobage", "page", "limit", "format", "help", "h"]),
  detail: new Set(["format", "help", "h"]),
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

  if (cmd === "search") {
    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query : undefined,
      location: typeof flags.location === "string" ? flags.location : undefined,
      page: 1,
      format: "json",
    }

    if (!opts.query && !opts.location) {
      return fail(
        "informe pelo menos --query/-q ou --location/-l (a busca vive no caminho da URL do portal, não existe busca vazia)",
        "NO_FILTER",
      )
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
    const opts: DetailOpts = { id, format: fmt as DetailOpts["format"] }
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
