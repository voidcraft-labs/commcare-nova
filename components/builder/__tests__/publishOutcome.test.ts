/**
 * What a publish response means.
 *
 * The first version of this decision branched on `success` alone and threw
 * away the record a refused publish answers with, so the phase that
 * stopped and the state a retry resumes from never reached the screen. A
 * browser audit caught it; these cases are what stop it coming back.
 */

import { describe, expect, it } from "vitest";
import { publishOutcome } from "../publishOutcome";

const RECORD = {
	id: "dep-1",
	appId: "app-1",
	projectId: "proj-1",
	server: "production",
	domain: "acme",
	state: "uploaded",
	resumePhase: null,
	phases: {
		preflight: null,
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
const VIEW = { deployment: RECORD, active: [], superseded: [] };
const ARTIFACT = {
	server: "production",
	domain: "acme",
	hqAppId: "hq-1",
	sections: [],
};

describe("a publish that landed", () => {
	it("carries the record and says the app got there", () => {
		const outcome = publishOutcome(true, {
			success: true,
			url: "https://hq/app",
			warnings: ["media still processing"],
			deployment: VIEW as never,
			setup_artifact: ARTIFACT as never,
		});
		expect(outcome).toMatchObject({
			kind: "record",
			landed: true,
			appUrl: "https://hq/app",
			warnings: ["media still processing"],
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
		expect(outcome).toMatchObject({ kind: "record", landed: true });
		expect((outcome as { deployment?: unknown }).deployment).toBeUndefined();
	});
});

describe("a publish that was refused", () => {
	it("is shown as a record, not as a failure box", () => {
		const outcome = publishOutcome(true, {
			success: false,
			deployment: {
				...VIEW,
				deployment: { ...RECORD, state: "incomplete", resumePhase: "probe" },
			} as never,
			setup_artifact: ARTIFACT as never,
		});
		expect(outcome.kind).toBe("record");
		expect((outcome as { landed: boolean }).landed).toBe(false);
	});

	it("never tells Preview the app is on that project space", () => {
		const outcome = publishOutcome(true, {
			success: false,
			deployment: VIEW as never,
			setup_artifact: ARTIFACT as never,
		});
		expect((outcome as { landed: boolean }).landed).toBe(false);
	});
});

describe("nothing to show", () => {
	it("falls to a failure when a refusal arrived without a record", () => {
		expect(publishOutcome(true, { success: false }).kind).toBe("failure");
	});

	it("falls to a failure on a non-2xx, record or not", () => {
		expect(
			publishOutcome(false, {
				success: true,
				deployment: VIEW as never,
				setup_artifact: ARTIFACT as never,
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
