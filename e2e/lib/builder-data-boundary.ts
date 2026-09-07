import type * as Actions from "@/lib/preview/engine/caseDataBinding";
import type * as Rename from "@/lib/preview/engine/casePropertyRenamePreflight";

// Only the compiled Next Server Action transport is replaced; production
// resource/mutation hooks, authority, invalidation, and UI remain intact.
async function request(method: string, args: unknown[]) {
	const response = await fetch(`/native/case-data/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(args),
	});
	if (!response.ok) throw new Error("Native case-data peer failed");
	return response.json();
}
export const loadCaseCountAction: typeof Actions.loadCaseCountAction = async (
	...args
) => request("loadCaseCountAction", args);
export const loadCaseDataAction: typeof Actions.loadCaseDataAction = async (
	...args
) => request("loadCaseDataAction", args);
export const loadCasesAction: typeof Actions.loadCasesAction = async (
	...args
) => request("loadCasesAction", args);
export const loadMissingConnectionCountAction: typeof Actions.loadMissingConnectionCountAction =
	async (...args) => request("loadMissingConnectionCountAction", args);
export const loadParkedValuesAction: typeof Actions.loadParkedValuesAction =
	async (...args) => request("loadParkedValuesAction", args);
export const populateSampleCasesAction: typeof Actions.populateSampleCasesAction =
	async (...args) => request("populateSampleCasesAction", args);
export const replaceParkedValueAction: typeof Actions.replaceParkedValueAction =
	async (...args) => request("replaceParkedValueAction", args);
export const resetSampleCasesAction: typeof Actions.resetSampleCasesAction =
	async (...args) => request("resetSampleCasesAction", args);
export const restoreParkedValuesAction: typeof Actions.restoreParkedValuesAction =
	async (...args) => request("restoreParkedValuesAction", args);
export const setParkedValuesDismissedAction: typeof Actions.setParkedValuesDismissedAction =
	async (...args) => request("setParkedValuesDismissedAction", args);
export const preflightCasePropertyRenamesAction: typeof Rename.preflightCasePropertyRenamesAction =
	async () => {
		throw new Error("Unexpected rename preflight in case-data fixture");
	};
