import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	type DiscoveryReport,
	discoveredSmokeScenarios,
	readDiscoveryReport,
	selectedDiscoveryProjects,
} from "../../../e2e/lib/scenarioSeeds";

const root = resolve(import.meta.dirname, "../../..");
let directory: string;
function discover(...args: string[]): DiscoveryReport {
	const manifest = resolve(directory, "native.json");
	const json = execFileSync(
		process.execPath,
		[
			resolve(root, "node_modules/playwright/cli.js"),
			"test",
			"--list",
			`--reporter=json,${resolve(root, "scripts/ci/smoke-discovery-reporter.ts")}`,
			...args,
		],
		{
			cwd: directory,
			encoding: "utf8",
			timeout: 20_000,
			env: { ...process.env, NOVA_E2E_DISCOVERY_MANIFEST: manifest },
		},
	);
	writeFileSync(manifest, json);
	return readDiscoveryReport(manifest);
}

beforeAll(() => {
	directory = mkdtempSync(resolve(tmpdir(), "nova-smoke-discovery-"));
	writeFileSync(
		resolve(directory, "playwright.config.mjs"),
		`export default ${JSON.stringify({
			testDir: ".",
			fullyParallel: true,
			retries: 2,
			projects: [
				{ name: "authed", testMatch: "**/app.spec.ts" },
				{ name: "browser", testMatch: "**/browser.spec.ts" },
				{ name: "mp-manual", testMatch: "**/manual.spec.ts" },
			],
		})};`,
	);
	const imported = `import { test } from ${JSON.stringify(resolve(root, "node_modules/@playwright/test/index.mjs"))};\n`;
	writeFileSync(
		resolve(directory, "app.spec.ts"),
		imported +
			`test("open", { tag: "@seed:open" }, () => {});\ntest("delete", { tag: "@seed:delete" }, () => {});\ntest("missing", () => {});\ntest("conflicting", { tag: ["@seed:open", "@seed:delete"] }, () => {});\ntest("unknown", { tag: "@seed:typo" }, () => {});\n`,
	);
	writeFileSync(
		resolve(directory, "browser.spec.ts"),
		`${imported}test("component", () => {});\n`,
	);
	writeFileSync(
		resolve(directory, "manual.spec.ts"),
		`${imported}test("manual", () => {});\n`,
	);
});
afterAll(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

it("uses native project, grep, repeat and retry selection for unique fixture attempts", () => {
	const report = discover(
		"--project=authed",
		"--grep= (open|delete)( |$)",
		"--repeat-each=2",
		"--retries=1",
	);
	const requests = discoveredSmokeScenarios(report);
	expect(requests).toHaveLength(8);
	expect(new Set(requests.map((request) => request.key)).size).toBe(8);
	for (const profile of ["open", "delete"])
		expect(
			requests.filter((request) => request.profile === profile),
		).toHaveLength(4);
	expect([...selectedDiscoveryProjects(report)]).toEqual(["authed"]);
	const sharded = [1, 2].flatMap((shard) =>
		discoveredSmokeScenarios(
			discover(
				"--project=authed",
				"--grep= (open|delete)( |$)",
				"--repeat-each=2",
				"--retries=1",
				`--shard=${shard}/2`,
			),
		),
	);
	expect(sharded.sort((a, b) => a.key.localeCompare(b.key))).toEqual(
		requests.sort((a, b) => a.key.localeCompare(b.key)),
	);
});
it.each(["missing", "conflicting", "unknown"])(
	"refuses the native %s profile before any database work",
	(title) => {
		expect(() =>
			discoveredSmokeScenarios(
				discover("--project=authed", `--grep= ${title}( |$)`),
			),
		).toThrow("exactly one known @seed:");
	},
);
it.each([1, 2])(
	"preserves the exact native attempt union when lanes are sharded separately with %s repeats",
	(repeats) => {
		const args = [
			"--project=browser",
			"--project=authed",
			"--grep= (open|component)( |$)",
			`--repeat-each=${repeats}`,
		];
		const report = discover(...args);
		const manifest = resolve(directory, "discovery.json");
		writeFileSync(manifest, JSON.stringify(report));
		writeFileSync(`${manifest}.attempts.json`, JSON.stringify(report.attempts));
		execFileSync(
			process.execPath,
			[
				resolve(root, "node_modules/tsx/dist/cli.mjs"),
				resolve(root, "scripts/ci/smoke-discovery.ts"),
				manifest,
				directory,
			],
			{ cwd: root, timeout: 20_000 },
		);
		const actualAttempts: DiscoveryReport["attempts"] = [];
		for (const lane of ["browser", "app"]) {
			const list = resolve(directory, `${lane}.txt`);
			expect(readFileSync(list, "utf8").trim()).not.toBe("");
			for (const shard of [1, 2]) {
				const selected = discover(
					...args,
					"--test-list",
					list,
					`--shard=${shard}/2`,
				);
				actualAttempts.push(...selected.attempts);
			}
		}
		expect(
			actualAttempts.sort((a, b) => a.testId.localeCompare(b.testId)),
		).toEqual(report.attempts.sort((a, b) => a.testId.localeCompare(b.testId)));
	},
);
