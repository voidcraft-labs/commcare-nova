// Remote transport is controlled. PreviewShell, HomeScreen, ModuleScreen,
// CaseListScreen, the session, the platform rules and the controller stay
// real; the worker's cases are two fixed rows the device holds.
export {
	getAllLookupDefinitionsAction,
	launchEntryPointAction,
	listAppTestsAction,
	loadFilterPreviewAction,
	loadLookupFixtureDataAction,
	loadMissingConnectionCountAction,
	loadParkedValuesAction,
	loadSearchResultsSnapshotAction,
	platformChangePreflightAction,
	populateSampleCasesAction,
	readAppTestAction,
	readDeploymentsAction,
	replaceParkedValueAction,
	resetSampleCasesAction,
	restoreParkedValuesAction,
	setParkedValuesDismissedAction,
	submitFormAction,
	useAuth,
} from "./preview-section-paging-boundary";

import type * as Actions from "@/lib/preview/engine/caseDataBinding";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import {
	NAVIGATION_APP_ID,
	NAVIGATION_CASES,
} from "./previewNavigationFixture";

const rows: CaseRowWithCalculated[] = NAVIGATION_CASES.map((name, index) => ({
	case_id: `navigation-case-${index + 1}`,
	case_type: "patient",
	case_name: name,
	app_id: NAVIGATION_APP_ID,
	owner_id: "native-worker",
	status: "open",
	opened_on: null,
	modified_on: null,
	closed_on: null,
	external_id: null,
	parent_case_id: null,
	properties: {},
	calculated: {},
}));

export const loadCasesAction: typeof Actions.loadCasesAction = async (args) => {
	const chosen = args.caseIds
		? rows.filter((row) => args.caseIds?.includes(row.case_id))
		: rows;
	return {
		kind: "rows",
		rows: chosen,
		totalCount: chosen.length,
		pageOffset: 0,
		pageSize: args.page?.limit ?? 50,
		constraintSource: "unconstrained",
	};
};
export const loadCaseCountAction: typeof Actions.loadCaseCountAction =
	async () => ({ kind: "count", count: rows.length });
export const loadCaseDataAction: typeof Actions.loadCaseDataAction = async (
	_appId,
	_caseType,
	caseId,
) => {
	const row = rows.find((candidate) => candidate.case_id === caseId);
	if (row === undefined)
		throw new Error("Unexpected case read in navigation evidence");
	return { kind: "row", row, ancestors: [] };
};
export const loadCaseDatabaseSnapshotAction: typeof Actions.loadCaseDatabaseSnapshotAction =
	async () => ({ kind: "data", snapshot: { rows, indices: [] } });

// The device holds both cases, so nothing a worker chooses is claimed.
async function unexpectedClaim(): Promise<never> {
	throw new Error("Unexpected search claim in navigation evidence");
}
export const claimSearchedCasesAction = unexpectedClaim;
export const countClaimedCasesAction = unexpectedClaim;
export const releaseClaimedCasesAction = unexpectedClaim;
export const countCasesOwnedByAction = unexpectedClaim;
export const conversionImpactAction = unexpectedClaim;

// These PreviewShell destinations are not part of the navigation recipe.
// Refuse them rather than bundling their remote service graphs in this peer.
const refuseUnvisitedScreen = (): never => {
	throw new Error("Unexpected workspace destination in navigation evidence");
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
