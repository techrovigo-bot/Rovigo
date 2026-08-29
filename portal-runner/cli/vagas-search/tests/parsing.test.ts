import { describe, expect, test } from "bun:test";
import {
  buildDetail,
  clean,
  extractJsonLd,
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
<li class="vaga even ">
  <header>
    <div class="informacoes-header">
      <h2 class="cargo">
        <a class="link-detalhes-vaga" data-id-vaga="2819206" title="Analista de Dados" id="v2819206" href="/vagas/v2819206/analista-de-dados">
            <mark>Analista</mark> de <mark>Dados</mark>
        </a>
      </h2>
      <span class="emprVaga">
          UNIJORGE
      </span>
      <div class="nivelQtdVagas"><span class="nivelVaga">Pleno</span></div>
    </div>
  </header>
  <div class="detalhes">
    <p>Descri&ccedil;&atilde;o: Coletar e analisar dados usando Excel.</p>
  </div>
  <footer>
    <div class="vaga-local">
      <i class="bx bx-map"></i>
      Salvador / BA
      <div class="tooltip-place" role="tooltip">
        <div class="tooltip-text"><div id="tooltip-place">A empresa aceita candidaturas de qualquer cidade do Brasil</div></div>
      </div>
    </div>
    <span class="data-publicacao"><i class="bx bx-time-five"></i>09/06/2026</span>
  </footer>
</li>
<li class="publicidade"><span>an&uacute;ncio</span></li>
<li class="vaga odd ">
  <h2 class="cargo">
    <a class="link-detalhes-vaga" data-id-vaga="2831388" title="Analista Pl Privacidade Dados" href="/vagas/v2831388/analista-pl">Analista</a>
  </h2>
  <span class="emprVaga">Elera Renov&aacute;veis</span>
  <footer>
    <div class="vaga-local"><i class="bx bx-map"></i>S&atilde;o Paulo / SP</div>
    <span class="data-publicacao"><i class="bx bx-time-five"></i>H&aacute; 3 dias</span>
  </footer>
</li>
</ul>`;

describe("parseJobCards", () => {
  const cards = parseJobCards(CARD_HTML);

  test("finds every real posting and skips the sponsored insert", () => {
    expect(cards.length).toBe(2);
    expect(cards.map((c) => c.id)).toEqual(["2819206", "2831388"]);
  });

  test("takes the title from the anchor attribute, not the mark-riddled text", () => {
    expect(cards[0]!.title).toBe("Analista de Dados");
    expect(cards[0]!.title).not.toContain("<mark>");
  });

  test("maps company, location, level and url", () => {
    expect(cards[0]!.company).toBe("UNIJORGE");
    expect(cards[0]!.location).toBe("Salvador / BA");
    expect(cards[0]!.level).toBe("Pleno");
    expect(cards[0]!.url).toBe("https://www.vagas.com.br/vagas/v2819206/analista-de-dados");
  });

  test("the tooltip copy never leaks into the location field", () => {
    expect(cards[0]!.location).not.toContain("qualquer cidade");
  });

  test("decodes entities in company names", () => {
    expect(cards[1]!.company).toBe("Elera Renováveis");
    expect(cards[1]!.location).toBe("São Paulo / SP");
  });

  test("a card with no date still parses, with date null rather than dropped", () => {
    const noDate = parseJobCards(
      '<li class="vaga odd "><a class="link-detalhes-vaga" data-id-vaga="1" title="X" href="/vagas/v1/x"></a></li>',
    );
    expect(noDate.length).toBe(1);
    expect(noDate[0]!.date).toBeNull();
    expect(noDate[0]!.company).toBeNull();
  });

  test("a page with no results returns an empty array instead of throwing", () => {
    expect(parseJobCards("<ul></ul>")).toEqual([]);
  });
});

describe("parseCardDate", () => {
  const now = new Date("2026-08-23T12:00:00Z");

  test("absolute dd/mm/yyyy becomes ISO", () => {
    expect(parseCardDate("09/06/2026", now)).toBe("2026-06-09");
  });

  test("relative days resolve against the current date", () => {
    expect(parseCardDate("Há 3 dias", now)).toBe("2026-08-20");
  });

  test("accent-free spelling still parses", () => {
    expect(parseCardDate("Ha 3 dias", now)).toBe("2026-08-20");
  });

  test("hoje and ontem resolve", () => {
    expect(parseCardDate("Publicada hoje", now)).toBe("2026-08-23");
    expect(parseCardDate("Ontem", now)).toBe("2026-08-22");
  });

  test("sub-day windows count as today", () => {
    expect(parseCardDate("Há 5 horas", now)).toBe("2026-08-23");
  });

  test("weeks and months are converted, not dropped", () => {
    expect(parseCardDate("Há 2 semanas", now)).toBe("2026-08-09");
    expect(parseCardDate("Há 1 mês", now)).toBe("2026-07-24");
  });

  test("an unrecognised label is null rather than a wrong date", () => {
    expect(parseCardDate("em breve", now)).toBeNull();
  });
});

describe("slugify", () => {
  test("folds accents and collapses separators the way the portal paths do", () => {
    expect(slugify("Automação Industrial")).toBe("automacao-industrial");
    expect(slugify("São Paulo")).toBe("sao-paulo");
    expect(slugify("  Analista   de  Dados ")).toBe("analista-de-dados");
  });
});

describe("buildUrl", () => {
  test("keyword only", () => {
    expect(buildUrl({ query: "analista de dados", page: 1, format: "json" })).toBe(
      "https://www.vagas.com.br/vagas-de-analista-de-dados",
    );
  });

  test("keyword plus city", () => {
    expect(buildUrl({ query: "analista de dados", location: "Curitiba", page: 1, format: "json" })).toBe(
      "https://www.vagas.com.br/vagas-de-analista-de-dados-em-curitiba",
    );
  });

  test("city only uses the other path shape", () => {
    expect(buildUrl({ location: "São Paulo", page: 1, format: "json" })).toBe(
      "https://www.vagas.com.br/vagas-em-sao-paulo",
    );
  });

  test("page 1 carries no query string; later pages use ?pagina=", () => {
    expect(buildUrl({ query: "x", page: 2, format: "json" })).toEndWith("?pagina=2");
  });
});

describe("normalizeId", () => {
  test("accepts a bare id, a v-prefixed id, and a full URL", () => {
    expect(normalizeId("2819206")).toBe("2819206");
    expect(normalizeId("v2819206")).toBe("2819206");
    expect(normalizeId("https://www.vagas.com.br/vagas/v2819206/analista-de-dados")).toBe("2819206");
  });

  test("returns null when there is no id to find", () => {
    expect(normalizeId("https://www.vagas.com.br/")).toBeNull();
  });
});

describe("extractJsonLd and buildDetail", () => {
  const PAGE = `<html><script type="application/ld+json">{"@type":"Organization","name":"x"}</script>
    <script type="application/ld+json">{"@context":"http://schema.org","@type":"JobPosting",
    "title":"Analista de Dados","description":"<p>Coletar dados</p><li>Excel</li>",
    "datePosted":"2026-06-09","validThrough":"2026-08-31",
    "hiringOrganization":{"@type":"Organization","name":"UNIJORGE"},
    "jobLocation":{"@type":"Place","address":{"addressLocality":"Salvador","addressRegion":"BA"}},
    "jobBenefits":"Vale-transporte"}</script></html>`;

  test("skips non-JobPosting blocks and finds the posting", () => {
    const ld = extractJsonLd(PAGE);
    expect(ld).not.toBeNull();
    expect(ld!.title).toBe("Analista de Dados");
  });

  test("a page with no JobPosting block returns null instead of guessing", () => {
    expect(extractJsonLd("<html><body>nada</body></html>")).toBeNull();
  });

  test("a malformed ld+json block does not abort the scan", () => {
    const broken = '<script type="application/ld+json">{ not json </script>' + PAGE;
    expect(extractJsonLd(broken)!.title).toBe("Analista de Dados");
  });

  test("builds the contract shape with location flattened", () => {
    const job = buildDetail(extractJsonLd(PAGE)!, "2819206", "https://www.vagas.com.br/vagas/v2819206");
    expect(job.company).toBe("UNIJORGE");
    expect(job.location).toBe("Salvador, BA");
    expect(job.date).toBe("2026-06-09");
    expect(job.validThrough).toBe("2026-08-31");
    expect(job.description).not.toContain("<p>");
    expect(job.description).toContain("Excel");
  });
});

describe("text helpers", () => {
  test("clean strips tags and decodes entities", () => {
    expect(clean("<span>Descri&ccedil;&atilde;o</span>")).toBe("Descrição");
  });

  test("textFromHtml keeps paragraph breaks and returns null when empty", () => {
    expect(textFromHtml("<p>um</p><p>dois</p>")).toBe("um\ndois");
    expect(textFromHtml("")).toBeNull();
    expect(textFromHtml(null)).toBeNull();
  });
});

describe("withinJobAge", () => {
  const base = parseJobCards(CARD_HTML)[0]!;

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
