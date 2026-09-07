import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { JSONReport } from "@playwright/test/reporter";
import { afterAll, beforeAll, expect, it } from "vitest";
import { discoveredTests, partitionTests } from "../smoke-partition";

const root = resolve(import.meta.dirname, "../../..");
let directory: string;
let report: JSONReport;

/** Real Playwright collection and reporter calls; no browser or app is started. */
function playwright(...args: string[]): string {
	return execFileSync(
		process.execPath,
		[resolve(root, "node_modules/playwright/cli.js"), "test", ...args],
		{ cwd: directory, encoding: "utf8", timeout: 20_000 },
	);
}

beforeAll(() => {
	directory = mkdtempSync(resolve(tmpdir(), "nova-smoke-partition-"));
	writeFileSync(
		resolve(directory, "playwright.config.mjs"),
		`export default ${JSON.stringify({
			testDir: ".",
			workers: 1,
			retries: 1,
			projects: [{ name: "first" }, { name: "second" }],
		})};`,
	);
	writeFileSync(
		resolve(directory, "fixture.spec.ts"),
		`import { test } from ${JSON.stringify(resolve(root, "node_modules/@playwright/test/index.mjs"))};
test.describe("outer", () => {
  test("passes", () => {});
  test.describe("inner", () => {
    test("passes", () => {});
    test("retry", ({}, info) => {
      if (info.retry === 0) throw new Error("Intentional first-attempt fixture failure");
    });
    test.skip("skipped", () => {});
  });
});
`,
	);
	report = JSON.parse(playwright("--list", "--reporter=json"));
});

afterAll(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

it("assigns every native identity once and preserves exact nested/project selection", {
	timeout: 15_000,
}, () => {
	const original = discoveredTests(report);
	expect(original).toHaveLength(8);
	const selectors: string[] = [];
	for (const project of ["first", "second"])
		for (const title of [
			"outer › passes",
			"outer › inner › passes",
			"outer › inner › retry",
			"outer › inner › skipped",
		])
			selectors.push(`[${project}] › fixture.spec.ts › ${title}`);
	expect(original.map((row) => row.selector).sort()).toEqual(selectors.sort());
	const heavy = original[0].selector;
	const timings = { [heavy]: 50_000 }; // All other discovered tests are new.
	const selectedIds: string[] = [];
	for (const current of [1, 2, 3]) {
		const selected = partitionTests(report, `${current}/3`, timings);
		if (selected.some((row) => row.selector === heavy))
			expect(selected).toHaveLength(1);
		const list = resolve(directory, `partition-${current}.txt`);
		writeFileSync(list, `${selected.map((row) => row.selector).join("\n")}\n`);
		const native = discoveredTests(
			JSON.parse(playwright("--list", "--reporter=json", "--test-list", list)),
		);
		expect(native).toEqual(selected);
		selectedIds.push(...native.map((row) => row.identity));
	}
	expect(selectedIds.sort()).toEqual(
		original.map((row) => row.identity).sort(),
	);
});

it("records real public reporter identities and excludes skipped and retried outcomes", {
	timeout: 15_000,
}, () => {
	playwright("--reporter", resolve(root, "scripts/ci/smoke-timings.ts"));
	const result = JSON.parse(
		readFileSync(
			resolve(directory, "e2e/playwright-report/timings.json"),
			"utf8",
		),
	) as { durationsMs: Record<string, number> };
	expect(Object.keys(result.durationsMs).sort()).toEqual([
		"[first] › fixture.spec.ts › outer › inner › passes",
		"[first] › fixture.spec.ts › outer › passes",
		"[second] › fixture.spec.ts › outer › inner › passes",
		"[second] › fixture.spec.ts › outer › passes",
	]);
	for (const duration of Object.values(result.durationsMs)) {
		expect(Number.isFinite(duration)).toBe(true);
		expect(duration).toBeGreaterThanOrEqual(1);
	}
});
