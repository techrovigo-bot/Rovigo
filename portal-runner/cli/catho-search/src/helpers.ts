// Data source: catho.com.br public listing pages (Brazil). No authentication
// and no API key. Search results are server-rendered HTML; the posting page
// carries a schema.org JobPosting JSON-LD block, which is what `detail` reads.
//
// ── Access, and why this CLI has a header flag ───────────────────────────────
// Catho's robots.txt allows the paths used here (`/vagas/<termo>/`,
// `/vagas/<termo>/<cidade-uf>/`, `?page=N`, `/vagas/<slug>/<id>`) and
// explicitly disallows two others, which this CLI never touches:
// `/buscar/vagas/` (their internal search endpoint) and any URL carrying `?q=`.
// The repo's tools/robots_check.py confirms both verdicts.
//
// But the site's firewall answers an honest, self-identifying User-Agent with
// 403 while serving the identical page to a browser. Per
// .claude/skills/job-application-assistant/09-web-research.md that is the
// "WAF default on a site whose published policy allows access" case, where
// retrying with browser headers overrides a firewall default rather than an
// expressed preference.
//
// The portal-skill contract in .claude/commands/add-portal.md nevertheless
// requires an honest User-Agent as the CLI's *default*, so escalation here is
// opt-in and explicit: pass --browser-headers, or set CATHO_BROWSER_HEADERS=1.
// Without it the CLI fails loudly with WAF_BLOCKED and explains the choice,
// rather than quietly impersonating a browser on your behalf.

export const BASE = "https://www.catho.com.br"

/** The portal renders a fixed 20 postings per search page. */
export const PAGE_SIZE = 20

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const HONEST_UA = "Mozilla/5.0 (compatible; catho-search-cli/1.0)"

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
}

const HONEST_HEADERS: Record<string, string> = {
  "User-Agent": HONEST_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9",
}

/** Whether the escalation is on, from the flag or the environment variable. */
export function browserHeadersEnabled(flag: boolean, env = process.env): boolean {
  if (flag) return true
  const v = (env.CATHO_BROWSER_HEADERS ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes"
}

export class WafBlockedError extends Error {
  constructor() {
    super(
      "A Catho respondeu 403 ao User-Agent honesto do CLI. O robots.txt dela libera esse caminho, " +
        "então isso é o firewall barrando o cliente, não o portal negando acesso. " +
        "Para escalar conscientemente, rode de novo com --browser-headers (ou exporte CATHO_BROWSER_HEADERS=1). " +
        "Ver a seção de acesso no SKILL.md antes de decidir.",
    )
    this.name = "WafBlockedError"
  }
}

/** Fetch HTML with exponential backoff on 429/5xx. Returns "" on a 404, and
 *  raises WafBlockedError on the 403 the firewall serves to the honest UA. */
export async function htmlFetch(url: string, useBrowserHeaders: boolean): Promise<string> {
  const headers = useBrowserHeaders ? BROWSER_HEADERS : HONEST_HEADERS
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers,
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
    if (response.status === 403 && !useBrowserHeaders) throw new WafBlockedError()
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
  salary: string | null
  sponsored: boolean
}

export interface JobDetail extends JobCard {
  description: string | null
  employmentType: string | null
}

function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

/** Named entities that turn up in Brazilian job ads — employers paste copy out
 *  of Word and similar editors, which emit accented Latin-1 names rather than
 *  numeric references. Catho's own markup uses hex references (&#xE3;), which
 *  the numeric pass below already covers. */
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

/** Fold user input into the portal's URL slug: lowercase, accents dropped,
 *  non-alphanumerics collapsed to a hyphen. */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Cards print "Publicada em 17/08" — day and month, no year. Assume the current
 * year, and step back one year if that lands in the future, which is what a
 * December posting read in January looks like. The one-day tolerance absorbs
 * timezone skew between this machine and the portal.
 */
export function parseCardDate(text: string, now: Date = new Date()): string | null {
  const m = text.match(/(\d{2})\/(\d{2})(?:\/(\d{4}))?/)
  if (!m) return null
  const [, dd, mm, yyyy] = m

  if (yyyy) {
    const iso = `${yyyy}-${mm}-${dd}`
    return isNaN(Date.parse(iso)) ? null : iso
  }

  let year = now.getUTCFullYear()
  const asDate = (y: number): number => Date.parse(`${y}-${mm}-${dd}T00:00:00Z`)
  if (isNaN(asDate(year))) return null
  if (asDate(year) > now.getTime() + 86400000) year -= 1
  return `${year}-${mm}-${dd}`
}

/** Catho masks most employer names. `********` is a mask, not a name, so it
 *  becomes null; "Empresa Confidencial" is the portal's own label for a
 *  deliberately hidden employer and is kept, because it carries meaning. */
export function normalizeCompany(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  if (/^[*\s]+$/.test(text)) return null
  return text
}

/**
 * Parse the search page into cards. Each `<li data-offer-item="...">` is sliced
 * out and parsed independently, so one malformed posting cannot take the rest
 * of the page down with it.
 */
export function parseJobCards(html: string): JobCard[] {
  const results: JobCard[] = []
  const chunks = html.split(/<li[^>]*data-offer-item="/).slice(1)

  for (const chunk of chunks) {
    const idMatch = chunk.match(/^(\d+)"/)
    if (!idMatch) continue
    const id = idMatch[1]

    // Title and URL live together in the offer heading.
    const anchor = chunk.match(
      /class="title_offer"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*title="([^"]*)"/i,
    )
    if (!anchor) continue
    const href = decodeHtmlEntities(anchor[1])
    const title = decodeHtmlEntities(anchor[2]).trim()
    if (!title) continue

    const dateRaw = chunk.match(/class="tag pub_[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? ""
    const date = parseCardDate(clean(dateRaw))

    // Employer name sits in the first small-text span after the heading.
    const companyRaw = chunk.match(/class="text-12[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? ""
    const company = normalizeCompany(clean(companyRaw))

    // Location: the paragraph carrying the location icon holds "<strong>N
    // vaga</strong> - Cidade". Take what follows the closing </strong>.
    let location: string | null = null
    const locBlock = chunk.match(/i_job_location[\s\S]*?<\/span>([\s\S]*?)<\/p>/i)?.[1]
    if (locBlock) {
      const afterStrong = locBlock.split(/<\/strong>/i).pop() ?? ""
      location = clean(afterStrong).replace(/^[\s-]+/, "") || null
    }

    const salaryBlock = chunk.match(/i_salary[\s\S]*?<strong>([\s\S]*?)<\/strong>/i)?.[1]
    const salary = salaryBlock ? clean(salaryBlock) || null : null

    results.push({
      id,
      title,
      company,
      location,
      date,
      url: href.startsWith("http") ? href : `${BASE}${href}`,
      salary,
      sponsored: /of_highlight/.test(chunk),
    })
  }

  return results
}

interface LdJobPosting {
  title?: unknown
  description?: unknown
  datePosted?: unknown
  employmentType?: unknown
  hiringOrganization?: { name?: unknown }
  jobLocation?: unknown
}

/** Pull the schema.org JobPosting block out of a posting page, skipping other
 *  ld+json blocks and malformed ones rather than guessing. */
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

/** "São Paulo, SP" out of the nested schema.org PostalAddress. */
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
  const company = str(ld.hiringOrganization?.name)
  return {
    id,
    title: str(ld.title) ?? "(sem título)",
    company: company ? normalizeCompany(company) : null,
    location: ldLocation(ld.jobLocation),
    date: str(ld.datePosted),
    url,
    salary: null,
    sponsored: false,
    description: textFromHtml(ld.description),
    employmentType: str(ld.employmentType),
  }
}

/** Accept a bare id or any posting URL. The slug in `/vagas/<slug>/<id>` is
 *  decorative — the id alone resolves the posting — so a bare id is enough to
 *  build a working URL. */
export function normalizeId(input: string): string | null {
  const bare = input.match(/^(\d{4,})$/)
  if (bare) return bare[1]
  const fromUrl = input.match(/\/vagas\/[^/]+\/(\d+)/)
  if (fromUrl) return fromUrl[1]
  const trailing = input.match(/\/(\d{4,})\/?$/)
  return trailing ? trailing[1] : null
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
