import { caseWriteChoiceVerdict } from "@/lib/doc/caseWriteChoices";
import {
	CASE_WRITE_VERDICT_WORKER_VERSION,
	type CaseWriteVerdictWorkerRequest,
	type CaseWriteVerdictWorkerResponse,
} from "@/lib/doc/caseWriteVerdictWorkerProtocol";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";

/** Execute one exact candidate partition. The browser client partitions the
 * catalog across a bounded worker pool; every verdict still traverses the
 * authoritative mutation gate, just never on the interaction thread. */
export function evaluateCaseWriteVerdictBatch(
	request: CaseWriteVerdictWorkerRequest,
): CaseWriteVerdictWorkerResponse {
	if (request.version !== CASE_WRITE_VERDICT_WORKER_VERSION) {
		return {
			version: CASE_WRITE_VERDICT_WORKER_VERSION,
			requestId: request.requestId,
			ok: false,
		};
	}
	const doc = hydratePersistedBlueprint(request.doc);
	const field = doc.fields[request.fieldUuid];
	if (field === undefined) {
		return {
			version: CASE_WRITE_VERDICT_WORKER_VERSION,
			requestId: request.requestId,
			ok: false,
		};
	}
	return {
		version: CASE_WRITE_VERDICT_WORKER_VERSION,
		requestId: request.requestId,
		ok: true,
		verdicts: request.candidates.map((candidate) => [
			candidate.key,
			caseWriteChoiceVerdict(
				doc,
				field,
				candidate.caseWrite,
				request.lookupContext,
			),
		]),
	};
}
