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
import { nextPublishAction } from "@/lib/deployment/resources";
import type {
	DeploymentConfirmationNeeded,
	DeploymentRecord,
} from "@/lib/deployment/types";
import { ANOTHER_SPACE_NEW_APP_LINE } from "@/lib/publish/bringInCopy";
import {
	type PlacementMoveOfferView,
	SAME_TYPE_CHILD_LINKS_OFFER_HEADING,
	SAVE_TO_CASE_OFFER_HEADING,
	sameTypeChildLinksOfferBody,
	saveToCaseOfferBody,
} from "@/lib/publish/placementMoves";
import {
	FLAT_LOCATION_FIXTURE,
	PLAN_FEATURES,
} from "@/lib/publish/planFeatures";
import {
	type ProjectSpaceCapabilityState,
	projectSpaceCapabilityUse,
	projectSpaceCompatibilityForTarget,
} from "@/lib/publish/projectSpaceCompatibility";
import { PUBLISH_PLAN_CREATES_BESIDE } from "@/lib/publish/stopPublishing";
import {
	acceptsOffer,
	confirmationsStillAsked,
	type PublishAnswers,
	type PublishPlan,
	type PublishResponseBody,
	placementOfferCopy,
	publishedViewToHold,
	publishOutcome,
	publishPlanCopy,
	refusalOpensHqApp,
	withAcceptedMoves,
	withConfirmation,
} from "../publishOutcome";

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
	endings: 0,
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
	placementMoves: null,
};

/** An `app` mapping as a server that predates mapping endings serves it: no
 *  `adoptedByName`, `releasedAt`, `endedReason`, `endedByName` or
 *  `heldByAnotherApp`. */
function olderAppMapping(remoteId: string, supersededAt: string | null) {
	return {
		deploymentId: "dep-1",
		kind: "app" as const,
		novaResourceId: "app-1",
		remoteId,
		ownership: "nova-created" as const,
		pushedIdentity: null,
		adoptedAt: null,
		adoptedBy: null,
		pushedRevision: 3,
		pushedAt: "2026-08-06T00:00:00.000Z",
		pushToken: `push-${remoteId}`,
		remoteRevision: 4,
		remoteObservedAt: null,
		supersededAt,
		remoteMissingAt: null,
	};
}

describe("a record from a server that predates mapping endings", () => {
	const { endings: _, ...olderRecord } = RECORD;

	it("reads the app it just updated as one the next publish updates", () => {
		const outcome = publishOutcome(true, {
			success: true,
			hq_app_action: "updated",
			deployment: {
				deployment: olderRecord,
				active: [olderAppMapping("hq-1", null)],
				superseded: [],
				confirmations: [],
			},
			setup_artifact: ARTIFACT,
		});
		if (outcome.kind !== "landed" || outcome.deployment === null)
			throw new Error("The publish landed with its record.");
		const record = outcome.deployment.deployment;
		expect(record.deployment.endings).toBe(0);
		expect(record.active[0]).toMatchObject({
			adoptedByName: null,
			releasedAt: null,
			endedReason: null,
			endedByName: null,
			heldByAnotherApp: false,
		});
		expect(nextPublishAction(record)).toBe("updates");
	});

	it("reads an app a later publish replaced as replaced, not ended", () => {
		const outcome = publishOutcome(true, {
			success: false,
			refusal: REFUSAL,
			deployment: {
				deployment: olderRecord,
				active: [],
				superseded: [olderAppMapping("hq-0", "2026-08-05T00:00:00.000Z")],
				confirmations: [],
			},
			setup_artifact: ARTIFACT,
		});
		if (outcome.kind !== "refused" || outcome.deployment === null)
			throw new Error("The refusal carried its record.");
		expect(nextPublishAction(outcome.deployment.deployment)).toBe("creates");
	});
});

describe("a publish that landed", () => {
	it("carries what the project space keeps of the settings Preview plays, and none where the response holds none", () => {
		const facts = { fuzzyListSearch: true, markRequiredQuestions: true };
		const body = {
			success: true,
			url: "https://hq/app",
			deployment: VIEW,
			setup_artifact: ARTIFACT,
			preview_project_space: "acme",
		};
		expect(
			publishOutcome(true, { ...body, preview_target_facts: facts }),
		).toMatchObject({
			kind: "landed",
			preview: { projectSpace: "acme", targetFacts: facts },
		});
		expect(
			publishOutcome(true, { ...body, preview_target_facts: null }),
		).toMatchObject({
			kind: "landed",
			preview: { projectSpace: "acme", targetFacts: null },
		});
		/* One half alone reads the other as null: Preview plays a new project space. */
		expect(publishOutcome(true, body)).toMatchObject({
			kind: "landed",
			preview: { projectSpace: "acme", targetFacts: null },
		});
	});

	it("carries no Preview answer where the response holds neither half, so the tab keeps what it holds", () => {
		const landed = publishOutcome(true, {
			success: true,
			url: "https://hq/app",
			deployment: VIEW,
			setup_artifact: ARTIFACT,
		});
		expect(landed).toMatchObject({ kind: "landed", preview: null });
		const refused = publishOutcome(true, { success: false, refusal: REFUSAL });
		expect(refused).toMatchObject({ kind: "refused", preview: null });
	});

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
			deployment: {
				deployment: VIEW,
				artifact: ARTIFACT,
				leftBehind: [],
				kept: "unread",
				firstPublish: "unread",
			},
			hqAppAction: null,
			appUrl: "https://hq/app",
			warnings: ["media still processing"],
			preview: { projectSpace: "acme", targetFacts: null },
			appPreviewNote: null,
			logoStep: null,
			placements: { recorded: 0, moved: 0 },
		});
	});

	it("carries the kept list the publish left on the landed record, and none where the response holds none", () => {
		const kept = {
			labels: ["fuzzy-search", "required-question-asterisk"] as const,
			valuesDigest: "a".repeat(64),
			observedAt: "2026-11-01T09:00:00.000Z",
		};
		const body = {
			success: true,
			url: "https://hq/app",
			deployment: VIEW,
			setup_artifact: ARTIFACT,
		};
		const landed = publishOutcome(true, { ...body, kept });
		if (landed.kind !== "landed") throw new Error("Expected a landed publish");
		expect(landed.deployment?.kept).toStrictEqual(kept);
		/* An explicit null is no kept list, which draws nothing. */
		const none = publishOutcome(true, { ...body, kept: null });
		if (none.kind !== "landed") throw new Error("Expected a landed publish");
		expect(none.deployment?.kept).toBeNull();
		/* Absent is a list the server could not read after the write. */
		const absent = publishOutcome(true, body);
		if (absent.kind !== "landed") throw new Error("Expected a landed publish");
		expect(absent.deployment?.kept).toBe("unread");
	});

	// Contract: a list the response leaves out keeps the list the dialog holds
	// for that target, and an explicit null ends it. The failure it catches: a
	// refused first publish whose list read faulted wiping the first-publish
	// list from the dialog, so the retry goes ahead without it.
	it("keeps the held record's lists where the response left them out, and ends one the response says is gone", () => {
		const firstPublish = {
			ids: ["forms-and-settings-rewritten"] as const,
			touchesWorkers: false,
			of: "first-publish",
		} as const;
		const kept = {
			labels: ["fuzzy-search"] as const,
			valuesDigest: "b".repeat(64),
			observedAt: "2026-11-01T09:00:00.000Z",
		};
		const body = {
			success: false,
			refusal: REFUSAL,
			deployment: VIEW,
			setup_artifact: ARTIFACT,
		};
		/** The record a refused publish answers with. */
		const recordOf = (response: PublishResponseBody) => {
			const outcome = publishOutcome(true, response);
			if (outcome.kind !== "refused" || outcome.deployment === null)
				throw new Error("Expected a refused publish with its record");
			return outcome.deployment;
		};
		const heldView = publishedViewToHold(
			[],
			recordOf({ ...body, kept, first_publish: firstPublish }),
		);
		expect(heldView.firstPublish).toStrictEqual(firstPublish);

		const faulted = recordOf(body);
		expect(publishedViewToHold([heldView], faulted)).toMatchObject({
			kept,
			firstPublish,
		});
		// Nothing held for the target: an unread list shows none.
		expect(publishedViewToHold([], faulted)).toMatchObject({
			kept: null,
			firstPublish: null,
		});

		const ended = recordOf({ ...body, kept: null, first_publish: null });
		expect(publishedViewToHold([heldView], ended)).toMatchObject({
			kept: null,
			firstPublish: null,
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
			placementMoves: null,
			placements: { recorded: 0, moved: 0 },
			warnings: ["Review target"],
			preview: null,
		});
	});

	it("carries the Web Apps question from the refusal, and none where it carries none", () => {
		const change = {
			from: false,
			to: true,
			changedInHq: true,
			since: { kind: "published" as const },
		};
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
			since: { kind: "published" as const },
			canBringIn: false,
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
				placementMoves: null,
			},
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			refusal: { message: HQ_CHANGED_MESSAGE, items: ["Clinic visits"] },
			resourceConflicts: [],
			remoteChanges: [change],
		});
	});
	it("reads a change and a Web Apps question from a server that names no reference as measured against the last publish", () => {
		const {
			since: _,
			canBringIn: __,
			...older
		} = {
			kind: "app" as const,
			novaResourceId: "app-1",
			name: "Clinic visits",
			identity: "hq-1",
			parts: ["The menu Patients"],
			note: null,
			observedDigest: "digest-shown",
			baselineKnown: true,
			since: { kind: "published" as const },
			canBringIn: false,
		};
		const outcome = publishOutcome(true, {
			success: false,
			refusal: {
				...REFUSAL,
				failure: {
					code: "hq_changed",
					message: HQ_CHANGED_MESSAGE,
					details: ["Clinic visits"],
				},
				remoteChanges: [older],
				webAppsChange: { from: false, to: true, changedInHq: true },
			},
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			remoteChanges: [
				{ ...older, since: { kind: "published" }, canBringIn: false },
			],
			webAppsChange: {
				from: false,
				to: true,
				changedInHq: true,
				since: { kind: "published" },
			},
		});
	});

	it("keeps the reference a change names: the day Nova brought the app in", () => {
		const since = {
			kind: "brought-in" as const,
			at: "2026-11-10T23:30:00.000Z",
		};
		const outcome = publishOutcome(true, {
			success: false,
			refusal: {
				...REFUSAL,
				failure: { code: "hq_changed", message: "Changed.", details: [] },
				remoteChanges: [
					{
						kind: "app",
						novaResourceId: "app-1",
						name: "Clinic visits",
						identity: "hq-1",
						parts: [],
						note: null,
						observedDigest: "digest-shown",
						baselineKnown: false,
						since,
						canBringIn: false,
					},
				],
			},
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			remoteChanges: [{ since }],
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
			preview_target_facts: {
				fuzzyListSearch: false,
				markRequiredQuestions: true,
			},
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			refusal: {
				message: "CommCare HQ isn't connected yet.",
				items: [],
			},
			preview: {
				projectSpace: "acme",
				targetFacts: {
					fuzzyListSearch: false,
					markRequiredQuestions: true,
				},
			},
		});
		expect(outcome.kind).toBe("refused");
		if (outcome.kind !== "refused") throw new Error("Expected refused publish");
		expect(outcome.deployment).toStrictEqual({
			deployment: { ...VIEW, deployment: { ...RECORD, state: "runnable" } },
			artifact: ARTIFACT,
			leftBehind: [],
			kept: "unread",
			firstPublish: "unread",
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
				placementMoves: null,
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

	it("keeps a build profile's lines and the HQ app's address with its stop, so the dialog draws both and the link", () => {
		const failure = {
			code: "hq_build_profile_language_missing" as const,
			message:
				"An application profile of the app on “acme” includes a language this app no longer has, so Nova stopped before sending anything.",
			details: ["“Mandarin”: Chinese (zho), the only language it has"],
		};
		const outcome = publishOutcome(true, {
			success: false,
			refusal: { ...REFUSAL, failure },
			url: "https://www.commcarehq.org/a/acme/apps/view/hq-1/",
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			refusal: {
				code: "hq_build_profile_language_missing",
				message: failure.message,
				items: failure.details,
			},
			hqAppUrl: "https://www.commcarehq.org/a/acme/apps/view/hq-1/",
		});
		expect(refusalOpensHqApp("hq_build_profile_language_missing")).toBe(true);
		expect(refusalOpensHqApp("hq_app_version_below_floor")).toBe(true);
		expect(refusalOpensHqApp("hq_app_state_unknown")).toBe(false);
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

const OFFER: PlacementMoveOfferView = {
	reason: "save-to-case",
	digest: "a".repeat(64),
	moves: [
		{
			form: "Register",
			change: "makes a new household case",
			sentence:
				"In Register, the change that makes a new household case moves from a Save to Case block to Case Management.",
		},
	],
	asksChildCases: false,
};
const SAVE_TO_CASE = {
	kind: "plan-feature" as const,
	subject: "advanced-case-actions" as const,
};
const LOOKUP_TABLES = {
	kind: "plan-feature" as const,
	subject: "lookup-tables" as const,
};

describe("where CommCare HQ keeps the case changes", () => {
	it("carries what a landed publish recorded, and nothing for a response that names none", () => {
		expect(
			publishOutcome(true, {
				success: true,
				placements: { recorded: 3, moved: 1 },
			}),
		).toMatchObject({ kind: "landed", placements: { recorded: 3, moved: 1 } });
		expect(publishOutcome(true, { success: true })).toMatchObject({
			kind: "landed",
			placements: { recorded: 0, moved: 0 },
		});
	});

	it("carries the move offer and what the attempt recorded on a refusal", () => {
		const outcome = publishOutcome(true, {
			success: false,
			placements: { recorded: 2, moved: 0 },
			refusal: {
				...REFUSAL,
				failure: {
					code: "hq_confirmation_needed",
					message: "Confirm what the project space has.",
					details: [],
				},
				placementMoves: OFFER,
			},
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			placementMoves: OFFER,
			placements: { recorded: 2, moved: 0 },
		});
	});

	it("offers no move where a refusal from an older server carries no field", () => {
		const { placementMoves: _, ...older } = REFUSAL;
		expect(
			publishOutcome(true, {
				success: false,
				refusal: older as typeof REFUSAL,
			}),
		).toMatchObject({
			kind: "refused",
			placementMoves: null,
			placements: { recorded: 0, moved: 0 },
		});
	});

	it("words the Save to Case offer with the Child Cases sentence only where a move asks for it", () => {
		expect(placementOfferCopy(OFFER, undefined)).toStrictEqual({
			heading: SAVE_TO_CASE_OFFER_HEADING,
			body: saveToCaseOfferBody(false),
		});
		expect(
			placementOfferCopy({ ...OFFER, asksChildCases: true }, undefined)?.body,
		).toBe(saveToCaseOfferBody(true));
	});

	it("words the same-type offer by what the refusal's report found for the link", () => {
		const sameType = { ...OFFER, reason: "same-type-child-links" as const };
		const reportWith = (
			state: Exclude<ProjectSpaceCapabilityState, "not_checked">,
		) =>
			projectSpaceCompatibilityForTarget(
				"acme",
				[
					{
						capability: projectSpaceCapabilityUse("same-type-child-links", [
							"Follow-up makes a visit case linked to the visit case it works on.",
						]),
						state,
					},
				],
				[],
			);
		expect(placementOfferCopy(sameType, reportWith("missing"))).toStrictEqual({
			heading: SAME_TYPE_CHILD_LINKS_OFFER_HEADING,
			body: sameTypeChildLinksOfferBody("missing"),
		});
		expect(sameTypeChildLinksOfferBody("missing")).toMatch(
			/^This project space drops the link/,
		);
		expect(
			placementOfferCopy(sameType, reportWith("unverified")),
		).toStrictEqual({
			heading: SAME_TYPE_CHILD_LINKS_OFFER_HEADING,
			body: sameTypeChildLinksOfferBody("unverified"),
		});
		expect(sameTypeChildLinksOfferBody("unverified")).toMatch(
			/^Nova couldn't check whether this project space keeps the link/,
		);
		/* Nothing true to say where the link is kept or the report is absent. */
		expect(placementOfferCopy(sameType, reportWith("available"))).toBeNull();
		expect(placementOfferCopy(sameType, undefined)).toBeNull();
	});
});

describe("answering the Save to Case question", () => {
	const none: PublishAnswers = { confirmations: [], acceptMoves: null };

	it("unticks the plan's Save to Case when the move is accepted, and keeps every other answer", () => {
		const answers = withAcceptedMoves(
			{ confirmations: [SAVE_TO_CASE, LOOKUP_TABLES], acceptMoves: null },
			OFFER,
			true,
		);
		expect(answers).toStrictEqual({
			confirmations: [LOOKUP_TABLES],
			acceptMoves: { reason: "save-to-case", digest: OFFER.digest },
		});
		expect(acceptsOffer(answers.acceptMoves, OFFER)).toBe(true);
	});

	it("drops the accepted move when the plan's Save to Case is ticked", () => {
		const accepted = withAcceptedMoves(none, OFFER, true);
		expect(withConfirmation(accepted, SAVE_TO_CASE, true)).toStrictEqual({
			confirmations: [SAVE_TO_CASE],
			acceptMoves: null,
		});
		/* Another confirmation leaves the move alone. */
		expect(withConfirmation(accepted, LOOKUP_TABLES, true)).toStrictEqual({
			confirmations: [LOOKUP_TABLES],
			acceptMoves: accepted.acceptMoves,
		});
	});

	it("unticking the move accepts nothing", () => {
		const accepted = withAcceptedMoves(none, OFFER, true);
		expect(withAcceptedMoves(accepted, OFFER, false)).toStrictEqual(none);
	});

	it("reads an accepted answer as this offer only while its digest matches", () => {
		const accepted = withAcceptedMoves(none, OFFER, true).acceptMoves;
		expect(acceptsOffer(accepted, { ...OFFER, digest: "b".repeat(64) })).toBe(
			false,
		);
		expect(acceptsOffer(null, OFFER)).toBe(false);
	});

	it("waits on Save to Case only while no move answers it", () => {
		const requests = [{ key: SAVE_TO_CASE }, { key: LOOKUP_TABLES }];
		expect(confirmationsStillAsked(requests, null)).toStrictEqual(requests);
		expect(
			confirmationsStillAsked(
				requests,
				withAcceptedMoves(none, OFFER, true).acceptMoves,
			),
		).toStrictEqual([{ key: LOOKUP_TABLES }]);
	});
});

describe("the plan line", () => {
	const elsewhere = { broughtInElsewhere: true };
	const here = { broughtInElsewhere: false };

	it("says a new app beside the stopped one whatever the app came from", () => {
		expect(publishPlanCopy("creates-beside", here)).toBe(
			PUBLISH_PLAN_CREATES_BESIDE,
		);
		expect(publishPlanCopy("creates-beside", elsewhere)).toBe(
			PUBLISH_PLAN_CREATES_BESIDE,
		);
	});

	it("tells a second project space of an app brought in from another one that it gets a new app beside the team's copy", () => {
		expect(publishPlanCopy("creates", elsewhere)).toBe(
			ANOTHER_SPACE_NEW_APP_LINE,
		);
		expect(publishPlanCopy("creates", here)).toBe(
			"This creates a new app in this project space.",
		);
	});

	it("keeps every other plan's line whatever the context", () => {
		const lines: Record<
			Exclude<PublishPlan, "creates" | "creates-beside">,
			string
		> = {
			updates: "This updates the app already in this project space.",
			"fills-shell":
				"Nova made an empty app here on an earlier try. Uploading fills it in.",
			unknown: "Nova checks this project space before sending the app.",
		};
		for (const [plan, line] of Object.entries(lines) as [
			keyof typeof lines,
			string,
		][]) {
			expect(publishPlanCopy(plan, here)).toBe(line);
			expect(publishPlanCopy(plan, elsewhere)).toBe(line);
		}
	});
});
