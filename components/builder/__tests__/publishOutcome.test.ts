/**
 * What a publish response means.
 *
 * The first version of this decision branched on `success` alone and threw
 * away the record a refused publish answers with, so the phase that
 * stopped and the state a retry resumes from never reached the screen. A
 * browser audit caught it; these cases are what stop it coming back.
 */

import { describe, expect, it } from "vitest";
import type { DeploymentRecord } from "@/lib/deployment/types";
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
};
const VIEW: NonNullable<PublishResponseBody["deployment"]> = {
	deployment: RECORD,
	active: [],
	superseded: [],
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
		});
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
			refusal: { message: REFUSAL.failure.message, items: [] },
			resourceConflicts: [conflict],
			warnings: ["Review target"],
			previewProjectSpace: null,
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
