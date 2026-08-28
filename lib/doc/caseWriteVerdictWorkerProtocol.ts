import type {
	AuthoredCaseWrite,
	CaseWriteChoiceVerdict,
} from "@/lib/doc/caseWriteChoices";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { PersistableDoc, Uuid } from "@/lib/domain";

export const CASE_WRITE_VERDICT_WORKER_VERSION = 1 as const;

export interface CaseWriteVerdictCandidate {
	readonly key: string;
	readonly caseWrite: AuthoredCaseWrite | null;
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
