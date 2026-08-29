import {
  BASE,
  htmlFetch,
  parseJobCards,
  slugify,
  withinJobAge,
  writeError,
  type JobCard,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  jobage?: number
  page: number
  limit?: number
  format: "json" | "table" | "plain"
}

/**
 * The portal has no query-string search: the terms live in the URL path.
 *   keyword only        -> /vagas-de-<termo>
 *   keyword + city      -> /vagas-de-<termo>-em-<cidade>
 *   city only           -> /vagas-em-<cidade>
 * Pagination is the one real query parameter (`?pagina=`).
 */
export function buildUrl(opts: SearchOpts): string {
  const query = opts.query ? slugify(opts.query) : ""
  const city = opts.location ? slugify(opts.location) : ""

  let path: string
  if (query && city) path = `/vagas-de-${query}-em-${city}`
  else if (query) path = `/vagas-de-${query}`
  else path = `/vagas-em-${city}`

  const suffix = opts.page > 1 ? `?pagina=${opts.page}` : ""
  return `${BASE}${path}${suffix}`
}

function renderTable(cards: JobCard[]): string {
  if (cards.length === 0) return "Nenhum resultado."
  const rows = cards.map((c) => {
    const title = (c.title || "").slice(0, 42).padEnd(42)
    const company = (c.company || "—").slice(0, 24).padEnd(24)
    const loc = (c.location || "—").slice(0, 22).padEnd(22)
    const level = (c.level || "—").slice(0, 10).padEnd(10)
    return `${c.id.padEnd(9)} ${title} ${company} ${loc} ${level} ${c.date || "—"}`
  })
  const header =
    "ID".padEnd(9) + " " + "TITULO".padEnd(42) + " " + "EMPRESA".padEnd(24) + " " +
    "LOCAL".padEnd(22) + " " + "NIVEL".padEnd(10) + " DATA"
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const html = await htmlFetch(buildUrl(opts))
    let cards = parseJobCards(html).filter((c) => withinJobAge(c, opts.jobage))
    if (opts.limit !== undefined) cards = cards.slice(0, opts.limit)

    if (opts.format === "table") {
      process.stdout.write(renderTable(cards) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(
        cards
          .map(
            (c) =>
              `${c.title}\n  ${c.company || "—"} · ${c.location || "—"} · ${c.date || "—"}\n  id: ${c.id}\n  ${c.url}`,
          )
          .join("\n\n") + "\n",
      )
    } else {
      process.stdout.write(
        JSON.stringify({ meta: { count: cards.length, page: opts.page }, results: cards }, null, 2) + "\n",
      )
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
