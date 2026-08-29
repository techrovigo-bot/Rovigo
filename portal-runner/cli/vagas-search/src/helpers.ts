// Data source: vagas.com.br public search pages and posting pages (Brazil).
// No authentication and no API key. Search results are server-rendered HTML;
// the posting page additionally carries a schema.org JobPosting JSON-LD block,
// which is what `detail` reads (far more stable than the surrounding markup).
//
// robots.txt serves `User-agent: * / Allow: /`, and the repo's
// tools/robots_check.py reports ALLOWED for the paths used here, so the honest
// User-Agent below is served normally — no browser impersonation anywhere.
// See url-reference.md for the content-signal caveat.

export const BASE = "https://www.vagas.com.br"

/** The portal renders a fixed 40 postings per search page. */
export const PAGE_SIZE = 40

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const UA = "Mozilla/5.0 (compatible; vagas-search-cli/1.0)"

/** Fetch HTML with exponential backoff on 429/5xx. Returns "" on a 404. */
export async function htmlFetch(url: string): Promise<string> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9",
      },
      // Posting URLs redirect from /vagas/v<id> to /vagas/v<id>/<slug>.
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`)
      }
      const jitter = Math.floor(Math.random() * 500)
      await new Promise((r) => setTimeout(r, delay + jitter))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return ""
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }
    return response.text()
  }
  throw new Error("Request failed after max retries")
}

export interface JobCard {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  url: string
  level: string | null
  snippet: string | null
}

export interface JobDetail extends JobCard {
  description: string | null
  validThrough: string | null
  benefits: string | null
}

function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

/** Named entities that turn up in Brazilian job ads — employers paste copy out
 *  of Word and similar editors, which emit accented Latin-1 names rather than
 *  numeric references. */
const NAMED_ENTITIES: Record<string, string> = {
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  atilde: "ã", otilde: "õ", Atilde: "Ã", Otilde: "Õ",
  acirc: "â", ecirc: "ê", ocirc: "ô", Acirc: "Â", Ecirc: "Ê", Ocirc: "Ô",
  agrave: "à", Agrave: "À", ccedil: "ç", Ccedil: "Ç",
  uuml: "ü", Uuml: "Ü", ordm: "º", ordf: "ª", deg: "°",
  hellip: "…", ndash: "–", mdash: "—", bull: "•",
  euro: "€", pound: "£", reg: "®", copy: "©",
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, dec) => numericEntity(parseInt(dec, 10)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => numericEntity(parseInt(hex, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&([A-Za-z][A-Za-z0-9]*);/g, (whole, name: string) => NAMED_ENTITIES[name] ?? whole)
    // &amp; last, so "&amp;lt;" becomes the literal "&lt;" rather than a tag.
    .replace(/&amp;/g, "&")
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
}

export function clean(html: string): string {
  return decodeHtmlEntities(stripTags(html))
}

/** Turn user input into the portal's URL slug: lowercase, accents folded, and
 *  anything that is not a letter or digit collapsed to a single hyphen.
 *  "Automação Industrial" -> "automacao-industrial". */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Card dates arrive in two shapes, and only one of them is a date:
 *   "09/06/2026"  — an absolute dd/mm/yyyy
 *   "Há 3 dias"   — relative, on the fresher postings
 * Both normalise to ISO yyyy-mm-dd here, so `--jobage` and every downstream
 * consumer compare like-for-like. Resolving the relative form at parse time is
 * what keeps the newest postings — the ones a job search actually cares about —
 * from coming back with a null date and slipping past a freshness filter.
 *
 * `now` is injectable so the relative arithmetic is testable without freezing
 * the clock.
 */
export function parseCardDate(text: string, now: Date = new Date()): string | null {
  const absolute = text.match(/(\d{2})\/(\d{2})\/(\d{4})/)
  if (absolute) {
    const [, dd, mm, yyyy] = absolute
    const iso = `${yyyy}-${mm}-${dd}`
    return isNaN(Date.parse(iso)) ? null : iso
  }

  const lower = text.toLowerCase()
  if (/\bhoje\b/.test(lower)) return isoDay(now)
  if (/\bontem\b/.test(lower)) return isoDay(new Date(now.getTime() - 86400000))

  // "há 3 dias", "ha 2 semanas", "há 1 mês". Anything measured in hours or
  // minutes is today.
  const relative = lower.match(/h[áa]\s+(\d+)\s+(minuto|hora|dia|semana|m[êe]s|mes)/)
  if (relative) {
    const n = parseInt(relative[1], 10)
    const unit = relative[2]
    const days =
      unit.startsWith("minuto") || unit.startsWith("hora")
        ? 0
        : unit.startsWith("dia")
          ? n
          : unit.startsWith("semana")
            ? n * 7
            : n * 30
    return isoDay(new Date(now.getTime() - days * 86400000))
  }

  return null
}

/**
 * Parse the search page into cards. Each `<li class="vaga odd|even">` is sliced
 * out and parsed independently, so one malformed posting cannot take the rest
 * of the page down with it.
 */
export function parseJobCards(html: string): JobCard[] {
  const results: JobCard[] = []
  // Sponsored inserts use `<li class="publicidade">` and simply never match.
  const chunks = html.split(/<li[^>]*class="vaga (?:odd|even)/).slice(1)

  for (const chunk of chunks) {
    const idMatch = chunk.match(/data-id-vaga="(\d+)"/)
    if (!idMatch) continue
    const id = idMatch[1]

    // The anchor's title attribute holds the clean title; the anchor *text*
    // is peppered with <mark> tags highlighting the query terms.
    const anchor = chunk.match(
      /<a[^>]*class="[^"]*link-detalhes-vaga[^"]*"[^>]*>/i,
    )?.[0]
    if (!anchor) continue

    const titleAttr = anchor.match(/title="([^"]*)"/i)?.[1]
    const href = anchor.match(/href="([^"]*)"/i)?.[1]
    const title = titleAttr ? decodeHtmlEntities(titleAttr).trim() : null
    if (!title) continue

    const company = clean(chunk.match(/class="emprVaga"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "") || null
    const level = clean(chunk.match(/class="nivelVaga"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "") || null

    // The location block holds an icon, the "Cidade / UF" text, and sometimes a
    // tooltip div. Cut at the tooltip so its copy never leaks into the field.
    const localRaw = chunk.match(/class="vaga-local"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? ""
    const location = clean(localRaw.split(/<div[^>]*class="tooltip-place/i)[0]) || null

    const dateRaw = chunk.match(/class="data-publicacao"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? ""
    const date = parseCardDate(clean(dateRaw))

    const snippet = clean(chunk.match(/class="detalhes"[^>]*>\s*<p>([\s\S]*?)<\/p>/i)?.[1] ?? "") || null

    results.push({
      id,
      title,
      company,
      location,
      date,
      url: href ? `${BASE}${decodeHtmlEntities(href)}` : `${BASE}/vagas/v${id}`,
      level,
      snippet,
    })
  }

  return results
}

interface LdJobPosting {
  title?: unknown
  description?: unknown
  datePosted?: unknown
  validThrough?: unknown
  jobBenefits?: unknown
  hiringOrganization?: { name?: unknown }
  jobLocation?: unknown
}

/** Pull the schema.org JobPosting block out of a posting page. The portal ships
 *  one per page; anything else in a ld+json script (breadcrumbs, org markup) is
 *  skipped rather than guessed at. */
export function extractJsonLd(html: string): LdJobPosting | null {
  const blocks = html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
  )
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1].trim()) as Record<string, unknown>
      const candidates = Array.isArray(parsed) ? parsed : [parsed]
      for (const c of candidates) {
        if (c && (c as Record<string, unknown>)["@type"] === "JobPosting") {
          return c as LdJobPosting
        }
      }
    } catch {
      // A malformed block is skipped; the next one may still be the posting.
    }
  }
  return null
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

/** "Salvador, BA" out of the nested schema.org PostalAddress. */
function ldLocation(raw: unknown): string | null {
  const place = Array.isArray(raw) ? raw[0] : raw
  const address = (place as { address?: Record<string, unknown> } | undefined)?.address
  if (!address) return null
  const city = str(address.addressLocality)
  const region = str(address.addressRegion)
  if (city && region) return `${city}, ${region}`
  return city ?? region ?? null
}

export function textFromHtml(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null
  const withBreaks = raw
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|ul|ol|div|h\d|tr)>/gi, "\n")
  const text = decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text || null
}

export function buildDetail(ld: LdJobPosting, id: string, url: string): JobDetail {
  return {
    id,
    title: str(ld.title) ?? "(sem título)",
    company: str(ld.hiringOrganization?.name),
    location: ldLocation(ld.jobLocation),
    date: str(ld.datePosted),
    url,
    level: null,
    snippet: null,
    description: textFromHtml(ld.description),
    validThrough: str(ld.validThrough),
    benefits: textFromHtml(ld.jobBenefits),
  }
}

/** Accept a bare id, the portal's `v`-prefixed id, or a full posting URL. */
export function normalizeId(input: string): string | null {
  const bare = input.match(/^v?(\d{3,})$/i)
  if (bare) return bare[1]
  const fromUrl = input.match(/\/vagas\/v(\d+)/i)
  if (fromUrl) return fromUrl[1]
  return null
}

/** Client-side `--jobage`: the portal exposes no freshness parameter. Postings
 *  with an unparseable date are kept, since a missing field is not staleness. */
export function withinJobAge(card: JobCard, days: number | undefined): boolean {
  if (days === undefined) return true
  if (!card.date) return true
  const published = Date.parse(card.date)
  if (isNaN(published)) return true
  return Date.now() - published <= days * 86400000
}
