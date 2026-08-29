# gupy-cli

Command-line search over [Gupy](https://portal.gupy.io)'s public portal API (Brazil).

Zero runtime dependencies: plain `bun` + `fetch`. `bun install` only pulls
TypeScript dev types, so the CLI runs on a fresh clone without installing
anything.

## Install (optional)

```bash
cd .agents/skills/gupy-search/cli && bun install
```

Only needed for `bun run typecheck` and editor types.

## Usage

```bash
bun run src/cli.ts search -q "analista de dados" --format table
bun run src/cli.ts search -q "engenheiro de dados" -l "Curitiba" --jobage 7
bun run src/cli.ts detail 12223403 --format plain
```

`bun run src/cli.ts --help` prints the full flag reference (in Portuguese, as the
portal is Brazilian).

## Contract

Shared with every portal CLI in this repo, so `/scrape` can treat them
interchangeably:

- Commands: `search` and `detail <id|url>`
- JSON output: `{ "meta": { "count", "page", "total" }, "results": [...] }`, each
  result carrying at least `id`, `title`, `company`, `location`, `date`, `url`
  (absent values are `null`, never omitted)
- Errors: `{ "error": "...", "code": "..." }` on **stderr**, exit code `1`
- Unknown flags are rejected, never silently dropped

## Notes for maintainers

- The API 400s on any unrecognised query parameter, so `buildUrl()` must only
  emit names verified against the live endpoint. `url-reference.md` lists the
  full verified set plus everything confirmed to fail.
- There is no date or sort parameter on the portal; `--jobage` filters locally
  after the fetch and can only narrow the page already retrieved.
- `city` and `state` are exact, accent-sensitive matches.

## Tests

```bash
bun test
```

`cli-flag-validation.test.ts` and `parsing.test.ts` are network-free.
`live-smoke.test.ts` hits the real portal (a handful of requests) and is what
proves the field mapping still matches production.
