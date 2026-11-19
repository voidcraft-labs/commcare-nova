import { describe, expect, it } from "vitest";
import {
	confirmationLabel,
	PLAN_FEATURES,
	PROJECT_SPACE_SETTINGS,
	workerLevelConfirmationLabel,
} from "@/lib/publish/planFeatures";

/* The app's levels as a project space whose places CommCare HQ manages gives
 * them: one whose code is its name, one whose code CommCare HQ spells apart. */
const LEVELS = [
	{ code: "Region", name: "Region" },
	{ code: "District_Level", name: "District" },
];

describe("what a worker-level confirmation is called", () => {
	it("names the level as the Workers panel asked, by its name, with CommCare HQ's code beside it where the two differ", () => {
		expect(workerLevelConfirmationLabel("District_Level", LEVELS)).toBe(
			"Places at the level “District” (code “District_Level”) take workers",
		);
		expect(workerLevelConfirmationLabel("Region", LEVELS)).toBe(
			"Places at the level “Region” take workers",
		);
	});

	it("matches the code exactly, as CommCare HQ keys a level", () => {
		expect(workerLevelConfirmationLabel("district_level", LEVELS)).toBe(
			"Places at the level with code “district_level” take workers (the level is no longer in the organization)",
		);
	});

	it("says a code no level holds now is a level no longer in the organization", () => {
		expect(workerLevelConfirmationLabel("Block", LEVELS)).toBe(
			"Places at the level with code “Block” take workers (the level is no longer in the organization)",
		);
		expect(workerLevelConfirmationLabel("Block", [])).toBe(
			"Places at the level with code “Block” take workers (the level is no longer in the organization)",
		);
	});

	it("names the code alone where the levels could not be read, claiming nothing about them", () => {
		expect(workerLevelConfirmationLabel("District_Level", "unread")).toBe(
			"Places at the level with code “District_Level” take workers",
		);
	});
});

describe("what a confirmation on record is called", () => {
	it("reads every kind through its own row's words, and a worker level through the levels", () => {
		expect(
			confirmationLabel(
				{ kind: "plan-feature", subject: "lookup-tables" },
				LEVELS,
			),
		).toBe(PLAN_FEATURES["lookup-tables"].label);
		expect(
			confirmationLabel(
				{ kind: "plan-feature", subject: "retired-feature" },
				LEVELS,
			),
		).toBe("retired-feature");
		expect(
			confirmationLabel(
				{ kind: "commtrack-off", subject: "commtrack-off" },
				LEVELS,
			),
		).toBe(PROJECT_SPACE_SETTINGS["commtrack-off"].label);
		expect(
			confirmationLabel(
				{ kind: "worker-level", subject: "District_Level" },
				LEVELS,
			),
		).toBe(workerLevelConfirmationLabel("District_Level", LEVELS));
	});
});
