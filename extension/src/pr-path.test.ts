import { expect, test } from "bun:test";
import { parsePrPath } from "./pr-path";

test("recognises every tab of a pull request", () => {
  for (const path of ["/acme/api/pull/42", "/acme/api/pull/42/", "/acme/api/pull/42/files", "/acme/api/pull/42/changes"]) {
    expect(parsePrPath(path)).toEqual({ owner: "acme", repo: "api", number: 42 });
  }
});

test("ignores other GitHub pages", () => {
  for (const path of ["/acme/api", "/acme/api/pulls", "/acme/api/pull/new/branch", "/acme/api/issues/42"]) {
    expect(parsePrPath(path)).toBeNull();
  }
});
