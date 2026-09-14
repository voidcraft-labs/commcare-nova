import type { LanguageTag, Uuid } from "@/lib/domain";
import type { ResolvedPreviewIdentity } from "./identity";
import type { PreviewLookupData } from "./lookupEvaluation";
import type { CaseDatabaseSnapshot } from "./xpathInstances";
export interface FormEvaluationFault {
	readonly path: string;
	readonly expression: string;
	readonly code: string;
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
	readonly answers: readonly { path: string; value: string }[];
	readonly repeats?: readonly { path: string; count: number }[];
	readonly caseIds?: readonly string[];
	readonly searchAnswers?: readonly { name: string; value: string }[];
	readonly language?: LanguageTag;
}

export interface FormEvaluationContext {
	identity: ResolvedPreviewIdentity;
	cases: CaseDatabaseSnapshot;
	lookup: Pick<
		PreviewLookupData,
		"projectRevision" | "definitions" | "rowsByTable"
	>;
}
