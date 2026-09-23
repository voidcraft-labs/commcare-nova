export {
	launchEntryPointAction,
	loadCaseCountAction,
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
export {
	getAllLookupDefinitionsAction,
	submitFormAction,
} from "./preview-form-lifecycle-boundary";

import type * as Actions from "@/lib/preview/engine/caseDataBinding";
import type { CaseRow } from "@/lib/preview/engine/caseDataBindingTypes";

export const selectedRow: CaseRow = {
	case_id: "selected-room",
	case_type: "room",
	case_name: "Store room",
	app_id: "selected-entry",
	owner_id: "native-worker",
	status: "open",
	opened_on: null,
	modified_on: null,
	closed_on: null,
	external_id: null,
	parent_case_id: null,
	properties: {},
};
export const loadCaseDataAction: typeof Actions.loadCaseDataAction =
	async () => {
		const response = await fetch("/selected-record");
		return response.json();
	};
export const loadCaseDatabaseSnapshotAction: typeof Actions.loadCaseDatabaseSnapshotAction =
	async () => ({
		kind: "data",
		snapshot: { rows: [selectedRow], indices: [] },
	});
