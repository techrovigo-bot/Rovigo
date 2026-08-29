import {
  API_BASE,
  PAGE_SIZE,
  jsonFetch,
  mapJobCard,
  withinJobAge,
  workplaceParam,
  writeError,
  type JobCard,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  state?: string
  remote?: string
  jobage?: number
  page: number
  limit?: number
  format: "json" | "table" | "plain"
}

export function buildUrl(opts: SearchOpts): string {
  const params = new URLSearchParams()
  // Only ever send parameters the API knows: it answers an unrecognised name
  // with 400 rather than ignoring it.
  if (opts.query) params.set("jobName", opts.query)
  if (opts.location) params.set("city", opts.location)
  if (opts.state) params.set("state", opts.state)
  const wt = workplaceParam(opts.remote)
  if (wt) params.set("workplaceType", wt)
  params.set("limit", String(PAGE_SIZE))
  params.set("offset", String((opts.page - 1) * PAGE_SIZE))
  return `${API_BASE}?${params.toString()}`
}

function renderTable(cards: JobCard[]): string {
  if (cards.length === 0) return "Nenhum resultado."
  const rows = cards.map((c) => {
    const title = (c.title || "").slice(0, 42).padEnd(42)
    const company = (c.company || "—").slice(0, 24).padEnd(24)
    const loc = (c.location || "—").slice(0, 24).padEnd(24)
    const date = (c.date || "—").slice(0, 10)
    return `${c.id.padEnd(10)} ${title} ${company} ${loc} ${date}`
  })
  const header =
    "ID".padEnd(10) + " " + "TITULO".padEnd(42) + " " + "EMPRESA".padEnd(24) + " " + "LOCAL".padEnd(24) + " DATA"
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const payload = (await jsonFetch(buildUrl(opts))) as
      | { data?: unknown; pagination?: { total?: number } }
      | null

    const raw = Array.isArray(payload?.data) ? (payload!.data as Record<string, unknown>[]) : []
    let cards = raw
      .map(mapJobCard)
      .filter((c): c is JobCard => c !== null)
      .filter((c) => withinJobAge(c, opts.jobage))

    if (opts.limit !== undefined) cards = cards.slice(0, opts.limit)

    if (opts.format === "table") {
      process.stdout.write(renderTable(cards) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(
        cards
          .map(
            (c) =>
              `${c.title}\n  ${c.company || "—"} · ${c.location || "—"} · ${(c.date || "—").slice(0, 10)}\n  id: ${c.id}\n  ${c.url}`,
          )
          .join("\n\n") + "\n",
      )
    } else {
      process.stdout.write(
        JSON.stringify(
          {
            meta: {
              count: cards.length,
              page: opts.page,
              total: payload?.pagination?.total ?? null,
            },
            results: cards,
          },
          null,
          2,
        ) + "\n",
      )
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
