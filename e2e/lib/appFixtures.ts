import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test as base, expect } from "./fixtures";
import { scenarioAttemptKey } from "./scenarioSeeds";
import { profileFromTags, type SmokeScenario } from "./smokeProfiles";

export { seedFor } from "./smokeProfiles";
export { expect };

export const test = base.extend<{
	scenario: SmokeScenario;
	smokeActor: "owner" | "viewer";
}>({
	smokeActor: ["owner", { option: true }],
	scenario: async ({ baseURL }, use, info) => {
		const key = scenarioAttemptKey(info);
		const scenarios = JSON.parse(
			readFileSync(resolve("e2e/.auth/scenarios.json"), "utf8"),
		) as Record<string, SmokeScenario>;
		const scenario = scenarios[key];
		if (
			!scenario ||
			scenario.common.baseUrl !== baseURL ||
			scenario.profile !== profileFromTags(info.tags)
		) {
			throw new Error(
				`Missing exact smoke fixture for ${key}. Run npm run test:smoke with this selection.`,
			);
		}
		await use(scenario);
	},
	storageState: async ({ scenario, smokeActor }, use) => {
		await use(
			smokeActor === "viewer"
				? scenario.common.viewerStorageState
				: scenario.common.storageState,
		);
	},
});
