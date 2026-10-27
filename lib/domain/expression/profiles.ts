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
	/** The `case-list-search-text` arm: a form's questions and Connect
	 * settings, which Core evaluates with the entry's session data. */
	readonly caseListSearchText: boolean;
	/** `window_width`: only a slot CommCare evaluates while a menu or a list
	 * loads, the one request HQ's Web Apps client sends the width with
	 * (`formplayer/menus/api.js`); a form request carries none, and a fresh
	 * form's bare read of the absent node throws (`SessionContextRuntimeTest`). */
	readonly windowWidth: boolean;
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
			| "caseListSearchText"
			| "windowWidth"
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
		caseListSearchText: false,
		windowWidth: false,
		...facts,
	};
}

/** A slot only CommCare's server search and Postgres read, which no device
 * evaluates: today an advanced search input's condition. */
export function serverOnlySearchSlot(profile: SlotProfile): boolean {
	return (
		profile.targets.has("CS") &&
		!profile.targets.has("SU") &&
		!profile.targets.has("XF")
	);
}
