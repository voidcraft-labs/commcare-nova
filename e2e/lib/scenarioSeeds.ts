import { readFileSync } from "node:fs";
import type { JSONReport } from "@playwright/test/reporter";
import { profileFromTags } from "./smokeProfiles";
import type { SmokeProfile } from "./smokeSeedFactory";

/** Playwright's discovery report is the authority for selected scenario IDs,
 * repeats and retry limits. Fixtures are allocated before the app server starts. */
export interface DiscoveryReport extends JSONReport {
	attempts: NativeAttempt[];
}

export interface NativeAttempt {
	testId: string;
	projectId: string;
	file: string;
	tags: string[];
	repeatEachIndex: number;
	retries: number;
}

export function readDiscoveryReport(file: string): DiscoveryReport {
	return {
		...JSON.parse(readFileSync(file, "utf8")),
		attempts: JSON.parse(readFileSync(`${file}.attempts.json`, "utf8")),
	};
}

/** Public TestCase identities include the selected repeat and per-test retries. */
export function discoveredSmokeScenarios(
	report: DiscoveryReport,
): { key: string; profile: SmokeProfile }[] {
	const requests = new Map<string, SmokeProfile>();
	for (const test of report.attempts) {
		if (test.projectId !== "authed") continue;
		const profile = profileFromTags(test.tags);
		for (let retry = 0; retry <= test.retries; retry++) {
			const key = scenarioAttemptKey({ ...test, retry });
			if (requests.has(key))
				throw new Error(`Duplicate smoke fixture identity: ${key}`);
			requests.set(key, profile);
		}
	}
	return [...requests].map(([key, profile]) => ({ key, profile }));
}
export function scenarioAttemptKey(info: {
	testId: string;
	repeatEachIndex: number;
	retry: number;
}): string {
	return `${info.testId}:${info.repeatEachIndex}:${info.retry}`;
}

export function selectedDiscoveryProjects(
	report: DiscoveryReport,
): Set<string> {
	return new Set(report.attempts.map((test) => test.projectId));
}

export function discoveredScenarioAttempts(
	kind: "react-profile" | "multiplayer",
): string[] {
	const file = process.env.NOVA_E2E_DISCOVERY_MANIFEST;
	if (!file) return [];
	const report = readDiscoveryReport(file);
	const keys = new Set<string>();
	for (const test of report.attempts) {
		const selected =
			kind === "multiplayer"
				? test.projectId === "multiplayer"
				: test.projectId === "react-profile" &&
					/builder-(load|scale)\.spec\.ts$/.test(test.file);
		if (!selected) continue;
		for (let retry = 0; retry <= test.retries; retry++)
			keys.add(scenarioAttemptKey({ ...test, retry }));
	}
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
