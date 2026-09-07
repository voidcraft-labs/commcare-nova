import type * as Actions from "@/lib/preview/engine/caseDataBinding";
/** The compiled Next Server Action transport is replaced by a native HTTP peer.
 * All caller projection/loading/race behavior stays production code. This is
 * browser evidence; Postgres tests own returned row/count semantics. */
export const loadFilterPreviewAction: typeof Actions.loadFilterPreviewAction =
	async (input) => {
		const response = await fetch("/native/filter-preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});
		if (!response.ok)
			throw new Error("Native filter transport rejected request");
		return response.json();
	};

import type * as LookupActions from "@/lib/lookup/actions";
export const getAllLookupDefinitionsAction: typeof LookupActions.getAllLookupDefinitionsAction =
	async (projectId) => {
		const response = await fetch("/native/lookup-definitions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId }),
		});
		if (!response.ok)
			throw new Error("Native lookup transport rejected request");
		return response.json();
	};

/** These Server Actions are transitively imported by the actual module-settings surface, but this authoring fixture never starts the running app. An accidental call fails visibly. */
export const loadCaseCountAction: typeof Actions.loadCaseCountAction =
	async () => {
		throw new Error("Unexpected running-app action: loadCaseCountAction");
	};
export const loadCaseDataAction: typeof Actions.loadCaseDataAction =
	async () => {
		throw new Error("Unexpected running-app action: loadCaseDataAction");
	};
export const loadCasesAction: typeof Actions.loadCasesAction = async () => {
	throw new Error("Unexpected running-app action: loadCasesAction");
};
export const loadMissingConnectionCountAction: typeof Actions.loadMissingConnectionCountAction =
	async () => {
		throw new Error(
			"Unexpected running-app action: loadMissingConnectionCountAction",
		);
	};
export const loadParkedValuesAction: typeof Actions.loadParkedValuesAction =
	async () => {
		throw new Error("Unexpected running-app action: loadParkedValuesAction");
	};
export const populateSampleCasesAction: typeof Actions.populateSampleCasesAction =
	async () => {
		throw new Error("Unexpected running-app action: populateSampleCasesAction");
	};
export const replaceParkedValueAction: typeof Actions.replaceParkedValueAction =
	async () => {
		throw new Error("Unexpected running-app action: replaceParkedValueAction");
	};
export const resetSampleCasesAction: typeof Actions.resetSampleCasesAction =
	async () => {
		throw new Error("Unexpected running-app action: resetSampleCasesAction");
	};
export const restoreParkedValuesAction: typeof Actions.restoreParkedValuesAction =
	async () => {
		throw new Error("Unexpected running-app action: restoreParkedValuesAction");
	};
export const setParkedValuesDismissedAction: typeof Actions.setParkedValuesDismissedAction =
	async () => {
		throw new Error(
			"Unexpected running-app action: setParkedValuesDismissedAction",
		);
	};
