import { parentPort, workerData } from "node:worker_threads";
import { evaluateFormSnapshot } from "./evaluateFormSnapshot";
import { FormEvaluationInputError } from "./formEvaluationTypes";

try {
	const result = await evaluateFormSnapshot(
		workerData.doc,
		workerData.input,
		workerData.context,
	);
	parentPort?.postMessage({ ok: true, result });
} catch (error) {
	parentPort?.postMessage({
		ok: false,
		inputError: error instanceof FormEvaluationInputError,
		...(error instanceof FormEvaluationInputError && error.fault
			? { fault: error.fault }
			: {}),
		message: error instanceof Error ? error.message : "Form evaluation failed.",
	});
}
