/**
 * What a running form's Submit offers (`submitOffer.ts`), condition by
 * condition. The form screen renders this answer (Submit disabled with its
 * reason, or busy) and reads it again when a press lands, so a press that
 * does nothing only ever meets a Submit that says why.
 */
import { describe, expect, it } from "vitest";
import {
	type PreviewSubmitState,
	previewSubmitAccess,
	previewSubmitOffer,
} from "@/lib/preview/submitOffer";

const READY: PreviewSubmitState = {
	afterSubmitKnown: true,
	submitting: false,
	clearing: false,
	entry: "ready",
	caseDatabase: "ready",
	repeatSettling: false,
	caseBindingReady: true,
	access: "editor",
};

function offer(change: Partial<PreviewSubmitState>) {
	return previewSubmitOffer({ ...READY, ...change });
}

describe("previewSubmitOffer", () => {
	it("offers Submit once the entry, its data, its record and its access are ready", () => {
		expect(offer({})).toEqual({ kind: "offered" });
	});

	it("is busy while its own submission runs, and while Clear form starts a fresh entry", () => {
		expect(offer({ submitting: true })).toEqual({
			kind: "busy",
			reason: "submitting",
		});
		/* The press on Clear lands before the fresh entry's key does: Submit is
		 * busy from the press, not only once the new key is known. */
		expect(offer({ clearing: true })).toEqual({
			kind: "busy",
			reason: "clearing",
		});
	});

	it("waits for an entry still opening and for one rebuilding", () => {
		expect(offer({ entry: "initializing" })).toEqual({
			kind: "waiting",
			reason: "form-initializing",
		});
		expect(offer({ entry: "rebuilding" })).toEqual({
			kind: "waiting",
			reason: "form-rebuilding",
		});
	});

	it("waits while the device case data refreshes, and is unavailable when the refresh failed", () => {
		expect(offer({ caseDatabase: "refreshing" })).toEqual({
			kind: "waiting",
			reason: "case-data-refreshing",
		});
		expect(offer({ caseDatabase: "failed" })).toEqual({
			kind: "unavailable",
			reason: "case-data-failed",
		});
	});

	it("waits for the selected record to bind", () => {
		expect(offer({ caseBindingReady: false })).toEqual({
			kind: "waiting",
			reason: "record-loading",
		});
	});

	it("waits while a repeat's rows are added or removed", () => {
		expect(offer({ repeatSettling: true })).toEqual({
			kind: "waiting",
			reason: "repeat-updating",
		});
	});

	it("waits while access is checked, and is unavailable without edit access", () => {
		expect(offer({ access: "checking" })).toEqual({
			kind: "waiting",
			reason: "access-checking",
		});
		expect(offer({ access: "no-edit-access" })).toEqual({
			kind: "unavailable",
			reason: "no-edit-access",
		});
	});

	it("is a fault for a form that names nowhere to go, whatever else holds", () => {
		expect(offer({ afterSubmitKnown: false })).toEqual({
			kind: "fault",
			reason: "no-after-submit",
		});
		expect(
			offer({
				afterSubmitKnown: false,
				submitting: true,
				entry: "initializing",
				access: "no-edit-access",
			}),
		).toEqual({ kind: "fault", reason: "no-after-submit" });
	});

	it("says first a change to the form, then the press it retires, then what will end by itself, then what the person must change", () => {
		expect(offer({ clearing: true, caseDatabase: "refreshing" })).toMatchObject(
			{ kind: "busy", reason: "clearing" },
		);
		/* A press running when the form changes under it does not finish: it
		 * settles back to idle once it finds the change, so the line says what
		 * the form waits for, never that the submission is finishing. */
		expect(offer({ submitting: true, caseDatabase: "refreshing" })).toEqual({
			kind: "waiting",
			reason: "case-data-refreshing",
		});
		expect(offer({ submitting: true, caseDatabase: "failed" })).toEqual({
			kind: "unavailable",
			reason: "case-data-failed",
		});
		expect(offer({ submitting: true, caseBindingReady: false })).toMatchObject({
			reason: "record-loading",
		});
		expect(offer({ submitting: true, entry: "rebuilding" })).toMatchObject({
			reason: "form-rebuilding",
		});
		expect(offer({ submitting: true, repeatSettling: true })).toMatchObject({
			reason: "repeat-updating",
		});
		expect(offer({ submitting: true, access: "checking" })).toEqual({
			kind: "busy",
			reason: "submitting",
		});
		expect(offer({ submitting: true, access: "no-edit-access" })).toEqual({
			kind: "busy",
			reason: "submitting",
		});
		expect(
			offer({ entry: "initializing", caseBindingReady: false }),
		).toMatchObject({ reason: "form-initializing" });
		expect(
			offer({ caseDatabase: "refreshing", caseBindingReady: false }),
		).toMatchObject({ reason: "case-data-refreshing" });
		expect(
			offer({ caseBindingReady: false, entry: "rebuilding" }),
		).toMatchObject({ reason: "record-loading" });
		expect(offer({ repeatSettling: true, access: "checking" })).toMatchObject({
			reason: "repeat-updating",
		});
		expect(
			offer({ repeatSettling: true, access: "no-edit-access" }),
		).toMatchObject({ kind: "waiting", reason: "repeat-updating" });
	});
});

describe("previewSubmitAccess", () => {
	const EDITOR = {
		accessPhase: "authorized",
		canEdit: true,
		sameApp: true,
		entryAuthorityCurrent: true,
	} as const;

	it("is an editor only while authorized, editable, on the screen's app, with the entry's authority current", () => {
		expect(previewSubmitAccess(EDITOR)).toBe("editor");
	});

	it("is still checking while the session refreshes or reconnects", () => {
		expect(
			previewSubmitAccess({
				...EDITOR,
				accessPhase: "refreshing",
				canEdit: false,
			}),
		).toBe("checking");
		expect(
			previewSubmitAccess({
				...EDITOR,
				accessPhase: "reconnecting",
				canEdit: false,
			}),
		).toBe("checking");
	});

	it("is still checking where the screen has not caught up with the session", () => {
		expect(previewSubmitAccess({ ...EDITOR, sameApp: false })).toBe("checking");
		expect(
			previewSubmitAccess({ ...EDITOR, entryAuthorityCurrent: false }),
		).toBe("checking");
	});

	it("has no edit access for a viewer and once access has ended", () => {
		expect(previewSubmitAccess({ ...EDITOR, canEdit: false })).toBe(
			"no-edit-access",
		);
		expect(previewSubmitAccess({ ...EDITOR, accessPhase: "revoked" })).toBe(
			"no-edit-access",
		);
		expect(
			previewSubmitAccess({ ...EDITOR, accessPhase: "upgradeRequired" }),
		).toBe("no-edit-access");
	});
});
