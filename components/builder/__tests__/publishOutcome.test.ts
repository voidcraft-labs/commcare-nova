/**
 * What a publish response means.
 *
 * The first version of this decision branched on `success` alone and threw
 * away the record a refused publish answers with, so the phase that
 * stopped and the state a retry resumes from never reached the screen. A
 * browser audit caught it; these cases are what stop it coming back.
 */

import { describe, expect, it } from "vitest";
import {
	APP_PREVIEW_NOTE,
	HQ_CHANGED_MESSAGE,
} from "@/lib/deployment/remoteChanges";
import type {
	DeploymentConfirmationNeeded,
	DeploymentRecord,
} from "@/lib/deployment/types";
import {
	FLAT_LOCATION_FIXTURE,
	PLAN_FEATURES,
} from "@/lib/publish/planFeatures";
import { type PublishResponseBody, publishOutcome } from "../publishOutcome";

const RECORD: DeploymentRecord = {
	id: "dep-1",
	appId: "app-1",
	projectId: "proj-1",
	server: "production",
	domain: "acme",
	state: "uploaded",
	resumePhase: null,
	phases: {
		preflight: null,
		resources: null,
		upload: null,
		build: null,
		release: null,
		probe: null,
	},
	createdBy: "u1",
	createdAt: "2026-08-06T00:00:00.000Z",
	updatedAt: "2026-08-06T00:00:00.000Z",
	lastObservedAt: null,
	offeredLogoContentHash: null,
	targetEmptyCaseListText: null,
};
const VIEW: NonNullable<PublishResponseBody["deployment"]> = {
	deployment: RECORD,
	active: [],
	superseded: [],
	confirmations: [],
};
const ARTIFACT: NonNullable<PublishResponseBody["setup_artifact"]> = {
	server: "production",
	domain: "acme",
	hqAppId: "hq-1",
	sections: [],
};
const REFUSAL = {
	phase: "preflight" as const,
	failure: {
		code: "hq_not_connected" as const,
		message: "CommCare HQ isn't connected yet.",
		details: [],
	},
	resourceConflicts: [],
	remoteChanges: [],
	confirmationsNeeded: [],
	webAppsChange: null,
};

describe("a publish that landed", () => {
	it("carries the record, the url, and what Preview may name", () => {
		const outcome = publishOutcome(true, {
			success: true,
			url: "https://hq/app",
			warnings: ["media still processing"],
			deployment: VIEW,
			setup_artifact: ARTIFACT,
			preview_project_space: "acme",
		});
		expect(outcome).toStrictEqual({
			kind: "landed",
			deployment: { deployment: VIEW, artifact: ARTIFACT, leftBehind: [] },
			hqAppAction: null,
			appUrl: "https://hq/app",
			warnings: ["media still processing"],
			previewProjectSpace: "acme",
			appPreviewNote: null,
			logoStep: null,
		});
	});

	it("carries the logo step the publish offers, and none for an app with no logo", () => {
		const logoStep = {
			assetId: "asset-1",
			fileName: "logo.png",
			changed: true,
		};
		expect(
			publishOutcome(true, { success: true, logo_step: logoStep }),
		).toMatchObject({ kind: "landed", logoStep });
		expect(
			publishOutcome(true, { success: true, logo_step: null }),
		).toMatchObject({ kind: "landed", logoStep: null });
	});

	it("carries the App Preview line when the server sent it, and none otherwise", () => {
		// The server alone knows whether this publish wrote over the app
		// without knowing it unchanged (a confirmed change, or the cutover's
		// read), so the client shows exactly what it was told.
		const note = APP_PREVIEW_NOTE;
		expect(
			publishOutcome(true, { success: true, app_preview_note: note }),
		).toMatchObject({ kind: "landed", appPreviewNote: note });
		expect(
			publishOutcome(true, { success: true, app_preview_note: null }),
		).toMatchObject({ kind: "landed", appPreviewNote: null });
	});

	it("is still a success when the response carried no record", () => {
		// `success` is the authority on whether the app reached the project
		// space; the record only explains it. Treating a missing record as a
		// failure would report a working upload as broken.
		const outcome = publishOutcome(true, {
			success: true,
			url: "https://hq/a",
		});
		expect(outcome).toMatchObject({ kind: "landed", deployment: null });
	});

	it("says whether the app was updated in place or created fresh", () => {
		const outcome = publishOutcome(true, {
			success: true,
			hq_app_action: "updated",
			url: "https://hq/app",
			deployment: VIEW,
			setup_artifact: ARTIFACT,
			preview_project_space: "acme",
		});
		expect(outcome).toMatchObject({ kind: "landed", hqAppAction: "updated" });
	});

	it("carries a null action when the response left it unanswered", () => {
		// The hero then falls back to the action-neutral title rather than
		// claiming a create or an update the server never reported.
		const outcome = publishOutcome(true, { success: true });
		expect(outcome).toMatchObject({ kind: "landed", hqAppAction: null });
	});
});

describe("a publish that was refused", () => {
	it("preserves exact resource identities so takeover can name the refused remote resource", () => {
		const conflict = {
			kind: "lookup-table" as const,
			novaResourceId: "table-1",
			name: "Clinics",
			identity: "clinics",
			remoteId: "remote-9",
		};
		expect(
			publishOutcome(true, {
				refusal: { ...REFUSAL, resourceConflicts: [conflict] },
				warnings: ["Review target"],
			}),
		).toStrictEqual({
			kind: "refused",
			deployment: null,
			refusal: {
				code: "hq_not_connected",
				message: REFUSAL.failure.message,
				items: [],
			},
			hqAppUrl: null,
			resourceConflicts: [conflict],
			remoteChanges: [],
			confirmationsNeeded: [],
			webAppsChange: null,
			warnings: ["Review target"],
			previewProjectSpace: null,
		});
	});

	it("carries the Web Apps question from the refusal, and none where it carries none", () => {
		const change = { from: false, to: true, changedInHq: true };
		expect(
			publishOutcome(true, {
				success: false,
				refusal: {
					...REFUSAL,
					failure: {
						code: "hq_web_apps_change",
						message: "Publishing turns Web Apps on.",
						details: [],
					},
					webAppsChange: change,
				},
			}),
		).toMatchObject({
			kind: "refused",
			refusal: { code: "hq_web_apps_change" },
			webAppsChange: change,
		});
		/* A server from before the question carries no field: no question. */
		const { webAppsChange: _, ...older } = REFUSAL;
		expect(
			publishOutcome(true, {
				success: false,
				refusal: older as typeof REFUSAL,
			}),
		).toMatchObject({ kind: "refused", webAppsChange: null });
	});

	it("preserves each change in CommCare HQ with the state it was read in, so publishing over it can name that state back", () => {
		const change = {
			kind: "app" as const,
			novaResourceId: "app-1",
			name: "Clinic visits",
			identity: "hq-1",
			parts: ["The menu Patients"],
			note: null,
			observedDigest: "digest-shown",
			baselineKnown: true,
		};
		const outcome = publishOutcome(true, {
			success: false,
			refusal: {
				phase: "preflight",
				failure: {
					code: "hq_changed",
					message: HQ_CHANGED_MESSAGE,
					details: ["Clinic visits"],
				},
				resourceConflicts: [],
				remoteChanges: [change],
				confirmationsNeeded: [],
				webAppsChange: null,
			},
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			refusal: { message: HQ_CHANGED_MESSAGE, items: ["Clinic visits"] },
			resourceConflicts: [],
			remoteChanges: [change],
		});
	});
	it("does not synthesize setup instructions when the response has a record alone", () => {
		const outcome = publishOutcome(true, { success: true, deployment: VIEW });
		expect(outcome.kind).toBe("landed");
		if (outcome.kind !== "landed") throw new Error("Expected landed publish");
		expect(outcome.deployment).toBeNull();
	});
	it("carries the refusal beside whatever record the target has", () => {
		const outcome = publishOutcome(true, {
			success: false,
			refusal: REFUSAL,
			deployment: {
				...VIEW,
				deployment: { ...RECORD, state: "runnable" },
			},
			setup_artifact: ARTIFACT,
			preview_project_space: "acme",
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			refusal: {
				message: "CommCare HQ isn't connected yet.",
				items: [],
			},
			previewProjectSpace: "acme",
		});
		expect(outcome.kind).toBe("refused");
		if (outcome.kind !== "refused") throw new Error("Expected refused publish");
		expect(outcome.deployment).toStrictEqual({
			deployment: { ...VIEW, deployment: { ...RECORD, state: "runnable" } },
			artifact: ARTIFACT,
			leftBehind: [],
		});
		expect(outcome.resourceConflicts).toStrictEqual([]);
	});

	it("carries the boundary findings so the author sees what to fix", () => {
		const outcome = publishOutcome(true, {
			success: false,
			refusal: {
				phase: "preflight",
				failure: {
					code: "app_not_ready",
					message: "This app isn't ready to publish yet.",
					details: ["Give the module a case list column."],
				},
				resourceConflicts: [],
				remoteChanges: [],
				confirmationsNeeded: [],
				webAppsChange: null,
			},
			preview_project_space: null,
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			refusal: {
				message: "This app isn't ready to publish yet.",
				items: ["Give the module a case list column."],
			},
		});
	});

	it("preserves what the person has to confirm about the project space, so ticking each one can name it back", () => {
		const needed: DeploymentConfirmationNeeded[] = [
			{
				kind: "plan-feature",
				subject: "lookup-tables",
				label: PLAN_FEATURES["lookup-tables"].label,
				plans: PLAN_FEATURES["lookup-tables"].plans,
				consequence: PLAN_FEATURES["lookup-tables"].consequence,
				reasons: ["The app reads data from a lookup table."],
				whereMissing: null,
			},
			{
				kind: "flat-location-fixture",
				subject: "flat-location-fixture",
				label: FLAT_LOCATION_FIXTURE.label,
				plans: "",
				consequence: FLAT_LOCATION_FIXTURE.consequence,
				reasons: [
					"Intake sets a case's owner from a place in your organization.",
				],
				whereMissing: FLAT_LOCATION_FIXTURE.whereMissing,
			},
		];
		const outcome = publishOutcome(true, {
			success: false,
			refusal: {
				...REFUSAL,
				failure: {
					code: "hq_confirmation_needed",
					message: "Confirm what the project space has.",
					details: [],
				},
				confirmationsNeeded: needed,
			},
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			refusal: { code: "hq_confirmation_needed" },
			confirmationsNeeded: needed,
		});
	});

	it("carries the HQ app's address with the version floor's stop, so the person can raise the version there", () => {
		const failure = {
			code: "hq_app_version_below_floor" as const,
			message:
				"The app on “acme” is set to CommCare 2.53.0, and Nova's apps need 2.57 or later.",
			details: [],
		};
		const outcome = publishOutcome(true, {
			success: false,
			refusal: { ...REFUSAL, failure },
			url: "https://www.commcarehq.org/a/acme/apps/view/hq-1/",
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			refusal: { code: "hq_app_version_below_floor", message: failure.message },
			hqAppUrl: "https://www.commcarehq.org/a/acme/apps/view/hq-1/",
		});
	});

	it("carries no record for a target the app never reached", () => {
		const outcome = publishOutcome(true, {
			success: false,
			refusal: REFUSAL,
			deployment: null,
			setup_artifact: ARTIFACT,
			preview_project_space: null,
		});
		expect(outcome.kind).toBe("refused");
		expect(
			outcome.kind === "refused" ? outcome.deployment : "wrong",
		).toBeNull();
	});
});

describe("nothing to show", () => {
	it("falls to a failure when a refusal arrived without a refusal report", () => {
		expect(publishOutcome(true, { success: false }).kind).toBe("failure");
	});

	it("falls to a failure on a non-2xx, record or not", () => {
		expect(
			publishOutcome(false, {
				success: true,
				deployment: VIEW,
				setup_artifact: ARTIFACT,
			}).kind,
		).toBe("failure");
	});

	it("names the blocked preflight edge when the response identified one", () => {
		const outcome = publishOutcome(true, {
			success: false,
			preflight: [
				{ title: "Feature flags", status: "attention", detail: "flags" },
				{
					title: "App readiness",
					status: "blocked",
					detail: "This app isn't ready to publish yet.",
				},
			],
		});
		expect(outcome).toEqual({
			kind: "failure",
			blockedDetail: "This app isn't ready to publish yet.",
		});
	});

	it("has no blocked detail to offer when nothing was blocked", () => {
		expect(publishOutcome(true, { success: false })).toEqual({
			kind: "failure",
			blockedDetail: undefined,
		});
	});
});
