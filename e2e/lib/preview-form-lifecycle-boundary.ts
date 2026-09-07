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
// Browser evidence controls only the remote transport. The actual screen
// constructs the submission, digest and attachment barrier.
export const submitFormAction: typeof Actions.submitFormAction = async (
	...args
) => {
	const response = await fetch("/submission", {
		method: "POST",
		body: JSON.stringify(args),
		headers: { "Content-Type": "application/json" },
	});
	return response.json();
};
export const loadCaseDatabaseSnapshotAction: typeof Actions.loadCaseDatabaseSnapshotAction =
	async () => {
		throw new Error(
			"Unexpected case database request in survey lifecycle evidence",
		);
	};

export async function getAllLookupDefinitionsAction(): Promise<never> {
	throw new Error(
		"Unexpected lookup catalog request in form lifecycle evidence",
	);
}
