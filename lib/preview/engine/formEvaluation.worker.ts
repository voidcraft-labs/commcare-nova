import { parentPort, workerData } from "node:worker_threads";
import { evaluateFormSnapshot } from "./evaluateFormSnapshot";
import {
	FormEvaluationInputError,
	FormRefusedError,
} from "./formEvaluationTypes";
import { evaluatePostSubmissionSnapshot } from "./postSubmissionEvaluation";
import { evaluateSearchSnapshot } from "./searchEvaluation";
import { dataRefusalTransfer } from "./surfacedDataRefusal";

try {
	const evaluate =
		workerData.kind === "search"
			? evaluateSearchSnapshot
			: workerData.kind === "after-submit"
				? evaluatePostSubmissionSnapshot
				: evaluateFormSnapshot;
	const result = await evaluate(
		workerData.doc,
		workerData.input,
		workerData.context,
	);
	parentPort?.postMessage({ ok: true, result });
} catch (error) {
	/* A refusal of data the device lacks crosses as its reason, since a
	 * structured clone drops the error's class; everything an after-submit
	 * evaluation reads is the links after the saved form. */
	const dataRefusal = dataRefusalTransfer(
		error,
		workerData.kind === "after-submit" ? "links" : undefined,
	);
	parentPort?.postMessage({
		ok: false,
		...(dataRefusal === undefined ? {} : { dataRefusal }),
		inputError: error instanceof FormEvaluationInputError,
		...(error instanceof FormEvaluationInputError && error.fault
			? { fault: error.fault }
			: {}),
		...(error instanceof FormRefusedError ? { refusal: error.refusal } : {}),
		message: error instanceof Error ? error.message : "Form evaluation failed.",
		...(error instanceof Error ? { error } : {}),
	});
}
