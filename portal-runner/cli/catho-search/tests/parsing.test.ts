import { describe, expect, test } from "bun:test";
import {
  browserHeadersEnabled,
  buildDetail,
  clean,
  extractJsonLd,
  normalizeCompany,
  normalizeId,
  parseCardDate,
  parseJobCards,
  slugify,
  textFromHtml,
  withinJobAge,
} from "../src/helpers";
import { buildUrl } from "../src/commands/search";

// Fixtures are trimmed copies of markup the portal actually served during
// investigation (see url-reference.md). Network-free.

const CARD_HTML = `
<ul>
<li data-offer-item="37998630" data-blind="false" class="mb-5">
  <article class="offer highlight" data-offer-item-subcontainer>
    <span class="of_highlight mb-1">VAGA PATROCINADA</span>
    <span class="tag pub_ontem mb-2">Publicada em 17/08</span>
    <h2 class="title_offer">
      <a href="/vagas/analista-de-dados-jr/37998630" title="Analista de dados jr" data-navigation-offer>Analista de dados jr</a>
    </h2>
    <p class="mb-2"><span class="text-12">********</span></p>
    <p>
      <span class="icon i_job_location"></span>
      <strong>1 vaga</strong>
      - Ribeir&#xE3;o Preto
    </p>
    <p><span class="icon i_salary"></span><strong>A partir de R$ 3.000,00</strong></p>
  </article>
</li>
<li data-offer-item="38066988" data-blind="false" class="mb-5">
  <article class="offer " data-offer-item-subcontainer>
    <span class="tag pub_ontem mb-2">Publicada em 21/08</span>
    <h2 class="title_offer">
      <a href="/vagas/analista-de-dados-pleno/38066988" title="Analista de Dados Pleno" data-navigation-offer>Analista de Dados Pleno</a>
    </h2>
    <p class="mb-2"><span class="text-12 mr-2">Empresa Confidencial</span></p>
    <p>
      <span class="icon i_job_location"></span>
      <strong>1 vaga</strong>
      - S&#xE3;o Paulo
    </p>
    <p><span class="icon i_salary"></span><strong>A Combinar</strong></p>
  </article>
</li>
</ul>`;

describe("parseJobCards", () => {
  const cards = parseJobCards(CARD_HTML);

  test("finds every posting on the page", () => {
    expect(cards.length).toBe(2);
    expect(cards.map((c) => c.id)).toEqual(["37998630", "38066988"]);
  });

  test("maps title and url", () => {
    expect(cards[1]!.title).toBe("Analista de Dados Pleno");
    expect(cards[1]!.url).toBe("https://www.catho.com.br/vagas/analista-de-dados-pleno/38066988");
  });

  test("a masked employer becomes null, not a row of asterisks", () => {
    expect(cards[0]!.company).toBeNull();
  });

  test('"Empresa Confidencial" is kept, because it means something', () => {
    expect(cards[1]!.company).toBe("Empresa Confidencial");
  });

  test("location drops the vacancy count and the leading dash", () => {
    expect(cards[0]!.location).toBe("Ribeirão Preto");
    expect(cards[1]!.location).toBe("São Paulo");
    expect(cards[0]!.location).not.toContain("vaga");
  });

  test("salary and sponsorship are surfaced", () => {
    expect(cards[0]!.salary).toBe("A partir de R$ 3.000,00");
    expect(cards[0]!.sponsored).toBe(true);
    expect(cards[1]!.sponsored).toBe(false);
  });

  test("a page with no results returns an empty array instead of throwing", () => {
    expect(parseJobCards("<ul></ul>")).toEqual([]);
  });

  test("a card missing its heading is skipped without taking the page down", () => {
    const mixed = CARD_HTML.replace(/<h2 class="title_offer">[\s\S]*?<\/h2>/, "");
    expect(parseJobCards(mixed).length).toBe(1);
  });
});

describe("parseCardDate", () => {
  // Cards print day/month with no year, so the year has to be inferred.
  const now = new Date("2026-08-23T12:00:00Z");

  test("a recent day/month takes the current year", () => {
    expect(parseCardDate("Publicada em 17/08", now)).toBe("2026-08-17");
  });

  test("a day/month in the future is last year's posting, not next year's", () => {
    expect(parseCardDate("Publicada em 15/12", now)).toBe("2025-12-15");
  });

  test("a full date is used as printed", () => {
    expect(parseCardDate("21/08/2026", now)).toBe("2026-08-21");
  });

  test("no date in the text is null rather than a guess", () => {
    expect(parseCardDate("Publicada recentemente", now)).toBeNull();
  });
});

describe("normalizeCompany", () => {
  test("masked and empty values collapse to null", () => {
    expect(normalizeCompany("********")).toBeNull();
    expect(normalizeCompany("   ")).toBeNull();
  });

  test("a real name survives", () => {
    expect(normalizeCompany(" ASSERTIV ")).toBe("ASSERTIV");
  });
});

describe("buildUrl", () => {
  test("keyword goes in the path, never in a query parameter", () => {
    const url = buildUrl({ query: "analista de dados", page: 1, format: "json", browserHeaders: false });
    expect(url).toBe("https://www.catho.com.br/vagas/analista-de-dados/");
    // robots.txt disallows every URL carrying ?q= — the builder must be
    // incapable of producing one.
    expect(url).not.toContain("?q=");
  });

  test("city becomes a second path segment", () => {
    expect(
      buildUrl({ query: "analista de dados", location: "Curitiba PR", page: 1, format: "json", browserHeaders: false }),
    ).toBe("https://www.catho.com.br/vagas/analista-de-dados/curitiba-pr/");
  });

  test("page 1 carries no query string; later pages use ?page=", () => {
    const url = buildUrl({ query: "x", page: 3, format: "json", browserHeaders: false });
    expect(url).toEndWith("?page=3");
    expect(url).not.toContain("?q=");
  });

  test("robots-disallowed paths are unreachable from this builder", () => {
    const url = buildUrl({ query: "buscar vagas", page: 1, format: "json", browserHeaders: false });
    expect(url).not.toContain("/buscar/vagas/");
  });
});

describe("slugify", () => {
  test("folds accents and collapses separators", () => {
    expect(slugify("Automação Industrial")).toBe("automacao-industrial");
    expect(slugify("Curitiba PR")).toBe("curitiba-pr");
    expect(slugify("sao-paulo-sp")).toBe("sao-paulo-sp");
  });
});

describe("browserHeadersEnabled", () => {
  test("off by default, so the CLI never impersonates a browser silently", () => {
    expect(browserHeadersEnabled(false, {})).toBe(false);
  });

  test("the flag turns it on", () => {
    expect(browserHeadersEnabled(true, {})).toBe(true);
  });

  test("the environment variable turns it on", () => {
    expect(browserHeadersEnabled(false, { CATHO_BROWSER_HEADERS: "1" })).toBe(true);
    expect(browserHeadersEnabled(false, { CATHO_BROWSER_HEADERS: "true" })).toBe(true);
  });

  test("an unset or falsy value leaves it off", () => {
    expect(browserHeadersEnabled(false, { CATHO_BROWSER_HEADERS: "0" })).toBe(false);
    expect(browserHeadersEnabled(false, { CATHO_BROWSER_HEADERS: "" })).toBe(false);
  });
});

describe("normalizeId", () => {
  test("accepts a bare id and any posting URL", () => {
    expect(normalizeId("38066988")).toBe("38066988");
    expect(normalizeId("https://www.catho.com.br/vagas/analista-de-dados-pleno/38066988")).toBe("38066988");
  });

  test("returns null when there is no id to find", () => {
    expect(normalizeId("https://www.catho.com.br/vagas/")).toBeNull();
  });
});

describe("extractJsonLd and buildDetail", () => {
  const PAGE = `<html><script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
    <script type="application/ld+json">{"@context":"https://schema.org/","@type":"JobPosting",
    "title":"Analista de Dados Pleno","description":"<p>Transformar dados em insights</p>",
    "datePosted":"2026-08-21T23:59:59Z","employmentType":"CLT (Efetivo)",
    "hiringOrganization":{"@type":"Organization","name":"Empresa Confidencial"},
    "jobLocation":[{"@type":"Place","address":{"addressLocality":"São Paulo","addressRegion":"SP"}}]}</script></html>`;

  test("skips non-JobPosting blocks and finds the posting", () => {
    expect(extractJsonLd(PAGE)!.title).toBe("Analista de Dados Pleno");
  });

  test("a page with no JobPosting block returns null instead of guessing", () => {
    expect(extractJsonLd("<html><body>nada</body></html>")).toBeNull();
  });

  test("builds the contract shape with the location array flattened", () => {
    const job = buildDetail(extractJsonLd(PAGE)!, "38066988", "https://www.catho.com.br/vagas/vaga/38066988");
    expect(job.company).toBe("Empresa Confidencial");
    expect(job.location).toBe("São Paulo, SP");
    expect(job.employmentType).toBe("CLT (Efetivo)");
    expect(job.description).not.toContain("<p>");
  });
});

describe("text helpers", () => {
  test("clean strips tags and decodes hex references, which is what Catho emits", () => {
    expect(clean("<span>S&#xE3;o Paulo</span>")).toBe("São Paulo");
  });

  test("textFromHtml keeps paragraph breaks and returns null when empty", () => {
    expect(textFromHtml("<p>um</p><p>dois</p>")).toBe("um\ndois");
    expect(textFromHtml("")).toBeNull();
  });
});

describe("withinJobAge", () => {
  const base = parseJobCards(CARD_HTML)[1]!;

  test("no window keeps everything", () => {
    expect(withinJobAge(base, undefined)).toBe(true);
  });

  test("a dateless posting is kept, since a missing field is not staleness", () => {
    expect(withinJobAge({ ...base, date: null }, 1)).toBe(true);
  });

  test("an old posting is filtered out", () => {
    expect(withinJobAge({ ...base, date: "2020-01-01" }, 7)).toBe(false);
  });
});
