import {
  BASE,
  htmlFetch,
  parseJobCards,
  slugify,
  withinJobAge,
  writeError,
  WafBlockedError,
  type JobCard,
} from "../helpers.js"

export interface SearchOpts {
  query: string
  location?: string
  jobage?: number
  page: number
  limit?: number
  format: "json" | "table" | "plain"
  browserHeaders: boolean
}

// The search terms live in the URL path. Note what is deliberately absent: no
// "?q=" parameter, ever. robots.txt disallows every URL carrying that parameter
// as well as the internal /buscar/vagas/ endpoint, so this builder is written to
// be incapable of producing a disallowed URL.
//
//   keyword          -> /vagas/<termo>/
//   keyword + city   -> /vagas/<termo>/<cidade>-<uf>/
//   page N           -> ?page=<n>   (allowed; only ?q= is not)
export function buildUrl(opts: SearchOpts): string {
  const query = slugify(opts.query)
  const city = opts.location ? slugify(opts.location) : ""
  const path = city ? `/vagas/${query}/${city}/` : `/vagas/${query}/`
  const suffix = opts.page > 1 ? `?page=${opts.page}` : ""
  return `${BASE}${path}${suffix}`
}

function renderTable(cards: JobCard[]): string {
  if (cards.length === 0) return "Nenhum resultado."
  const rows = cards.map((c) => {
    const title = (c.title || "").slice(0, 44).padEnd(44)
    const company = (c.company || "—").slice(0, 22).padEnd(22)
    const loc = (c.location || "—").slice(0, 20).padEnd(20)
    const salary = (c.salary || "—").slice(0, 14).padEnd(14)
    return `${c.id.padEnd(9)} ${title} ${company} ${loc} ${salary} ${c.date || "—"}`
  })
  const header =
    "ID".padEnd(9) + " " + "TITULO".padEnd(44) + " " + "EMPRESA".padEnd(22) + " " +
    "LOCAL".padEnd(20) + " " + "SALARIO".padEnd(14) + " DATA"
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const html = await htmlFetch(buildUrl(opts), opts.browserHeaders)
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
    if (e instanceof WafBlockedError) {
      writeError(e.message, "WAF_BLOCKED")
      return 1
    }
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
