import type { CasePropertyDataType } from "../casePropertyTypes";
import type { Uuid } from "../uuid";
import type { SearchInputDecl } from "./context";

export type RuleSet = "record" | "form";
export type ExpressionTarget = "XF" | "SU" | "HQ" | "CS" | "PG" | "PV";
export type Expectation =
	| { readonly kind: "condition" }
	| {
			readonly kind: "value";
			readonly type?: CasePropertyDataType;
			readonly many?: true;
	  }
	| {
			readonly kind: "assignment";
			readonly destinations: readonly CasePropertyDataType[];
	  };
export interface SlotProfile {
	readonly ruleSet: RuleSet;
	readonly targets: ReadonlySet<ExpressionTarget>;
	readonly expectation: Expectation;
	readonly scope:
		| "form"
		| "session"
		| "global"
		| "case"
		| "table"
		| "submission";
	readonly caseData: boolean;
	readonly formAnswers: boolean;
	readonly searchInputs: readonly SearchInputDecl[];
	readonly operationIds: ReadonlySet<Uuid>;
	readonly ownerValues: boolean;
	readonly patternMatching: boolean;
	/** `here()` has a handler only where a case list or detail installs one
	 * (Formplayer `MenuSessionRunnerService.java::addHereFuncHandler`, Android
	 * `EntitySelectActivity.getHereFunctionHandler`); no form context does. */
	readonly here: boolean;
}

export function slotProfile(
	ruleSet: RuleSet,
	scope: SlotProfile["scope"],
	targets: readonly ExpressionTarget[],
	expectation: Expectation,
	facts: Partial<
		Pick<
			SlotProfile,
			| "caseData"
			| "formAnswers"
			| "searchInputs"
			| "operationIds"
			| "ownerValues"
			| "patternMatching"
			| "here"
		>
	> = {},
): SlotProfile {
	return {
		ruleSet,
		scope,
		targets: new Set(targets),
		expectation,
		caseData: scope === "case" || scope === "submission" || ruleSet === "form",
		formAnswers: scope === "form" || scope === "submission",
		searchInputs: [],
		operationIds: new Set(),
		ownerValues: false,
		patternMatching: false,
		here: false,
		...facts,
	};
}
