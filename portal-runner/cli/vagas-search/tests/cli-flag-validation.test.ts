import { describe, expect, test } from "bun:test";
import { runCLI } from "./helpers";

// Every case fails validation before any network request, so this file is
// network-free. The contract in .claude/commands/add-portal.md requires a bogus
// flag or a missing required argument to exit 1 with a JSON error on stderr and
// nothing at all on stdout.

function expectError(
  result: { exitCode: number; stdout: string; stderr: string },
  code: string,
) {
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  const error = JSON.parse(result.stderr);
  expect(error.code).toBe(code);
  expect(typeof error.error).toBe("string");
}

describe("Vagas.com CLI flag validation", () => {
  test("an unknown flag is rejected instead of silently dropped", async () => {
    expectError(await runCLI(["search", "-q", "dados", "--remote", "remote"]), "UNKNOWN_FLAG");
  });

  test("a search with neither keyword nor city is refused", async () => {
    expectError(await runCLI(["search"]), "NO_FILTER");
  });

  test("--limit=0 is rejected", async () => {
    expectError(await runCLI(["search", "-q", "dados", "--limit=0"]), "BAD_ARG");
  });

  test("--limit=-1 is rejected instead of slicing off the last result", async () => {
    expectError(await runCLI(["search", "-q", "dados", "--limit=-1"]), "BAD_ARG");
  });

  test("--page=0 is rejected on the 1-indexed portal", async () => {
    expectError(await runCLI(["search", "-q", "dados", "--page=0"]), "BAD_ARG");
  });

  test("--jobage=1.5 is rejected as non-integer", async () => {
    expectError(await runCLI(["search", "-q", "dados", "--jobage=1.5"]), "BAD_ARG");
  });

  test("--format rejects an unsupported renderer", async () => {
    expectError(await runCLI(["search", "-q", "dados", "--format", "csv"]), "BAD_ARG");
  });

  test("detail without an id exits 1", async () => {
    expectError(await runCLI(["detail"]), "NO_ID");
  });

  test("detail rejects an id it cannot parse", async () => {
    expectError(await runCLI(["detail", "nao-e-um-id"]), "BAD_ID");
  });

  test("an unknown command exits 1", async () => {
    expectError(await runCLI(["listar"]), "BAD_CMD");
  });
});
