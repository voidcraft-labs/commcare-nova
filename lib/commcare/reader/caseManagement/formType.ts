/**
 * A basic form's type, derived from what CommCare HQ stores of it: its
 * `requires` and which of its case actions are active
 * (`models/forms.py::FormBase._get_active_actions`). HQ stores no type; the
 * eleven rows of the manifest's "Form types" say which Nova type each pair
 * is, or which finding it is.
 */
import type { FormType } from "@/lib/domain";
import { type Claim, defineClaims, refuse, take } from "../claims";
import type { DraftModule } from "../context";

const F = "forms-and-case-writes";

/** A class this reader refuses: the id of a claim its module declared (`defineClaims`). */
export type FindingEntry = { readonly kind: "finding"; readonly entry: string };

/** Each row's claim on `requires` and on `actions`, the two keys every row reads. */
function row<U extends "take" | "refuse">(
	use: U,
	entry: string,
): { readonly requires: Claim<U>; readonly actions: Claim<U> } {
	const make = use === "take" ? take : refuse;
	return {
		requires: make(`${F}/${entry}`, "schema:Form.requires") as Claim<U>,
		actions: make(`${F}/${entry}`, "schema:Form.actions") as Claim<U>,
	};
}

const REGISTRATION = row(
	"take",
	"form-requires-none-open-case-active-close-case-inactive",
);
const CONDITIONAL_REGISTRATION = row(
	"take",
	"form-requires-none-open-case-condition-if",
);
const CLOSING_REGISTRATION = row(
	"take",
	"form-requires-none-open-case-close-case-active",
);
const FOLLOWUP = row("take", "form-requires-case-no-close");
const CLOSE = row("take", "form-requires-case-close-case");
const SURVEY = row("take", "form-requires-none-no-case-action");
const CLOSE_WITHOUT_OPEN = row(
	"take",
	"form-requires-none-with-close-case-active-and-no-open-in-a-module-with-a",
);
const UPDATE_WITHOUT_OPEN = row(
	"refuse",
	"form-requires-none-with-update-case-active-and-no-open",
);
const CHILD_CASES_WITHOUT_OPEN = row(
	"refuse",
	"form-requires-none-with-child-cases-but-no-open",
);
const CLOSE_WITHOUT_CASE_TYPE = row(
	"refuse",
	"form-requires-none-with-close-case-active-and-no-open-in-a-module-with-no",
);
/** A referral form's row names `requires` alone: its actions are read past
 *  under the same finding. */
const REFERRAL_CLAIM = refuse(
	`${F}/form-requires-referral`,
	"schema:Form.requires",
);
const REFERRAL = { requires: REFERRAL_CLAIM, actions: REFERRAL_CLAIM };

/** The rows' claims, registered once. */
export const FORM_TYPE_CLAIMS = defineClaims("caseManagement.formType", {
	registrationRequires: REGISTRATION.requires,
	registrationActions: REGISTRATION.actions,
	conditionalRegistrationRequires: CONDITIONAL_REGISTRATION.requires,
	conditionalRegistrationActions: CONDITIONAL_REGISTRATION.actions,
	closingRegistrationRequires: CLOSING_REGISTRATION.requires,
	closingRegistrationActions: CLOSING_REGISTRATION.actions,
	followupRequires: FOLLOWUP.requires,
	followupActions: FOLLOWUP.actions,
	closeRequires: CLOSE.requires,
	closeActions: CLOSE.actions,
	surveyRequires: SURVEY.requires,
	surveyActions: SURVEY.actions,
	closeWithoutOpenRequires: CLOSE_WITHOUT_OPEN.requires,
	closeWithoutOpenActions: CLOSE_WITHOUT_OPEN.actions,
	updateWithoutOpenRequires: UPDATE_WITHOUT_OPEN.requires,
	updateWithoutOpenActions: UPDATE_WITHOUT_OPEN.actions,
	childCasesWithoutOpenRequires: CHILD_CASES_WITHOUT_OPEN.requires,
	childCasesWithoutOpenActions: CHILD_CASES_WITHOUT_OPEN.actions,
	closeWithoutCaseTypeRequires: CLOSE_WITHOUT_CASE_TYPE.requires,
	closeWithoutCaseTypeActions: CLOSE_WITHOUT_CASE_TYPE.actions,
	referral: REFERRAL_CLAIM,
});

/** One row of the table: the type it reads, or none where it is a finding, and its two claims. */
export type FormTypeRow =
	| {
			readonly kind: "type";
			readonly type: FormType;
			readonly requires: Claim<"take">;
			readonly actions: Claim<"take">;
	  }
	| {
			readonly kind: "finding";
			readonly requires: Claim<"refuse">;
			readonly actions: Claim<"refuse">;
	  };

function typed(
	type: FormType,
	claims: { readonly requires: Claim<"take">; readonly actions: Claim<"take"> },
): FormTypeRow {
	return { kind: "type", type, ...claims };
}

function refused(claims: {
	readonly requires: Claim<"refuse">;
	readonly actions: Claim<"refuse">;
}): FormTypeRow {
	return { kind: "finding", ...claims };
}

/**
 * The row of `requires` and the active actions, a refused class tested before
 * the held one of the same key. `active` is
 * `publishedCaseBlocks.ts::activeActions(actions, requires)`;
 * `openConditionType` is `open_case.condition.type` as stored;
 * `menuCaseManagement` is whether the form's menu leaves HQ's build its
 * default case management, which a menu that selects several cases or may
 * load a data registry's case turns off (`xform.py::XForm._create_casexml`,
 * `default_case_management`). There a form that requires a case and opens
 * none gets no close from its `close_case` (the build writes one only
 * `if 'close_case' in actions and default_case_management`), so the form
 * closes nothing and is a follow-up, its stored close inert
 * (`basicActions.ts`, `multiSelectNoClose`).
 */
export function formTypeRow(
	requires: unknown,
	active: ReadonlySet<string>,
	openConditionType: unknown,
	module: DraftModule,
	menuCaseManagement: boolean,
): FormTypeRow {
	const word = requires ?? "none";
	if (word === "case")
		return active.has("close_case") && menuCaseManagement
			? typed("close", CLOSE)
			: typed("followup", FOLLOWUP);
	if (word !== "none") return refused(REFERRAL);
	if (active.has("open_case")) {
		if (openConditionType === "if")
			return typed("registration", CONDITIONAL_REGISTRATION);
		return active.has("close_case")
			? typed("registration", CLOSING_REGISTRATION)
			: typed("registration", REGISTRATION);
	}
	if (active.has("update_case")) return refused(UPDATE_WITHOUT_OPEN);
	if (active.has("subcases")) return refused(CHILD_CASES_WITHOUT_OPEN);
	if (active.has("close_case")) {
		const caseType = module.module.caseType;
		return caseType === undefined || caseType === ""
			? refused(CLOSE_WITHOUT_CASE_TYPE)
			: typed("survey", CLOSE_WITHOUT_OPEN);
	}
	return typed("survey", SURVEY);
}

/** `active` is `publishedCaseBlocks.ts::activeActions(actions, requires)`;
 *  `menuCaseManagement` as `formTypeRow` reads it. */
export function readFormType(
	requires: unknown,
	active: ReadonlySet<string>,
	module: DraftModule,
	openConditionType: unknown,
	menuCaseManagement: boolean,
): FormType | FindingEntry {
	const found = formTypeRow(
		requires,
		active,
		openConditionType,
		module,
		menuCaseManagement,
	);
	return found.kind === "type"
		? found.type
		: { kind: "finding", entry: found.requires.entry };
}
