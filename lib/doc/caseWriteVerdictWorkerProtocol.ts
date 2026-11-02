import type {
	CaseWriteChoice,
	CaseWriteChoiceVerdict,
} from "@/lib/doc/caseWriteChoices";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { PersistableDoc, Uuid } from "@/lib/domain";

/** Version 2: a candidate is a destination (`{caseType, property, via?,
 *  onlyIfChanged?}` or `null`) with the view row it replaces, and an
 *  admitted verdict carries the batch it judged. */
export const CASE_WRITE_VERDICT_WORKER_VERSION = 2 as const;

export interface CaseWriteVerdictCandidate extends CaseWriteChoice {
	readonly key: string;
}

export interface CaseWriteVerdictWorkerRequest {
	readonly version: typeof CASE_WRITE_VERDICT_WORKER_VERSION;
	readonly requestId: number;
	readonly doc: PersistableDoc;
	readonly fieldUuid: Uuid;
	readonly lookupContext: LookupValidationContext;
	readonly candidates: readonly CaseWriteVerdictCandidate[];
}

export type CaseWriteVerdictWorkerResponse =
	| {
			readonly version: typeof CASE_WRITE_VERDICT_WORKER_VERSION;
			readonly requestId: number;
			readonly ok: true;
			readonly verdicts: readonly (readonly [string, CaseWriteChoiceVerdict])[];
	  }
	| {
			readonly version: typeof CASE_WRITE_VERDICT_WORKER_VERSION;
			readonly requestId: number;
			readonly ok: false;
	  };
