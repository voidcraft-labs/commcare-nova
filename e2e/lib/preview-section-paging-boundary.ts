// Remote transport is controlled. PreviewShell, HomeScreen, ModuleScreen,
// FormScreen, paging, admission, the controller, Worker and inputs stay real.
export {
	launchEntryPointAction,
	loadCaseCountAction,
	loadCaseDataAction,
	loadCasesAction,
	loadFilterPreviewAction,
	loadLookupFixtureDataAction,
	loadMissingConnectionCountAction,
	loadParkedValuesAction,
	populateSampleCasesAction,
	replaceParkedValueAction,
	resetSampleCasesAction,
	restoreParkedValuesAction,
	setParkedValuesDismissedAction,
	useAuth,
} from "./preview-cases-boundary";

import type * as Actions from "@/lib/preview/engine/caseDataBinding";

// Only the Playwright-owned POST interception can return this response. No
// database, provider or live application receives the submission.
export const submitFormAction: typeof Actions.submitFormAction = async (
	...args
) => {
	const response = await fetch("/submission", {
		method: "POST",
		body: JSON.stringify(args),
		headers: { "Content-Type": "application/json" },
	});
	if (!response.ok) throw new Error("Controlled submission transport refused");
	return response.json();
};

export const loadCaseDatabaseSnapshotAction: typeof Actions.loadCaseDatabaseSnapshotAction =
	async () => {
		throw new Error("Unexpected case snapshot request in paging evidence");
	};

export async function getAllLookupDefinitionsAction(): Promise<never> {
	throw new Error("Unexpected lookup catalog request in paging evidence");
}

export async function listAppTestsAction(): Promise<never> {
	throw new Error("Unexpected test history request in paging evidence");
}
export async function readAppTestAction(): Promise<never> {
	throw new Error("Unexpected test journey request in paging evidence");
}

// These PreviewShell destinations are not part of the survey/module recipe.
// Refuse them rather than bundling their remote service graphs in this peer.
const refuseUnvisitedScreen = (): never => {
	throw new Error("Unexpected workspace destination in paging evidence");
};
export const AppSetupWorkspace = refuseUnvisitedScreen;
export const CaseOperationDetailCanvas = refuseUnvisitedScreen;
export const CaseOperationsCanvas = refuseUnvisitedScreen;
export const DisplayConditionCanvas = refuseUnvisitedScreen;
export const DataReviewScreen = refuseUnvisitedScreen;
export const FormLinkDetailCanvas = refuseUnvisitedScreen;
export const FormLinksCanvas = refuseUnvisitedScreen;
export const ProjectDataWorkspace = refuseUnvisitedScreen;
export const CaseListWorkspaceCanvas = refuseUnvisitedScreen;
export const CaseListScreen = refuseUnvisitedScreen;
