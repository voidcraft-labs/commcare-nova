import { readFileSync } from "node:fs";

/** Playwright's discovery report is the authority for selected scenario IDs,
 * repeats and retry limits. Fixtures are allocated before the app server starts. */
interface DiscoveryReport {
	config: { projects: { id: string; repeatEach: number; retries: number }[] };
	suites: DiscoverySuite[];
}
interface DiscoverySuite {
	suites?: DiscoverySuite[];
	specs?: {
		id: string;
		file: string;
		tags: string[];
		tests: { projectId: string }[];
	}[];
}

export function scenarioAttemptKey(info: {
	testId: string;
	repeatEachIndex: number;
	retry: number;
}): string {
	return `${info.testId}:${info.repeatEachIndex}:${info.retry}`;
}

export function discoveredScenarioAttempts(
	kind: "case-workspace" | "case-changes" | "react-profile" | "multiplayer",
): string[] {
	const file = process.env.NOVA_E2E_DISCOVERY_MANIFEST;
	if (!file) return [];
	const report = JSON.parse(readFileSync(file, "utf8")) as DiscoveryReport;
	const keys = new Set<string>();
	const visit = (suite: DiscoverySuite) => {
		for (const spec of suite.specs ?? []) {
			const selected =
				kind !== "react-profile"
					? spec.tags.some((tag) => tag.replace(/^@/, "") === kind)
					: /builder-(load|scale)\.spec\.ts$/.test(spec.file);
			if (!selected) continue;
			for (const test of spec.tests) {
				const project = report.config.projects.find(
					(item) => item.id === test.projectId,
				);
				if (!project)
					throw new Error(`Discovery project missing: ${test.projectId}`);
				for (
					let repeatEachIndex = 0;
					repeatEachIndex < project.repeatEach;
					repeatEachIndex++
				) {
					for (let retry = 0; retry <= project.retries; retry++) {
						keys.add(
							scenarioAttemptKey({ testId: spec.id, repeatEachIndex, retry }),
						);
					}
				}
			}
		}
		for (const child of suite.suites ?? []) visit(child);
	};
	for (const suite of report.suites) visit(suite);
	return [...keys];
}

export function requireScenarioSeed<T>(
	seeds: Record<string, T> | undefined,
	info: {
		testId: string;
		repeatEachIndex: number;
		retry: number;
	},
): T {
	const key = scenarioAttemptKey(info);
	const fixture = seeds?.[key];
	if (!fixture)
		throw new Error(
			`Isolated scenario fixture missing for ${key}. Run the owning smoke or profiling harness to seed the selected tests.`,
		);
	return fixture;
}
