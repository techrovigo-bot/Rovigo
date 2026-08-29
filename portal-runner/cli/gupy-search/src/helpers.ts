// Data source: Gupy's public employability-portal API (the JSON backend behind
// portal.gupy.io). No authentication and no API key. Search and detail both
// return JSON, so there is no HTML parsing here at all — the only sanitising
// needed is on `description`, which some employers fill in with HTML.
//
// robots.txt on portal.gupy.io is `User-agent: * / Disallow:` (nothing
// disallowed) and the API host publishes none, so the honest User-Agent below
// is never refused. See url-reference.md.

export const API_BASE = "https://employability-portal.gupy.io/api/v1/jobs"

/** Results requested per page. The API caps nothing, but a modest page keeps
 *  a single `search` call cheap and matches how the other portal CLIs page. */
export const PAGE_SIZE = 20

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const UA = "Mozilla/5.0 (compatible; gupy-search-cli/1.0)"

/** Fetch JSON with exponential backoff on 429/5xx. Returns null on a 404. */
export async function jsonFetch(url: string): Promise<unknown | null> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        "Accept-Language": "pt-BR,pt;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
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
    if (response.status === 404) return null
    // The API answers an unknown query parameter with 400 rather than ignoring
    // it, which is a contract violation on our side, not a portal outage.
    if (response.status === 400) {
      throw new Error(
        "Gupy rejected the request (400). A parameter name is wrong — the API validates strictly and never ignores unknown params.",
      )
    }
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }
    return response.json()
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
  workplaceType: string | null
  isRemote: boolean
  applicationDeadline: string | null
  contractType: string | null
}

export interface JobDetail extends JobCard {
  description: string | null
  companyUrl: string | null
  disabilityFriendly: boolean
}

function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

/** Named entities that actually turn up in Brazilian job ads. Employers paste
 *  descriptions out of Word and similar editors, which emit the accented
 *  Latin-1 names rather than numeric references, so a decoder that only knows
 *  &amp;/&lt;/&gt; leaves "an&aacute;lise" sitting in the middle of the text. */
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

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, dec) => numericEntity(parseInt(dec, 10)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => numericEntity(parseInt(hex, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&([A-Za-z][A-Za-z0-9]*);/g, (whole, name: string) => NAMED_ENTITIES[name] ?? whole)
    // &amp; decodes last, so "&amp;lt;" ends up as the literal text "&lt;"
    // instead of being re-read as a tag delimiter by the passes above.
    .replace(/&amp;/g, "&")
}

/** Employers paste descriptions in wildly varying shapes: some plain text,
 *  some full HTML. Normalise both to readable text with paragraph breaks. */
export function cleanDescription(raw: unknown): string | null {
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

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

/** "Curitiba, Paraná" from the separate city/state fields; either may be blank
 *  (remote postings routinely carry no city at all). */
export function composeLocation(raw: Record<string, unknown>): string | null {
  const city = str(raw.city)
  const state = str(raw.state)
  if (city && state) return `${city}, ${state}`
  return city ?? state ?? null
}

/** The portal's own share link carries a base64 tracking blob; keep it, since
 *  it is the URL that actually resolves, but drop the query string noise. */
function jobUrl(raw: Record<string, unknown>, id: string): string {
  const url = str(raw.jobUrl)
  if (url) return url.split("?")[0]
  return `https://portal.gupy.io/job/${id}`
}

export function mapJobCard(raw: Record<string, unknown>): JobCard | null {
  const id = raw.id === undefined || raw.id === null ? null : String(raw.id)
  const title = str(raw.name)
  if (!id || !title) return null
  return {
    id,
    title,
    company: str(raw.careerPageName),
    location: composeLocation(raw),
    date: str(raw.publishedDate),
    url: jobUrl(raw, id),
    workplaceType: str(raw.workplaceType),
    isRemote: raw.isRemoteWork === true || raw.workplaceType === "remote",
    applicationDeadline: str(raw.applicationDeadline),
    contractType: str(raw.type),
  }
}

export function mapJobDetail(raw: Record<string, unknown>): JobDetail | null {
  const card = mapJobCard(raw)
  if (!card) return null
  return {
    ...card,
    description: cleanDescription(raw.description),
    companyUrl: str(raw.careerPageUrl)?.split("?")[0] ?? null,
    disabilityFriendly: raw.disabilities === true,
  }
}

/** Gupy exposes no date filter and no sort parameter, so `--jobage` is applied
 *  client-side against `publishedDate`. Postings with no date are kept: a
 *  missing field is not evidence the posting is stale. */
export function withinJobAge(card: JobCard, days: number | undefined): boolean {
  if (days === undefined) return true
  if (!card.date) return true
  const published = Date.parse(card.date)
  if (isNaN(published)) return true
  return Date.now() - published <= days * 86400000
}

/** Our `--remote` vocabulary (shared across the repo's portal CLIs) mapped to
 *  the values Gupy's `workplaceType` parameter accepts. */
export function workplaceParam(mode: string | undefined): string | null {
  switch ((mode || "").toLowerCase()) {
    case "remote":
      return "remote"
    case "hybrid":
      return "hybrid"
    case "onsite":
    case "on-site":
      return "on-site"
    default:
      return null
  }
}

/** Accept a bare numeric id, a portal URL, or a company career-page job URL.
 *  Gupy's job links carry the id inside a base64 blob
 *  (`/job/eyJqb2JJZCI6MTIyMjM0MDMs...` decodes to `{"jobId":12223403,...}`),
 *  so a URL pasted from the browser resolves without the user digging the id
 *  out by hand. */
export function normalizeId(input: string): string | null {
  const bare = input.match(/^\d{3,}$/)
  if (bare) return input

  const blob = input.match(/\/job\/([A-Za-z0-9+/=_-]{8,})/)
  if (blob) {
    try {
      const padded = blob[1].replace(/-/g, "+").replace(/_/g, "/")
      const decoded = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
      const parsed = JSON.parse(decoded) as { jobId?: unknown }
      if (parsed && parsed.jobId !== undefined) return String(parsed.jobId)
    } catch {
      // Not a base64 job blob — fall through to the numeric scan below.
    }
  }

  const numeric = input.match(/(\d{6,})/)
  return numeric ? numeric[1] : null
}
