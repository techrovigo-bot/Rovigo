import { describe, expect, test } from "bun:test";
import {
  cleanDescription,
  composeLocation,
  mapJobCard,
  normalizeId,
  withinJobAge,
  workplaceParam,
} from "../src/helpers";
import { buildUrl } from "../src/commands/search";

// Pure-function tests over the shapes the API actually returned during
// investigation (see url-reference.md). Network-free.

const RAW = {
  id: 12223403,
  name: "Analista de Dados Pleno | FinOps",
  careerPageName: "Globo",
  city: "Rio de Janeiro",
  state: "Rio de Janeiro",
  publishedDate: "2026-08-22T00:28:44.153Z",
  applicationDeadline: "2026-09-08",
  jobUrl:
    "https://globo.gupy.io/job/eyJqb2JJZCI6MTIyMjM0MDMsInNvdXJjZSI6Imd1cHlfcG9ydGFsIn0=?jobBoardSource=gupy_portal",
  workplaceType: "hybrid",
  isRemoteWork: false,
  type: "vacancy_type_effective",
};

describe("mapJobCard", () => {
  test("maps every contract field from a real API row", () => {
    const card = mapJobCard(RAW)!;
    expect(card.id).toBe("12223403");
    expect(card.title).toBe("Analista de Dados Pleno | FinOps");
    expect(card.company).toBe("Globo");
    expect(card.location).toBe("Rio de Janeiro, Rio de Janeiro");
    expect(card.date).toBe("2026-08-22T00:28:44.153Z");
    expect(card.url).toBe(
      "https://globo.gupy.io/job/eyJqb2JJZCI6MTIyMjM0MDMsInNvdXJjZSI6Imd1cHlfcG9ydGFsIn0=",
    );
  });

  test("a row missing id or title is dropped rather than emitted half-empty", () => {
    expect(mapJobCard({ ...RAW, name: "" })).toBeNull();
    expect(mapJobCard({ ...RAW, id: null })).toBeNull();
  });

  test("missing values are null, never absent", () => {
    const card = mapJobCard({ id: 1, name: "Vaga" })!;
    expect(card.company).toBeNull();
    expect(card.location).toBeNull();
    expect(card.date).toBeNull();
  });
});

describe("composeLocation", () => {
  test("remote postings with a blank city fall back to the state", () => {
    expect(composeLocation({ city: "", state: "Paraná" })).toBe("Paraná");
  });

  test("a posting with neither is null, not an empty string", () => {
    expect(composeLocation({ city: "", state: "" })).toBeNull();
  });
});

describe("normalizeId", () => {
  test("accepts a bare numeric id", () => {
    expect(normalizeId("12223403")).toBe("12223403");
  });

  test("decodes the base64 job blob in a career-page URL", () => {
    expect(normalizeId(RAW.jobUrl)).toBe("12223403");
  });

  test("returns null for input carrying no id at all", () => {
    expect(normalizeId("https://portal.gupy.io/")).toBeNull();
  });
});

describe("withinJobAge", () => {
  const card = mapJobCard(RAW)!;

  test("no --jobage keeps everything", () => {
    expect(withinJobAge(card, undefined)).toBe(true);
  });

  test("a posting with no date is kept, since a missing field is not staleness", () => {
    expect(withinJobAge({ ...card, date: null }, 1)).toBe(true);
  });

  test("an old posting is filtered out", () => {
    expect(withinJobAge({ ...card, date: "2020-01-01T00:00:00.000Z" }, 7)).toBe(false);
  });

  test("a posting from today survives a 1-day window", () => {
    expect(withinJobAge({ ...card, date: new Date().toISOString() }, 1)).toBe(true);
  });
});

describe("buildUrl", () => {
  test("sends only parameters the API knows, since it rejects unknown names with 400", () => {
    const url = new URL(
      buildUrl({ query: "dados", location: "Curitiba", page: 2, format: "json" }),
    );
    expect(url.searchParams.get("jobName")).toBe("dados");
    expect(url.searchParams.get("city")).toBe("Curitiba");
    expect(url.searchParams.get("offset")).toBe("20");
    expect(url.searchParams.get("limit")).toBe("20");
    // jobage is a client-side filter: the portal has no date parameter at all.
    expect(url.searchParams.has("jobage")).toBe(false);
    expect(url.searchParams.has("publishedDate")).toBe(false);
  });

  test("workplaceType uses the portal's spelling, not ours", () => {
    expect(workplaceParam("onsite")).toBe("on-site");
    const url = new URL(buildUrl({ query: "x", remote: "onsite", page: 1, format: "json" }));
    expect(url.searchParams.get("workplaceType")).toBe("on-site");
  });
});

describe("cleanDescription", () => {
  test("strips markup and decodes entities into readable text", () => {
    const text = cleanDescription(
      "<p>Vaga de <b>an&aacute;lise</b></p><ul><li>SQL</li><li>Python</li></ul>",
    );
    expect(text).toContain("análise");
    expect(text).not.toContain("<");
    expect(text).toContain("SQL");
  });

  test("an empty description is null, not an empty string", () => {
    expect(cleanDescription("")).toBeNull();
    expect(cleanDescription(null)).toBeNull();
  });
});
