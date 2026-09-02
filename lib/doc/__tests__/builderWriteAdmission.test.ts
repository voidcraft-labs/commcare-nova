/**
 * State-model tests for `builderWriteAdmission` — the pre-verdict admission
 * every builder write runs (a gated dispatch, a Connect-mode switch, an undo
 * or redo) so all three refuse a viewer and an unready lookup catalog in one
 * voice. Pure: no hook render, no store.
 */

import { describe, expect, it } from "vitest";
import { availableLookupContext } from "@/lib/__tests__/lookupFixtures";
import { builderWriteAdmission } from "@/lib/doc/builderWriteAdmission";
import type { LookupCommitState } from "@/lib/doc/lookupCommitContext";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";

const READY: LookupCommitState = {
	kind: "ready",
	lookupContext: availableLookupContext([]),
};
const LOADING: LookupCommitState = {
	kind: "loading",
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
};
const FAILED: LookupCommitState = {
	kind: "error",
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
};
const UNMANAGED: LookupCommitState = {
	kind: "unmanaged",
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
};

describe("builderWriteAdmission", () => {
	it("admits an editor once the lookup catalog is ready", () => {
		expect(
			builderWriteAdmission({ canEdit: true, lookupCommitState: READY }),
		).toEqual({ ok: true });
	});

	it("admits an editor with no catalog provider mounted — the verdict runs under the unavailable context", () => {
		expect(
			builderWriteAdmission({ canEdit: true, lookupCommitState: UNMANAGED }),
		).toEqual({ ok: true });
	});

	it("refuses a viewer, whatever the catalog state", () => {
		for (const lookupCommitState of [READY, LOADING, FAILED, UNMANAGED]) {
			const admission = builderWriteAdmission({
				canEdit: false,
				lookupCommitState,
			});
			expect(admission.ok).toBe(false);
			if (!admission.ok) {
				expect(admission.messages).toEqual([
					"You have view-only access to this app. Ask a Project admin for edit access to make changes.",
				]);
			}
		}
	});

	it("refuses an editor while the catalog is loading, naming the wait", () => {
		const admission = builderWriteAdmission({
			canEdit: true,
			lookupCommitState: LOADING,
		});
		expect(admission).toEqual({
			ok: false,
			messages: [
				"Project data is still loading. Wait for it to finish before editing this app.",
			],
		});
	});

	it("refuses an editor when the catalog failed to load, naming the retry", () => {
		const admission = builderWriteAdmission({
			canEdit: true,
			lookupCommitState: FAILED,
		});
		expect(admission).toEqual({
			ok: false,
			messages: [
				"Nova could not load this Project's data-table definitions. Try again before editing this app.",
			],
		});
	});
});
