import type { LanguageTag, Uuid } from "@/lib/domain";
import type { XPathRuntimeFailureReason } from "../xpath/workerProtocol";
import type { SetvalueRefusalDetails } from "./answerCast";
import type { FormAnswerValue } from "./formAnswerValue";
import type { ResolvedPreviewIdentity } from "./identity";
import type { PreviewLookupData } from "./lookupEvaluation";
import type {
	CaseDatabaseSnapshot,
	SearchResultsSnapshot,
} from "./xpathInstances";
export interface FormEvaluationFault {
	readonly path: string;
	readonly expression: string;
	readonly code: string;
	readonly reason?: XPathRuntimeFailureReason;
}
export class FormEvaluationInputError extends Error {
	readonly name = "FormEvaluationInputError";
	constructor(
		message: string,
		readonly fault?: FormEvaluationFault,
	) {
		super(message);
	}
}

/** A form CommCare refuses to run as asked: a setvalue's cast turned away a
 * preloaded value, a starting value or a repeat insert's starting value. */
export interface FormRefusalDetails extends SetvalueRefusalDetails {
	readonly kind: "form-refused";
	/** The refusal as one sentence, in English. */
	readonly sentence: string;
}

/** The running app refuses this form (or one requested repeat insert); an
 * evaluation reports why instead of a result. */
export class FormRefusedError extends FormEvaluationInputError {
	readonly refusal: FormRefusalDetails;

	constructor(refusal: FormRefusalDetails) {
		super(refusal.sentence);
		this.refusal = refusal;
	}
}

export interface FormEvaluationInput {
	readonly formUuid: Uuid;
	/** Internal page navigation for a retained test journey. */
	readonly sectionUuid?: Uuid;
	readonly answers: readonly { path: string; value: FormAnswerValue }[];
	readonly repeats?: readonly { path: string; count: number }[];
	readonly caseIds?: readonly string[];
	readonly searchAnswers?: readonly { name: string; value: string }[];
	readonly language?: LanguageTag;
}

export interface FormEvaluationEntry {
	readonly entryKey: string;
	readonly language?: LanguageTag;
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
	/** What the search of the form's search-first module returned
	 * (`searchResultsSnapshot.ts`), read as `results:inline` by the form and
	 * its after-submit links. Absent, the form has no search results. */
	searchResults?: SearchResultsSnapshot;
	/** The running session the entry starts from: the app its `uuid()`
	 * datums are minted in and the menu's case choices
	 * (`entrySessionData.ts`). Without it the entry holds its selected
	 * records alone. */
	session?: {
		readonly appId: string;
		readonly menuSelections: Readonly<
			Record<string, import("@/lib/session/types").PreviewMenuCaseSelection>
		>;
	};
}
