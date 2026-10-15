/**
 * Step `app-settings` over the frozen pre-step fixtures: each row and column
 * of its value table, from the deployments the plan classed and their
 * `profile.properties`, and the one line it writes for an app whose values
 * came from CommCare HQ.
 */

import { describe, expect, it } from "vitest";
import { readRawDocument } from "../oldShape";
import {
	type DeploymentOutcome,
	type StepDeployment,
	transformDocument,
} from "../transform";
import { readFixtureCarriers, readFixtureManifest } from "./fixtures/preStep";

const WITNESS = "navigation-base";

let nextDeployment = 0;
function deployment(
	outcome: DeploymentOutcome,
	profileProperties: Readonly<Record<string, unknown>> | null = {},
): StepDeployment {
	nextDeployment += 1;
	return {
		deploymentId: `00000000-0000-7000-8000-${String(nextDeployment).padStart(12, "0")}`,
		outcome,
		profileProperties,
	};
}

const holding = (saved: unknown, incomplete: unknown) => ({
	...(saved !== undefined && { "cc-show-saved": saved }),
	...(incomplete !== undefined && { "cc-show-incomplete": incomplete }),
});

function migrate(deployments: readonly StepDeployment[], id = WITNESS) {
	const result = transformDocument(
		readRawDocument(id, readFixtureCarriers(id)),
		{
			appId: id,
			projectId: "fixture-project",
			lookupColumnTypes: new Map(),
			deployments,
		},
	);
	return {
		appSettings: result.target.appSettings,
		changes:
			result.steps.find((step) => step.stepId === "app-settings")?.changes ??
			[],
		appName: result.target.appName,
	};
}

describe("step app-settings", () => {
	it("stores what a Nova archive shows today where no deployment was read, with no line", () => {
		for (const deployments of [
			[],
			[deployment("unreadable", null)],
			[deployment("deleted", null)],
			[deployment("unsupported", null)],
		]) {
			expect(migrate(deployments)).toMatchObject({
				appSettings: { showSavedForms: false, showIncompleteForms: true },
				changes: [],
			});
		}
	});

	it("leaves out a deployment it does not count, though its source carries a profile", () => {
		for (const outcome of ["deleted", "unsupported", "unreadable"] as const) {
			expect(
				migrate([
					deployment(outcome, holding("yes", "no")),
					deployment("read-in-full", holding("no", "no")),
				]).appSettings,
			).toEqual({ showSavedForms: false, showIncompleteForms: false });
		}
	});

	it("shows both lists where some deployment holds yes", () => {
		for (const outcome of ["read-in-full", "no-form-ids"] as const) {
			expect(
				migrate([deployment(outcome, holding("yes", "yes"))]).appSettings,
			).toEqual({ showSavedForms: true, showIncompleteForms: true });
		}
	});

	it("hides saved forms and shows incomplete forms where none holds yes and some holds no value or another value", () => {
		for (const profile of [
			{},
			holding("no", undefined),
			holding(null, null),
			holding("", ""),
			holding("no", "maybe"),
		]) {
			expect(
				migrate([deployment("read-in-full", profile)]).appSettings,
			).toEqual({ showSavedForms: false, showIncompleteForms: true });
		}
		expect(
			migrate([
				deployment("read-in-full", holding("no", "no")),
				deployment("no-form-ids", holding("no", undefined)),
			]).appSettings,
		).toEqual({ showSavedForms: false, showIncompleteForms: true });
	});

	it("hides both lists only where every read deployment holds no", () => {
		expect(
			migrate([
				deployment("read-in-full", holding("no", "no")),
				deployment("no-form-ids", holding("no", "no")),
			]).appSettings,
		).toEqual({ showSavedForms: false, showIncompleteForms: false });
	});

	it("keeps each list on where one deployment holds no and another yes", () => {
		expect(
			migrate([
				deployment("read-in-full", holding("no", "no")),
				deployment("read-in-full", holding("yes", "yes")),
			]).appSettings,
		).toEqual({ showSavedForms: true, showIncompleteForms: true });
	});

	it("tells an app whose values came from a read deployment both values, in one line", () => {
		const { changes, appName } = migrate([
			deployment("unreadable", null),
			deployment("no-form-ids", holding("no", "no")),
		]);
		expect(changes).toEqual([
			{
				reason: "android-form-lists-setting-stored",
				entity: { type: "app", nameAtMigration: appName },
				detail: { saved: "off", incomplete: "off" },
			},
		]);
		expect(
			migrate([deployment("read-in-full", holding("yes", "maybe"))]).changes,
		).toEqual([
			{
				reason: "android-form-lists-setting-stored",
				entity: { type: "app", nameAtMigration: appName },
				detail: { saved: "on", incomplete: "on" },
			},
		]);
	});

	it.each(readFixtureManifest().fixtures.map((fixture) => fixture.id))(
		"writes the settings of %s, which stores none before it",
		(id) => {
			expect(
				readRawDocument(id, readFixtureCarriers(id)).appSettings,
			).toBeUndefined();
			expect(migrate([], id).appSettings).toEqual({
				showSavedForms: false,
				showIncompleteForms: true,
			});
		},
	);
});
