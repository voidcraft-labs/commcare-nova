import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { JSONReport, JSONReportSuite } from "@playwright/test/reporter";
import { durationsMs } from "../../e2e/smoke-timings.json";

/** Use native discovery identities, never a hand-maintained list of scenarios. */
export function discoveredTests(report: Pick<JSONReport, "errors" | "suites">) {
	if (report.errors.length) throw new Error("Playwright discovery failed");
	const rows: { identity: string; selector: string }[] = [];
	function visit(suite: JSONReportSuite, titles: string[]) {
		for (const spec of suite.specs) {
			for (const test of spec.tests) {
				const parts = [spec.file, ...titles, spec.title];
				if (parts.some((part) => /[\r\n›]/.test(part) || part.trim() !== part))
					throw new Error(
						"A test title cannot be represented by Playwright --test-list",
					);
				rows.push({
					// JSON groups one spec across projects; its single opaque id
					// can change when selection removes the first project. The
					// qualified path is the public CLI's stable test identity.
					identity: JSON.stringify([test.projectId, ...parts]),
					selector: `[${test.projectName}] › ${parts.join(" › ")}`,
				});
			}
		}
		for (const child of suite.suites ?? [])
			visit(child, [...titles, child.title]);
	}
	for (const suite of report.suites) visit(suite, []);
	if (!rows.length)
		throw new Error(
			"Playwright discovery must contain nonempty test identities",
		);
	return [...new Map(rows.map((row) => [row.identity, row])).values()];
}

export function partitionTests(
	report: JSONReport,
	partition: string,
	timings: Record<string, number> = durationsMs,
) {
	const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(partition);
	if (!match)
		throw new Error("Smoke partition must be current/total, for example 2/5");
	const current = Number(match[1]);
	const total = Number(match[2]);
	const rows = discoveredTests(report);
	if (current > total || total > rows.length)
		throw new Error("Smoke partition would be invalid or empty");
	// Long full-app journeys dominate file/count-based shards. Assign the
	// longest measured tests first, then preserve declaration order within a
	// job. Timings affect placement only: new tests always enter discovery.
	const ranked = rows
		.map((row, index) => {
			const cost = timings[row.selector] ?? 5_000;
			if (!Number.isFinite(cost) || cost <= 0)
				throw new Error(`Invalid smoke timing for ${row.selector}`);
			return { index, cost };
		})
		.sort((a, b) => b.cost - a.cost || a.index - b.index);
	const loads = Array<number>(total).fill(0);
	const assignments = new Map<number, number>();
	for (const { index, cost } of ranked) {
		let slot = 0;
		for (let candidate = 1; candidate < total; candidate++)
			if (loads[candidate] < loads[slot]) slot = candidate;
		assignments.set(index, slot);
		loads[slot] += cost;
	}
	return rows.filter((_, index) => assignments.get(index) === current - 1);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const [mode, manifest, partition, output] = process.argv.slice(2);
	if (!manifest || !partition || !output || !["write", "verify"].includes(mode))
		throw new Error(
			"Usage: smoke-partition.ts write|verify discovery.json current/total list.txt|selected.json",
		);
	const selected = partitionTests(
		JSON.parse(readFileSync(manifest, "utf8")),
		partition,
	);
	if (mode === "write") {
		writeFileSync(
			output,
			`${selected.map((row) => row.selector).join("\n")}\n`,
		);
		console.log(
			`[smoke] partition ${partition}: ${selected.length} native test identities`,
		);
	} else {
		// The installed Playwright parser must select exactly our partition.
		// This catches title-prefix collisions and future CLI/schema changes
		// before seeding or running, rather than silently losing coverage.
		const actual = discoveredTests(JSON.parse(readFileSync(output, "utf8")));
		const expectedIds = new Set(selected.map((row) => row.identity));
		if (
			actual.length !== selected.length ||
			actual.some((row) => !expectedIds.has(row.identity))
		)
			throw new Error(
				"Native Playwright selection does not match the complete smoke partition",
			);
	}
}
