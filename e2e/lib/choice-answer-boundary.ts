export * from "./preview-form-lifecycle-boundary";

import type * as Actions from "@/lib/preview/engine/caseDataBinding";
import { row } from "./preview-cases-boundary";

const selectedRow = {
	...row,
	case_id: "old-record",
	case_type: "patient",
	case_name: "Old record",
	properties: { stage: "retired" },
};
export const loadCaseDataAction: typeof Actions.loadCaseDataAction =
	async () => ({ kind: "row", row: selectedRow, ancestors: [] });
export const loadCaseDatabaseSnapshotAction: typeof Actions.loadCaseDatabaseSnapshotAction =
	async () => ({
		kind: "data",
		snapshot: { rows: [selectedRow], indices: [] },
	});
