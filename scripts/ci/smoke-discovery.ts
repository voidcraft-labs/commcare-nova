import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	discoveredSmokeScenarios,
	readDiscoveryReport,
} from "../../e2e/lib/scenarioSeeds";
import { discoveredTests } from "./smoke-partition";

const [manifest, directory] = process.argv.slice(2);
if (!manifest || !directory)
	throw new Error("Usage: smoke-discovery.ts manifest directory");
const report = readDiscoveryReport(manifest);
const lane = process.env.SMOKE_LANE;
/** The projects the browser lane runs: Chromium's, and WebKit's for media playback. */
const BROWSER_LANE_PROJECTS: ReadonlySet<string> = new Set([
	"browser",
	"browser-webkit",
]);
if (
	lane &&
	report.attempts.some(
		(test) =>
			BROWSER_LANE_PROJECTS.has(test.projectId) !== (lane === "browser"),
	)
)
	throw new Error(
		`The native selection includes tests outside SMOKE_LANE=${lane}`,
	);
const tests = report.attempts.length ? discoveredTests(report) : [];
discoveredSmokeScenarios(report);
for (const lane of ["browser", "app"] as const) {
	const selected = tests.filter(
		(test) =>
			[...BROWSER_LANE_PROJECTS].some((project) =>
				test.selector.startsWith(`[${project}]`),
			) ===
			(lane === "browser"),
	);
	if (selected.length)
		writeFileSync(
			resolve(directory, `${lane}.txt`),
			`${selected.map((test) => test.selector).join("\n")}\n`,
		);
}
