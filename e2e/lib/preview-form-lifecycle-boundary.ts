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
import type { XPathWorkerPort } from "@/lib/preview/xpath/workerClient";
import {
	XPATH_WORKER_BUILD_ID,
	type XPathWorkerEvaluateRequest,
} from "@/lib/preview/xpath/workerProtocol";

const caseDatabaseScenario =
	typeof location !== "undefined" &&
	new URLSearchParams(location.search).has("case-database");
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
		if (!caseDatabaseScenario)
			throw new Error(
				"Unexpected case database request in survey lifecycle evidence",
			);
		const response = await fetch("/case-database");
		return response.json();
	};

let armedEntry: string | undefined;
let heldValidation:
	| { readonly request: XPathWorkerEvaluateRequest; release(): void }
	| undefined;

/** The browser proof delays one request, then forwards its unchanged protocol
 * to the production worker. No validation result is supplied by the test. */
export function createBrowserXPathWorker(): XPathWorkerPort {
	const worker = new Worker(
		`/xpath-worker/xpath-worker.js?build=${encodeURIComponent(XPATH_WORKER_BUILD_ID)}`,
		{ type: "module" },
	);
	let terminated = false;
	return {
		postMessage(request) {
			if (
				armedEntry === request.entryKey &&
				request.operation === "evaluate" &&
				request.profile === "form"
			) {
				armedEntry = undefined;
				heldValidation = {
					request,
					release() {
						if (!terminated) worker.postMessage(request);
					},
				};
			} else worker.postMessage(request);
		},
		addEventListener: worker.addEventListener.bind(worker),
		removeEventListener: worker.removeEventListener.bind(worker),
		terminate() {
			terminated = true;
			worker.terminate();
		},
	};
}

export function armValidationWorker(entryKey: string) {
	if (armedEntry !== undefined || heldValidation !== undefined)
		throw new Error("A validation request is already held");
	armedEntry = entryKey;
}

export function validationWorkerHeld() {
	return heldValidation !== undefined;
}

export function releaseValidationWorker() {
	armedEntry = undefined;
	const held = heldValidation;
	heldValidation = undefined;
	held?.release();
}

export async function getAllLookupDefinitionsAction(): Promise<never> {
	throw new Error(
		"Unexpected lookup catalog request in form lifecycle evidence",
	);
}
