import type {
	CaseWriteVerdictWorkerRequest,
	CaseWriteVerdictWorkerResponse,
} from "@/lib/doc/caseWriteVerdictWorkerProtocol";
import { evaluateCaseWriteVerdictBatch } from "@/lib/doc/caseWriteVerdictWorkerRuntime";

interface CaseWriteVerdictWorkerScope {
	postMessage(message: CaseWriteVerdictWorkerResponse): void;
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<CaseWriteVerdictWorkerRequest>) => void,
	): void;
}

const workerScope = self as unknown as CaseWriteVerdictWorkerScope;
workerScope.addEventListener("message", (event) => {
	workerScope.postMessage(evaluateCaseWriteVerdictBatch(event.data));
});
