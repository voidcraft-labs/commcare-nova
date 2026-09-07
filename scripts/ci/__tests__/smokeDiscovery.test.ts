import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	type DiscoveryReport,
	discoveredSmokeScenarios,
	readDiscoveryReport,
	selectedDiscoveryProjects,
} from "../../../e2e/lib/scenarioSeeds";

const root = resolve(import.meta.dirname, "../../..");
let directory: string;
const execute = promisify(execFile);
async function discover(
	signal: AbortSignal,
	...args: string[]
): Promise<DiscoveryReport> {
	const manifest = resolve(directory, `${randomUUID()}.json`);
	const { stdout: json } = await execute(
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
			signal,
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

/** Independent CLI probes own their output files and are all joined even when
 * one fails. The test's abort signal retires child processes on timeout. */
async function discoverAll(signal: AbortSignal, selections: string[][]) {
	const results = await Promise.allSettled(
		selections.map((args) => discover(signal, ...args)),
	);
	const reports: DiscoveryReport[] = [];
	const failures: unknown[] = [];
	for (const result of results) {
		if (result.status === "fulfilled") reports.push(result.value);
		else failures.push(result.reason);
	}
	if (failures.length)
		throw new AggregateError(failures, "Native discovery failed");
	return reports;
}

it("uses native project, grep, repeat and retry selection for unique fixture attempts", async ({
	signal,
}) => {
	const args = [
		"--project=authed",
		"--grep= (open|delete)( |$)",
		"--repeat-each=2",
		"--retries=1",
	];
	const [report, ...partitions] = await discoverAll(signal, [
		args,
		...[1, 2].map((shard) => [...args, `--shard=${shard}/2`]),
	]);
	const requests = discoveredSmokeScenarios(report);
	expect(requests).toHaveLength(8);
	expect(new Set(requests.map((request) => request.key)).size).toBe(8);
	for (const profile of ["open", "delete"])
		expect(
			requests.filter((request) => request.profile === profile),
		).toHaveLength(4);
	expect([...selectedDiscoveryProjects(report)]).toEqual(["authed"]);
	const sharded = partitions.flatMap(discoveredSmokeScenarios);
	expect(sharded.sort((a, b) => a.key.localeCompare(b.key))).toEqual(
		requests.sort((a, b) => a.key.localeCompare(b.key)),
	);
});
for (const title of ["missing", "conflicting", "unknown"]) {
	it(`refuses the native ${title} profile before any database work`, async ({
		signal,
	}) => {
		const report = await discover(
			signal,
			"--project=authed",
			`--grep= ${title}( |$)`,
		);
		expect(() => discoveredSmokeScenarios(report)).toThrow(
			"exactly one known @seed:",
		);
	});
}
for (const repeats of [1, 2]) {
	it(`preserves the exact native attempt union when lanes are sharded separately with ${repeats} repeats`, async ({
		signal,
	}) => {
		const args = [
			"--project=browser",
			"--project=authed",
			"--grep= (open|component)( |$)",
			`--repeat-each=${repeats}`,
		];
		const report = await discover(signal, ...args);
		const planDirectory = mkdtempSync(resolve(directory, "lanes-"));
		const manifest = resolve(planDirectory, "discovery.json");
		writeFileSync(manifest, JSON.stringify(report));
		writeFileSync(`${manifest}.attempts.json`, JSON.stringify(report.attempts));
		await execute(
			process.execPath,
			[
				resolve(root, "node_modules/tsx/dist/cli.mjs"),
				resolve(root, "scripts/ci/smoke-discovery.ts"),
				manifest,
				planDirectory,
			],
			{ cwd: root, timeout: 20_000, signal },
		);
		const selections: string[][] = [];
		for (const lane of ["browser", "app"]) {
			const list = resolve(planDirectory, `${lane}.txt`);
			expect(readFileSync(list, "utf8").trim()).not.toBe("");
			for (const shard of [1, 2])
				selections.push([...args, "--test-list", list, `--shard=${shard}/2`]);
		}
		const actualAttempts = (await discoverAll(signal, selections)).flatMap(
			(selected) => selected.attempts,
		);
		expect(
			actualAttempts.sort((a, b) => a.testId.localeCompare(b.testId)),
		).toEqual(report.attempts.sort((a, b) => a.testId.localeCompare(b.testId)));
	});
}
