import type { LanguageTag, Uuid } from "@/lib/domain";
import type { XPathRuntimeFailureReason } from "../xpath/workerProtocol";
import type { FormAnswerValue } from "./formAnswerValue";
import type { ResolvedPreviewIdentity } from "./identity";
import type { PreviewLookupData } from "./lookupEvaluation";
import type { CaseDatabaseSnapshot } from "./xpathInstances";
export interface FormEvaluationFault {
	readonly path: string;
	readonly expression: string;
	readonly code: string;
	readonly reason?: XPathRuntimeFailureReason;
}
export class FormEvaluationInputError extends Error {
	constructor(
		message: string,
		readonly fault?: FormEvaluationFault,
	) {
		super(message);
	}
}

export interface FormEvaluationInput {
	readonly formUuid: Uuid;
	readonly answers: readonly { path: string; value: FormAnswerValue }[];
	readonly repeats?: readonly { path: string; count: number }[];
	readonly caseIds?: readonly string[];
	readonly searchAnswers?: readonly { name: string; value: string }[];
	readonly language?: LanguageTag;
}

export interface FormEvaluationEntry {
	readonly entryKey: string;
	readonly checkpoint: import("./formEngine").FormEngineEntryCheckpoint;
}

export interface FormEvaluationContext {
	/** Internal app-test continuation. Ordinary form checks omit both. */
	entry?: FormEvaluationEntry;
	captureEntry?: boolean;
	identity: ResolvedPreviewIdentity;
	cases: CaseDatabaseSnapshot;
	lookup: Pick<
		PreviewLookupData,
		"projectRevision" | "definitions" | "rowsByTable"
	>;
}
