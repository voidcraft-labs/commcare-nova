import { testUuid } from "@/__tests__/helpers/uuid";
import type * as Actions from "@/lib/preview/engine/caseDataBinding";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";

export const longCaseName =
	"ClientWithAnExtremelyLongImportedCaseNameThatHasNoNaturalWordBreaks";
export const unavailableColumnUuid = testUuid("native-case-unavailable");
export const row: CaseRowWithCalculated = {
	case_id: "native-case",
	case_type: "patient",
	case_name: longCaseName,
	app_id: "native-cases",
	owner_id: "native-worker",
	status: "open",
	opened_on: null,
	modified_on: null,
	closed_on: null,
	external_id: null,
	parent_case_id: null,
	properties: {
		phone: "+1 202 555 0123",
		field_4: "Fourth value",
		field_5: "Fifth value",
		field_6: "Sixth value",
		field_7: "Seventh value",
	},
	calculated: { [unavailableColumnUuid]: { status: "ready" } },
};
// Deterministic transport replies isolate browser layout from database behavior.
let several = false;
export function configureSeveralCasePopulation() {
	several = true;
}
const severalRows = Array.from({ length: 52 }, (_, index) => ({
	...row,
	case_id: `patient-${index + 1}`,
	case_name: `Patient ${index + 1}`,
}));
export const loadCasesAction: typeof Actions.loadCasesAction = async (args) => {
	if (!several)
		return { kind: "rows", rows: [row], constraintSource: "unconstrained" };
	if (args.caseIds) {
		const response = await fetch("/validate-selection", {
			method: "POST",
			body: JSON.stringify(args.caseIds),
		});
		const ids: string[] = await response.json();
		return {
			kind: "rows",
			rows: ids
				.map((id) => severalRows.find((row) => row.case_id === id))
				.filter((row) => row !== undefined),
			constraintSource: "unconstrained",
		};
	}
	const offset = args.page?.offset ?? 0,
		limit = args.page?.limit ?? 50;
	return {
		kind: "rows",
		rows: severalRows.slice(offset, offset + limit),
		totalCount: severalRows.length,
		pageOffset: offset,
		pageSize: limit,
		constraintSource: "unconstrained",
	};
};
export const loadCaseCountAction: typeof Actions.loadCaseCountAction =
	async () => ({ kind: "count", count: several ? 52 : 1 });
export const loadCaseDataAction: typeof Actions.loadCaseDataAction =
	async () => ({ kind: "row", row, ancestors: [] });
export const loadFilterPreviewAction: typeof Actions.loadFilterPreviewAction =
	async () => ({ kind: "rows", rows: [], totalCount: 0 });
export const loadCaseDatabaseSnapshotAction: typeof Actions.loadCaseDatabaseSnapshotAction =
	async () => {
		throw new Error("Unexpected database snapshot in case layout evidence");
	};
export const submitFormAction: typeof Actions.submitFormAction = async () => {
	throw new Error("Unexpected submission in case layout evidence");
};
export function useAuth() {
	return {
		user: {
			id: "native-worker",
			name: "Native worker",
			email: "native@example.org",
		},
		isAuthenticated: true,
		isPending: false,
		signIn: async () => undefined,
	};
}

export async function loadLookupFixtureDataAction(): Promise<never> {
	throw new Error("Unexpected lookup data request in case layout evidence");
}
export async function launchEntryPointAction(): Promise<never> {
	throw new Error("Unexpected entry point launch in case layout evidence");
}
async function unexpectedCaseWrite(): Promise<never> {
	throw new Error("Unexpected case mutation in case layout evidence");
}
export const loadMissingConnectionCountAction = unexpectedCaseWrite;
export const loadParkedValuesAction = unexpectedCaseWrite;
export const populateSampleCasesAction = unexpectedCaseWrite;
export const replaceParkedValueAction = unexpectedCaseWrite;
export const resetSampleCasesAction = unexpectedCaseWrite;
export const restoreParkedValuesAction = unexpectedCaseWrite;
export const setParkedValuesDismissedAction = unexpectedCaseWrite;
