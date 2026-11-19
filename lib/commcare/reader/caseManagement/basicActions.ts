/**
 * A basic form's case actions (`models/form_actions.py::FormActions`) read
 * into its type and its case operations: the own case, its writes, each
 * child case and the worker's record. The first pass (`readBasicActions`)
 * reads the JSON, claims every key and proposes each operation by the
 * questions it reads; the form's fields are minted after it, so
 * `writeBasicOperations` writes the proposals into the draft once every
 * question has its UUID. `settleCaseManagement` accepts them by re-emission.
 */
import { type Element, isTag } from "domhandler";
import {
	AUTHORED_CASE_PROPERTY_NAME_PATTERN,
	type BlueprintDoc,
	type CaseOperation,
	type CaseOperationWrite,
	type CasePlacement,
	type CaseWriteVia,
	captureFieldKinds,
	type Expression,
	type FormType,
	MAX_AUTHORED_CASE_PROPERTY_NAME_LENGTH,
	ownCaseOperationId,
	type RelationStep,
	type Uuid,
} from "@/lib/domain";
import { formField, matchAll, term } from "@/lib/domain/expression/builders";
import { clockKeepingJoin } from "@/lib/domain/expression/datePattern";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import {
	circumstanceFinding,
	type FindingDetail,
	type HqPlace,
} from "@/lib/publish/hqFindings";
import {
	HQ_CASE_RESERVED_WORDS,
	RESERVED_CASE_PROPERTIES,
} from "../../constants";
import {
	activeActions,
	isMultiSelectMenu,
	menuMayLoadRegistryCase,
} from "../../hq/publishedCaseBlocks";
import {
	isElement,
	type NamespaceScope,
	scopeOf,
	XFORMS_NS,
} from "../../xmlNamespaces";
import type { Admitted } from "../accounting";
import {
	type Claim,
	defineClaims,
	derived,
	drop,
	refuse,
	take,
} from "../claims";
import type { DraftForm, DraftModule, ReadContext } from "../context";
import { type CaseOperationPlaceKey, externalKey } from "../identity";
import {
	isJsonObject,
	type JsonCursor,
	pointerToken,
	registerUndeclaredKeys,
	sameJson,
} from "../jsonCursor";
import { whereText } from "../place";
import { holdsWorkerRecordWrite } from "../worldEntities";
import type { DraftField, ReadXForm } from "../xform";
import type { DataNode } from "../xform/model";
import type { ParsedXForm } from "../xform/parse";
import {
	CONDITION_CLAIMS,
	conditionField,
	conditionQuestionPath,
	conditionType,
	readActionCondition,
	repeatAtPath,
} from "./conditions";
import { FORM_TYPE_CLAIMS, formTypeRow } from "./formType";

const F = "forms-and-case-writes";
const Q = "questions";

export const BASIC_CLAIMS = defineClaims("caseManagement.basicActions", {
	openCase: take(
		`${F}/open-case-name-update-question-path`,
		"schema:FormActions.open_case",
	),
	nameUpdate: take(
		`${F}/open-case-name-update-question-path`,
		"schema:OpenCaseAction.name_update",
	),
	openRegistrationCondition: take(
		`${F}/form-requires-none-open-case-active-close-case-inactive`,
		"schema:OpenCaseAction.condition",
	),
	openConditionalCondition: take(
		`${F}/form-requires-none-open-case-condition-if`,
		"schema:OpenCaseAction.condition",
	),
	openClosingCondition: take(
		`${F}/form-requires-none-open-case-close-case-active`,
		"schema:OpenCaseAction.condition",
	),
	externalIdActive: take(
		`${F}/open-case-external-id-on-a-form-whose-open-case-is-active`,
		"schema:OpenCaseAction.external_id",
	),
	externalIdInactive: drop(
		`${F}/open-case-external-id-on-any-other-form`,
		"schema:FormActions.open_case",
	),
	openOnFollowup: drop(
		`${F}/open-case-active-on-a-requires-case-form`,
		"schema:FormActions.open_case",
	),
	openConflicts: refuse(
		`${F}/a-non-empty-open-case-conflicts-list-or-an-update-case-conflicts`,
		"schema:OpenCaseAction.conflicts",
	),
	updateConflicts: refuse(
		`${F}/a-non-empty-open-case-conflicts-list-or-an-update-case-conflicts`,
		"schema:UpdateCaseAction.conflicts",
	),
	updateMultiOpen: drop(
		`${F}/update-multi-name-update-multi`,
		"schema:OpenCaseAction.<undeclared>",
	),
	updateMultiUpdate: drop(
		`${F}/update-multi-name-update-multi`,
		"schema:UpdateCaseAction.<undeclared>",
	),
	undeclaredOpen: refuse(
		`${F}/any-other-undeclared-key`,
		"schema:OpenCaseAction.<undeclared>",
	),
	undeclaredUpdate: refuse(
		`${F}/any-other-undeclared-key`,
		"schema:UpdateCaseAction.<undeclared>",
	),

	updateAlways: take(
		`${F}/update-case-condition-always`,
		"schema:FormActions.update_case",
	),
	updateAlwaysCondition: take(
		`${F}/update-case-condition-always`,
		"schema:UpdateCaseAction.condition",
	),
	updateIf: take(
		`${F}/update-case-condition-if-whose-question-exists`,
		"schema:FormActions.update_case",
	),
	updateIfCondition: take(
		`${F}/update-case-condition-if-whose-question-exists`,
		"schema:UpdateCaseAction.condition",
	),
	updateIfGone: refuse(
		`${F}/update-case-condition-if-whose-question-is-gone`,
		"schema:UpdateCaseAction.condition",
	),
	updateNeverRegistration: take(
		`${F}/update-case-condition-never-on-a-registration-form`,
		"schema:FormActions.update_case",
	),
	updateNeverRegistrationCondition: take(
		`${F}/update-case-condition-never-on-a-registration-form`,
		"schema:UpdateCaseAction.condition",
	),
	updateNeverWithOthers: take(
		`${F}/update-case-condition-never-on-a-follow-up-with-any-other-entry`,
		"schema:FormActions.update_case",
	),
	updateNeverWithOthersCondition: take(
		`${F}/update-case-condition-never-on-a-follow-up-with-any-other-entry`,
		"schema:UpdateCaseAction.condition",
	),
	updateNeverMulti: take(
		`${F}/update-case-condition-never-on-a-follow-up-in-a-multi-select-or`,
		"schema:FormActions.update_case",
	),
	updateNeverMultiCondition: take(
		`${F}/update-case-condition-never-on-a-follow-up-in-a-multi-select-or`,
		"schema:UpdateCaseAction.condition",
	),
	updateNeverAlone: refuse(
		`${F}/update-case-condition-never-on-a-follow-up-with-no-other-active`,
		"schema:UpdateCaseAction.condition",
	),
	updateMap: take(
		`${F}/update-case-update-property-question`,
		"schema:UpdateCaseAction.update",
	),
	updateMapUnderNever: drop(
		`${F}/update-case-update-map-under-condition-never`,
		"schema:UpdateCaseAction.update",
	),
	questionPath: take(
		`${F}/update-case-update-property-question`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	bareString: refuse(
		`${F}/update-case-update-value-as-a-bare-string-legacy-pre`,
		"schema:UpdateCaseAction.update",
	),
	editHeld: take(
		`${F}/conditionalcaseupdate-update-mode-edit`,
		"schema:ConditionalCaseUpdate.update_mode",
	),
	editNotHeld: refuse(
		`${F}/update-mode-edit-off-a-follow-up-form-s-own-update`,
		"schema:ConditionalCaseUpdate.update_mode",
	),
	editNotApplied: drop(
		`${F}/update-mode-edit-in-a-project-space-that-saves-every-time`,
		"schema:ConditionalCaseUpdate.update_mode",
	),
	viaOnLoad: take(
		`${F}/update-key-whose-index-segments-are-each-parent-or-host-parent-p`,
		"schema:UpdateCaseAction.update",
	),
	viaOnOpen: refuse(
		`${F}/an-update-key-with-an-index-segment-on-a-form-that-opens-its`,
		"schema:UpdateCaseAction.update",
	),
	viaUser: refuse(
		`${F}/update-key-whose-index-segments-include-user-each-parent-host-or`,
		"schema:UpdateCaseAction.update",
	),
	viaOther: refuse(
		`${F}/update-key-with-any-other-index-segment-or-user-where-the`,
		"schema:UpdateCaseAction.update",
	),
	ancestorUnknown: refuse(
		`${F}/index-path-through-a-case-type-the-app-does-not-fix`,
		"schema:UpdateCaseAction.update",
	),
	viaFacet: refuse(
		`${F}/update-key-name-or-owner-id-through-an-index-segment`,
		"schema:UpdateCaseAction.update",
	),
	locationKeys: refuse(
		`${F}/update-keys-location-id-hq-user-id`,
		"schema:UpdateCaseAction.update",
	),
	workerKey: refuse(
		`${F}/a-write-of-the-worker-s-record-to-a-key-no-worker-property-takes`,
		"schema:UpdateCaseAction.update",
	),
	locationChildKeys: refuse(
		`${F}/update-keys-location-id-hq-user-id`,
		"schema:OpenSubCaseAction.case_properties",
	),
	illegalKey: refuse(
		`${F}/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json`,
		"schema:UpdateCaseAction.update",
	),
	illegalChildKey: refuse(
		`${F}/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json`,
		"schema:OpenSubCaseAction.case_properties",
	),
	nonCoreKey: refuse(
		`${F}/update-key-holding-a-character-validate-property-accepts-that-is`,
		"schema:UpdateCaseAction.update",
	),
	nonCoreChildKey: refuse(
		`${F}/update-key-holding-a-character-validate-property-accepts-that-is`,
		"schema:OpenSubCaseAction.case_properties",
	),
	nonAsciiKey: refuse(
		`${F}/update-key-holding-a-non-ascii-core-name-character`,
		"schema:UpdateCaseAction.update",
	),
	nonAsciiChildKey: refuse(
		`${F}/update-key-holding-a-non-ascii-core-name-character`,
		"schema:OpenSubCaseAction.case_properties",
	),
	uploadQuestion: refuse(
		`${F}/update-from-an-upload-question-attachment-mode`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	notOffered: refuse(
		`${F}/a-case-write-name-or-preload-on-a-question-the-picker-does-not`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	datetimeStraight: refuse(
		`${F}/a-datetime-question-saved-straight-to-a-case`,
		null,
	),
	datetimeSibling: take(
		`${F}/update-from-a-date-and-time-question-through-a-hidden-sibling`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	datetimeJoin: take(
		`${F}/update-through-the-date-and-time-join-of-a-date-and-a-time`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	captureLink: take(
		`${F}/capture-link-write-a-hidden-value-whose-calculate-builds-hq-s`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	nameKey: take(
		`${F}/update-key-name`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	ownerKey: take(
		`${F}/update-key-owner-id`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	categoryStateKey: take(
		`${F}/update-keys-location-id-hq-user-id-category-state`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	/** A key of the own case's update in Nova's grammar that no row above names:
	 *  recorded at the map, where the key sits. */
	asciiKey: take(
		`${F}/update-key-whose-characters-after-the-ascii-first-are-all-core-s`,
		"schema:UpdateCaseAction.update",
	),
	undeclaredActions: refuse(
		`${F}/any-other-undeclared-key`,
		"schema:FormActions.<undeclared>",
	),

	closeCase: take(
		`${F}/form-requires-case-close-case`,
		"schema:FormActions.close_case",
	),
	closeAlways: take(
		`${F}/form-requires-case-close-case`,
		"schema:FormAction.condition",
	),
	closeBooleanTrue: take(
		`${F}/close-case-condition-if-operator-boolean-true-on-a-requires-case`,
		"schema:FormAction.condition",
	),
	closeCompared: take(
		`${F}/close-case-condition-if-operator-or-selected-on-a-select-hidden`,
		"schema:FormAction.condition",
	),
	registrationClose: take(
		`${F}/form-requires-none-open-case-close-case-active`,
		"schema:FormActions.close_case",
	),
	registrationCloseCondition: take(
		`${F}/form-requires-none-open-case-close-case-active`,
		"schema:FormAction.condition",
	),
	surveyClose: take(
		`${F}/form-requires-none-with-close-case-active-and-no-open-in-a-module-with-a`,
		"schema:FormActions.close_case",
	),
	multiSelectNoBlock: drop(
		`${F}/update-case-close-case-on-a-requires-case-form-that-does-not`,
		"schema:FormActions.update_case",
	),
	multiSelectNoClose: drop(
		`${F}/update-case-close-case-on-a-requires-case-form-that-does-not`,
		"schema:FormActions.close_case",
	),

	subcases: take(
		`${F}/subcases-child-case-relationship-child-type-a-module-case-type`,
		"schema:FormActions.subcases",
	),
	subcaseType: take(
		`${F}/subcases-child-case-relationship-child-type-a-module-case-type`,
		"schema:OpenSubCaseAction.case_type",
	),
	subcaseTypeUnknown: refuse(
		`${F}/subcase-type-not-any-module-s-case-type-and-not-commcare-user`,
		"schema:OpenSubCaseAction.case_type",
	),
	subcaseName: take(
		`${F}/subcases-case-properties-name-update`,
		"schema:OpenSubCaseAction.name_update",
	),
	subcaseProperties: take(
		`${F}/subcases-case-properties-name-update`,
		"schema:OpenSubCaseAction.case_properties",
	),
	subcaseQuestionPath: take(
		`${F}/subcases-case-properties-name-update`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	subcaseRepeat: take(
		`${F}/subcases-repeat-context`,
		"schema:OpenSubCaseAction.repeat_context",
	),
	subcaseRepeatOther: refuse(
		`${F}/subcases-repeat-context-other-than-the-name-question-s-innermost`,
		"schema:OpenSubCaseAction.repeat_context",
	),
	subcaseExtension: refuse(
		`${F}/subcases-relationship-extension`,
		"schema:OpenSubCaseAction.relationship",
	),
	subcaseReference: take(
		`${F}/subcases-reference-id-null-parent`,
		"schema:OpenSubCaseAction.reference_id",
	),
	subcaseReferenceOther: refuse(
		`${F}/subcases-reference-id-any-other-value`,
		"schema:OpenSubCaseAction.reference_id",
	),
	subcaseCondition: take(
		`${F}/subcases-condition-if`,
		"schema:OpenSubCaseAction.condition",
	),
	subcaseNever: refuse(
		`${F}/subcases-condition-never`,
		"schema:OpenSubCaseAction.condition",
	),
	subcaseClose: take(
		`${F}/subcases-close-condition-active`,
		"schema:OpenSubCaseAction.close_condition",
	),
	subcaseCloseNever: drop(
		`${F}/subcases-close-condition-never`,
		"schema:OpenSubCaseAction.close_condition",
	),
	subcasesUnshared: drop(
		`${F}/subcases-on-such-a-form-in-an-app-that-does-not-share-cases-or`,
		"schema:FormActions.subcases",
	),
	subcasesShared: refuse(
		`${F}/subcases-on-such-a-form-in-an-app-that-shares-cases-where-a`,
		"schema:FormActions.subcases",
	),

	usercase: take(
		`${F}/usercase-update-with-condition-always-or-if-read-as-always-xform`,
		"schema:FormActions.usercase_update",
	),
	usercaseCondition: take(
		`${F}/usercase-update-with-condition-always-or-if-read-as-always-xform`,
		"schema:UpdateCaseAction.condition",
	),
	usercaseUpdate: take(
		`${F}/usercase-update-with-condition-always-or-if-read-as-always-xform`,
		"schema:UpdateCaseAction.update",
	),
	usercaseQuestionPath: take(
		`${F}/usercase-update-with-condition-always-or-if-read-as-always-xform`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	usercaseSlash: refuse(
		`${F}/usercase-update-with-condition-always-or-if-a-key-containing`,
		"schema:UpdateCaseAction.update",
	),
	usercaseNever: drop(
		`${F}/usercase-update-with-condition-never`,
		"schema:FormActions.usercase_update",
	),

	referralInactive: drop(
		`${F}/referral-actions-inactive`,
		"schema:FormActions.open_referral",
	),
	referralWithType: drop(
		`${F}/open-referral-update-referral-or-close-referral-active-in-a-module-with-a`,
		"schema:FormActions.open_referral",
	),
	referralWithoutType: refuse(
		`${F}/open-referral-update-referral-or-close-referral-active-in-a-module-with-no`,
		"schema:FormActions.open_referral",
	),

	createNameRequired: drop(
		`${Q}/bind-required-on-the-question-that-names-a-created-case`,
		"xform:model/bind@required",
	),
});

/** The actions a form's type reads past where they are inactive, each claimed at its own key. */
export type InactiveAction =
	| "open_case"
	| "update_case"
	| "close_case"
	| "case_preload"
	| "usercase_preload"
	| "load_from_form";

const INACTIVE_ACTIONS: readonly InactiveAction[] = [
	"open_case",
	"update_case",
	"close_case",
	"case_preload",
	"usercase_preload",
	"load_from_form",
];

/** The rows of a held form type, by the name their inactive claims are registered under. */
const INACTIVE_ROWS = {
	registration: `${F}/form-requires-none-open-case-active-close-case-inactive`,
	conditionalRegistration: `${F}/form-requires-none-open-case-condition-if`,
	closingRegistration: `${F}/form-requires-none-open-case-close-case-active`,
	followup: `${F}/form-requires-case-no-close`,
	close: `${F}/form-requires-case-close-case`,
	survey: `${F}/form-requires-none-no-case-action`,
	closeWithoutOpen: `${F}/form-requires-none-with-close-case-active-and-no-open-in-a-module-with-a`,
} as const;

/**
 * The same form-type claims, by the action a row reads past where it is
 * inactive: each names the action's own key, so its record stands where the
 * action sits, and the keys inside the action stand under it there too
 * (`jsonCursor.ts`, a held claim that takes a value whole).
 */
const INACTIVE = defineClaims(
	"caseManagement.basicActions.inactive",
	Object.fromEntries(
		Object.entries(INACTIVE_ROWS).flatMap(([row, entry]) =>
			INACTIVE_ACTIONS.map((action) => [
				`${row}.${action}`,
				derived(entry, `schema:FormActions.${action}`),
			]),
		),
	) as Record<string, Claim<"derived">>,
);

/** The claim a row's entry reads past an inactive action under, by the row's entry and the action. */
type InactiveClaims = ReadonlyMap<InactiveAction, Claim<"derived">>;

const INACTIVE_BY_ENTRY: ReadonlyMap<string, InactiveClaims> = new Map(
	Object.entries(INACTIVE_ROWS).map(([row, entry]) => [
		entry,
		new Map(
			INACTIVE_ACTIONS.map((action) => [
				action,
				INACTIVE[`${row}.${action}`] as Claim<"derived">,
			]),
		),
	]),
);

/**
 * The keys an open action and an update action do not declare, read alike on
 * an action a stage visits and on one a held claim takes whole (an inactive
 * action, `jsonCursor.ts::registerUndeclaredKeys`): HQ's case management page
 * shapes `name_update_multi` and `update_multi`, which no build reads, and any
 * other is a key Nova cannot account for.
 */
const undeclaredOpenKey = registerUndeclaredKeys("OpenCaseAction", (key) =>
	key === "name_update_multi" || key === "update_multi"
		? BASIC_CLAIMS.updateMultiOpen
		: BASIC_CLAIMS.undeclaredOpen,
);
const undeclaredUpdateKey = registerUndeclaredKeys("UpdateCaseAction", (key) =>
	key === "update_multi"
		? BASIC_CLAIMS.updateMultiUpdate
		: BASIC_CLAIMS.undeclaredUpdate,
);

/** Claims each key `cursor`'s class does not declare under `rule`. */
function claimUndeclared(
	cursor: JsonCursor,
	rule: (key: string) => Claim<"drop" | "refuse"> | undefined,
): void {
	for (const key of cursor.undeclared()) {
		const claim = rule(key);
		if (claim === undefined) continue;
		if (claim.use === "refuse")
			cursor.refuse(key, claim as Claim<"refuse">, { name: key });
		else cursor.drop(key, claim as Claim<"drop">);
	}
}

/** The one register row the same-state rewrites of a basic form fall under. */
const CASE_SETTINGS_RESPELLED = "case-settings-respelled";

// ── What the first pass proposes ────────────────────────────────────────

/** A value a basic action reads: a question's answer, or a capture's link. */
export interface ProposedValue {
	readonly field: DraftField;
	readonly link: boolean;
}

interface ProposedWrite {
	readonly property: string;
	readonly value: ProposedValue;
	readonly via?: CaseWriteVia;
	readonly onlyIfChanged?: true;
}

/** A stored `FormActionCondition` and the scope `stateCondition` judges it in. */
export interface ProposedCondition {
	readonly stored: unknown;
	readonly own: boolean;
	readonly repeat: DraftField | undefined;
	/** The node it was read from, where a finding stands. */
	readonly place: HqPlace;
	/** Where the condition sits in the app's JSON. */
	readonly pointer: string;
}

export interface ProposedOperation {
	readonly uuid: Uuid;
	readonly id: string;
	readonly action: "own" | "create" | "close" | "update";
	readonly caseType?: string;
	readonly name?: ProposedValue;
	readonly owner?: ProposedValue;
	readonly writes: readonly ProposedWrite[];
	readonly condition?: ProposedCondition;
	readonly forEach?: DraftField;
	/** A child case's one link, to the form's own case. */
	readonly linksOwn?: boolean;
	readonly placement?: CasePlacement;
	/** A close: the create it closes. */
	readonly closes?: Uuid;
	readonly target?: "worker-record";
}

/** What the first pass read of one basic form. */
export interface BasicCaseReading {
	readonly type: FormType;
	readonly operations: readonly ProposedOperation[];
	readonly openCondition?: ProposedCondition;
	/** `match-all` for a registration that closes its case on every submission. */
	readonly closeCondition?: ProposedCondition | "match-all";
	/** Every condition `stateCondition` must state back, with the operation it belongs to. */
	readonly conditions: readonly {
		readonly condition: ProposedCondition;
		readonly slot: "open" | "close" | { readonly operation: Uuid };
	}[];
	/**
	 * The own arm of a form that loads its case and changes nothing of it here, which is not
	 * among `operations`: it claims its key and answers the operation where no Save to Case
	 * block of the form took the form's own case (`writeBasicOperations`), so a key is never
	 * claimed for an operation the document does not hold.
	 */
	readonly bareOwn?: () => ProposedOperation | undefined;
	/** The id `bareOwn`'s operation takes. */
	readonly bareOwnId?: string;
	/** The menu's case type, the own arm's. */
	readonly caseType: string;
	/**
	 * The questions a child case the reading refuses reads its name or its
	 * external id from. Nova's emitter conjoins its check onto such a question
	 * only while a case action reads it so (`lib/domain/caseScalarTextGuard.ts`),
	 * and the document leaves the refused child out, so the check the question
	 * carries stands under that child's finding, as a refused Save to Case
	 * block's does (`saveToCase.ts::scalarFieldsOfRefusedBlocks`).
	 */
	readonly refusedScalarFields: readonly DraftField[];
}

const READINGS = new WeakMap<DraftForm, BasicCaseReading>();
const ACTIONS = new WeakMap<
	DraftForm,
	{ readonly cursor: JsonCursor; readonly inactive: InactiveClaims }
>();

/** A question path through a Hidden Value's date-and-time sibling, claimed once
 *  the form is bound: under the join's row where the Hidden Value is the
 *  date-and-time join, else under `otherwise`. */
interface PendingJoin {
	readonly cursor: JsonCursor;
	readonly field: DraftField;
	readonly otherwise: Claim<"take">;
}

const JOINS = new WeakMap<DraftForm, PendingJoin[]>();

function deferJoinClaim(
	form: DraftForm,
	cursor: JsonCursor,
	field: DraftField,
	otherwise: Claim<"take">,
): void {
	const pending = JOINS.get(form) ?? [];
	pending.push({ cursor, field, otherwise });
	JOINS.set(form, pending);
}

/** `expression` with every form field read's spelling left out: the join
 *  Nova writes reads its two questions however the source spells the path. */
function withoutSpelling(expression: unknown): unknown {
	if (Array.isArray(expression)) return expression.map(withoutSpelling);
	if (typeof expression !== "object" || expression === null) return expression;
	const record = expression as Readonly<Record<string, unknown>>;
	return Object.fromEntries(
		Object.entries(record)
			.filter(([key]) => !(record.kind === "field" && key === "spelling"))
			.map(([key, value]) => [key, withoutSpelling(value)]),
	);
}

/**
 * Whether the Hidden Value `fieldUuid` of `formUuid` is the date-and-time
 * join the split writes (`lib/doc/datetimeSplit.ts`): its bound calculate is
 * `datePattern.ts::clockKeepingJoin` over a date question and a time question
 * of the same form. The bound calculate is the tree whose print the
 * expression stage compared with the source's own text, so this is the join
 * re-emitted and compared.
 */
export function isDatetimeJoin(
	doc: BlueprintDoc,
	formUuid: Uuid,
	fieldUuid: Uuid,
): boolean {
	const field = doc.fields[fieldUuid];
	if (field?.kind !== "hidden" || field.calculate === undefined) return false;
	const inForm = new Set<Uuid>();
	const walk = (parent: Uuid) => {
		for (const uuid of doc.fieldOrder[parent] ?? []) {
			inForm.add(uuid);
			walk(uuid);
		}
	};
	walk(formUuid);
	const reads: Uuid[] = [];
	walkExpressionTerms(field.calculate, (one) => {
		if (one.kind === "field") reads.push(one.uuid);
	});
	const [date, time] = [...new Set(reads)];
	if (
		date === undefined ||
		time === undefined ||
		!inForm.has(date) ||
		!inForm.has(time) ||
		doc.fields[date]?.kind !== "date" ||
		doc.fields[time]?.kind !== "time"
	)
		return false;
	const read = (uuid: Uuid): Expression => term(formField(uuid));
	return sameJson(
		withoutSpelling(field.calculate),
		withoutSpelling(clockKeepingJoin(read(date), read(time))),
	);
}

/** Claims each question path the first pass left for the bound form: a write
 *  through the date-and-time join under the join's row, any other under its own. */
export function settleDatetimeJoins(ctx: ReadContext, form: DraftForm): void {
	const pending = JOINS.get(form);
	if (pending === undefined) return;
	JOINS.delete(form);
	for (const { cursor, field, otherwise } of pending) {
		const joined =
			ctx.doc !== undefined &&
			field.uuid !== undefined &&
			isDatetimeJoin(ctx.doc, form.uuid, field.uuid);
		consume(
			cursor.take(
				"question_path",
				joined ? BASIC_CLAIMS.datetimeJoin : otherwise,
				(value) => value,
			),
		);
	}
}

/** The cursor over a basic form's `actions`, opened by the first pass, with
 *  the claim its type reads an inactive action under. */
export function actionsCursorOf(form: DraftForm): JsonCursor | undefined {
	return ACTIONS.get(form)?.cursor;
}

export function inactiveClaimOf(
	form: DraftForm,
	action: InactiveAction,
): Claim<"derived"> {
	const known = ACTIONS.get(form);
	if (known === undefined)
		throw new Error(
			"The preload reader was asked for a form whose case actions the first pass did not open. Read a form's preloads only after its basic actions.",
		);
	return inactiveClaim(known.inactive, action);
}

function inactiveClaim(
	claims: InactiveClaims,
	action: InactiveAction,
): Claim<"derived"> {
	const claim = claims.get(action);
	if (claim === undefined)
		throw new Error(
			`The reader holds no claim for an inactive ${action} under this form's type. Every held form type's row declares one for each action it reads past.`,
		);
	return claim;
}

/** The first pass's reading of `form`, where its actions read into one. */
export function basicCaseReading(
	form: DraftForm,
): BasicCaseReading | undefined {
	return READINGS.get(form);
}

/** Each basic form whose `requires` and `actions` the reading refused, by the refusal. */
const REFUSED_CASE_MANAGEMENT = new WeakMap<DraftForm, Claim<"refuse">>();

/**
 * The refusal of a basic form's case management, where the reading refused its `requires` and
 * `actions` (a form that requires a referral, a close with no case to close): its finding stands
 * at the form. Undefined for a form whose case management the reading holds.
 */
export function refusedCaseManagement(
	form: DraftForm,
): Claim<"refuse"> | undefined {
	return REFUSED_CASE_MANAGEMENT.get(form);
}

// ── Questions ────────────────────────────────────────────────────────────

/** The innermost repeat a field stands in. */
export function repeatOfField(field: DraftField): DraftField | undefined {
	for (let at = field.parent; at !== null; at = at.parent)
		if (at.kind === "repeat") return at;
	return undefined;
}

/** A question path of `form`, mapped through each generated node to the
 *  question it belongs to, as a path from the data root: two action lists
 *  compared by the questions their paths name. Null for no path. */
export function ownerQuestionPath(
	form: DraftForm,
	path: unknown,
): string | null {
	if (typeof path !== "string" || path === "") return null;
	const xform = form.xform;
	if (xform === null) return path;
	const root = xform.parsed.dataRoot.name;
	const relative = path.startsWith(`/${root}/`)
		? path.slice(root.length + 2)
		: path;
	const node = xform.nodes.get(relative);
	const role = node === undefined ? undefined : xform.roles.get(node);
	if (role?.kind === "generated") return role.owner.path.join("/");
	return relative;
}

/** A field's ids from the form's root. */
export function fieldIds(field: DraftField): string[] {
	const ids: string[] = [];
	for (let at: DraftField | null = field; at !== null; at = at.parent)
		ids.unshift(at.id);
	return ids;
}

/** The generated purposes an action names in the shape the emitter writes. */
function generatedShape(
	purpose: string,
	property: string,
	owner: DraftField | undefined,
): boolean {
	if (owner === undefined) return false;
	if (purpose === "trimmed")
		return property === "name" || property === "external_id";
	if (purpose === "url")
		return (captureFieldKinds as readonly string[]).includes(owner.kind);
	// A date-and-time question, or a Hidden Value that writes a date-and-time property.
	if (purpose === "datetime")
		return owner.kind === "datetime" || owner.kind === "hidden";
	return false;
}

function fieldOfNode(
	xform: ReadXForm,
	node: DataNode | null,
): DraftField | undefined {
	if (node === null) return undefined;
	const role = xform.roles.get(node);
	return role?.kind === "field" ? role.field : undefined;
}

export type QuestionValue =
	| {
			readonly kind: "value";
			readonly value: ProposedValue;
			readonly datetimeSibling: boolean;
	  }
	| { readonly kind: "finding"; readonly claim: Claim<"refuse"> };

/**
 * The value of a basic action that reads `path` for `property`: the question
 * at the path, or, through a node Nova's emitter generates beside a
 * question and names in that shape, the question it belongs to. A candidate
 * the action names in that shape is settled generated here; the first pass
 * settles every other one as the person's own question.
 */
export function questionValue(
	ctx: ReadContext,
	form: DraftForm,
	path: string,
	property: string,
): QuestionValue {
	const xform = form.xform;
	const relative = conditionQuestionPath(form, path);
	const node = relative === undefined ? undefined : xform?.nodes.get(relative);
	if (xform === null || xform === undefined || node === undefined)
		return { kind: "finding", claim: CONDITION_CLAIMS.noQuestion };
	const role = xform.roles.get(node);
	if (role?.kind === "generated-candidate" || role?.kind === "generated") {
		const owner = fieldOfNode(xform, role.owner);
		if (owner !== undefined && generatedShape(role.purpose, property, owner)) {
			// A candidate is settled the first time an action names it; a second
			// action naming it reads the same question.
			if (
				role.kind === "generated-candidate" &&
				xform.candidates.includes(node)
			)
				ctx.writeDraft(() => xform.settle(node, "generated"));
			return {
				kind: "value",
				value: { field: owner, link: role.purpose === "url" },
				datetimeSibling: role.purpose === "datetime",
			};
		}
		if (role.kind === "generated")
			return { kind: "finding", claim: BASIC_CLAIMS.notOffered };
		// Named in no shape the emitter writes: the person's own Hidden Value.
		if (xform.candidates.includes(node))
			ctx.writeDraft(() => xform.settle(node, "field"));
	}
	const settled = xform.roles.get(node);
	if (settled?.kind !== "field")
		return { kind: "finding", claim: BASIC_CLAIMS.notOffered };
	const field = settled.field;
	if (
		field.kind === "label" ||
		field.kind === "group" ||
		field.kind === "repeat" ||
		field.kind === "section"
	)
		return { kind: "finding", claim: BASIC_CLAIMS.notOffered };
	if ((captureFieldKinds as readonly string[]).includes(field.kind))
		return { kind: "finding", claim: BASIC_CLAIMS.uploadQuestion };
	// A date and time, a question's or a Hidden Value's its bind types
	// `xsd:dateTime`, named straight: HQ's build binds the leaf of the case block
	// that copies it with no type, so Core keeps the day alone there
	// (`Recalculate.wrapData` wraps a date of any other type as a date), while
	// Nova saves every date and time to a case through its `nova_datetime_`
	// sibling, which keeps the moment.
	if (field.kind === "datetime" || boundDateTime(form, field))
		return { kind: "finding", claim: BASIC_CLAIMS.datetimeStraight };
	return {
		kind: "value",
		value: { field, link: false },
		datetimeSibling: false,
	};
}

/** Whether `field` is a Hidden Value whose bind in `form`'s source is typed `xsd:dateTime`. */
export function boundDateTime(
	form: DraftForm,
	field: DraftField | undefined,
): boolean {
	if (field === undefined || field.kind !== "hidden") return false;
	const type = form.xform?.binds.get(field.node)?.type;
	if (type === undefined) return false;
	return (type.startsWith("xsd:") ? type.slice(4) : type) === "dateTime";
}

// ── Property names ───────────────────────────────────────────────────────

/** HQ's own property grammar without parents, as `helpers/validators.py::validate_property`
 *  runs it: Python's `\w` is every Unicode letter and digit, and `re.match` of a pattern
 *  ending in `$` also matches before one newline that ends the text, so a name followed by
 *  one newline passes (`'note\n'`), and one followed by two does not. */
export const HQ_PROPERTY = /^[a-zA-Z][\p{L}\p{N}_-]*\n?$/u;
/** The same grammar with parents (`validate_property`'s default, which
 *  `IndexedFormBaseValidator.check_case_properties` runs on every written and
 *  preloaded property): steps joined by `/`, one newline allowed only at the
 *  very end. */
export const HQ_PROPERTY_PATH =
	/^[a-zA-Z][\p{L}\p{N}_-]*(?:\/[a-zA-Z][\p{L}\p{N}_-]*)*\n?$/u;
/** The code point ranges of a name character of CommCare Core's XPath grammar (`localName`). */
const CORE_NAME_RANGES: readonly (readonly [number, number])[] = [
	[0x2d, 0x2e],
	[0x30, 0x39],
	[0x41, 0x5a],
	[0x5f, 0x5f],
	[0x61, 0x7a],
	[0xb7, 0xb7],
	[0xc0, 0xd6],
	[0xd8, 0xf6],
	[0xf8, 0x37d],
	[0x37f, 0x1fff],
	[0x200c, 0x200d],
	[0x203f, 0x2040],
	[0x2070, 0x218f],
	[0x2c00, 0x2fef],
	[0x3001, 0xd7ff],
	[0xf900, 0xfdcf],
	[0xfdf0, 0xfffd],
];

function isCoreNameCharacter(character: string): boolean {
	const code = character.codePointAt(0) ?? -1;
	return CORE_NAME_RANGES.some(([low, high]) => code >= low && code <= high);
}
/**
 * The row of a written property key (one step, no index) outside Nova's own
 * grammar (`casePropertyName.ts`), first match in HQ's rows; undefined for a
 * name Nova holds:
 *
 * - `illegal`: outside HQ's grammar, or one of HQ's own reserved words (its
 *   hyphenated `date-opened` and `external-id` among them), or `owner_id`,
 *   which Nova reads as the owner and never as a property;
 * - `non-core`: a character HQ's grammar takes that is none of Core's name
 *   characters. A name HQ's grammar passes for its one trailing newline is
 *   one: HQ's build writes the key as the update's element
 *   (`xform.py::make_case_elem`), which lxml refuses as no tag name
 *   (`ValueError`), so no build holds it;
 * - `non-ascii`: Core's name characters, one of them past ASCII;
 * - `too-long`: Nova's grammar past its length, which no row of HQ's names.
 *
 * A key of every surface that writes a property takes the same class: a basic
 * update's or child's, and an advanced load's or open action's.
 */
export type PropertyNameClass =
	| "illegal"
	| "non-core"
	| "non-ascii"
	| "too-long";

export function propertyNameClass(key: string): PropertyNameClass | undefined {
	if (
		AUTHORED_CASE_PROPERTY_NAME_PATTERN.test(key) &&
		!RESERVED_CASE_PROPERTIES.has(key) &&
		!HQ_CASE_RESERVED_WORDS.has(key)
	)
		return key.length > MAX_AUTHORED_CASE_PROPERTY_NAME_LENGTH
			? "too-long"
			: undefined;
	if (
		!HQ_PROPERTY.test(key) ||
		HQ_CASE_RESERVED_WORDS.has(key) ||
		RESERVED_CASE_PROPERTIES.has(key)
	)
		return "illegal";
	for (const character of key)
		if (!isCoreNameCharacter(character)) return "non-core";
	return "non-ascii";
}

/**
 * A key CommCare HQ's server stores apart from the case's properties once a
 * case block's `<update>` holds it: `location_id` becomes the case's own
 * location column and `hq_user_id` is also copied to its external id
 * (`form_processor/backends/sql/update_strategy.py::SqlCaseUpdateStrategy.
 * _apply_update_action`). Nova holds it nowhere
 * (`standardCaseProperties.ts::FORBIDDEN_CASE_WRITE_PROPERTIES`). Whether a
 * written key reaches `<update>` is `isServerDivertedWrite`'s.
 */
export function isServerDivertedKey(property: string): boolean {
	return property === "location_id" || property === "hq_user_id";
}

/** Each form's upload refs, collected once per parsed source. */
const UPLOAD_REFS = new WeakMap<ParsedXForm, ReadonlySet<string>>();

/** The `ref` of every `<upload>` under the form's body, as HQ's build collects
 *  them (`xform.py::XFormCaseBlock.is_attachment`: `.//{f}upload[@ref]` under
 *  `{h}body`). */
function uploadRefs(parsed: ParsedXForm): ReadonlySet<string> {
	const known = UPLOAD_REFS.get(parsed);
	if (known !== undefined) return known;
	const refs = new Set<string>();
	const walk = (element: Element, scope: NamespaceScope) => {
		for (const child of element.children) {
			if (!isTag(child)) continue;
			const own = scopeOf(child, scope);
			if (
				isElement(child, own, XFORMS_NS, "upload") &&
				Object.hasOwn(child.attribs, "ref")
			)
				refs.add(child.attribs.ref as string);
			walk(child, own);
		}
	};
	// The source's root element has no ancestor but the document.
	walk(parsed.body, scopeOf(parsed.body, scopeOf(parsed.html, new Map())));
	UPLOAD_REFS.set(parsed, refs);
	return refs;
}

/**
 * Whether HQ's build writes `property`, read from `questionPath`, into a case
 * block's `<update>` as a key its server stores apart (`isServerDivertedKey`).
 * Every action's keys go through `xform.py::XFormCaseBlock.add_case_updates`
 * (a basic update, a case above it, the worker's record, a child case, an
 * advanced load and an open action), which writes a key into `<update>`
 * unless its `question_path` is the `ref` of an `<upload>` in the form's
 * body (`is_attachment`, by the stored text), where the key names an
 * `<attachment>` instead and is no location or external id: that write is
 * the upload question's row (`BASIC_CLAIMS.uploadQuestion`), which reading
 * the value raises. The diverted key's row is
 * `update-keys-location-id-hq-user-id`, under the key of the map that holds it.
 */
export function isServerDivertedWrite(
	form: DraftForm,
	property: string,
	questionPath: unknown,
): boolean {
	return isServerDivertedKey(property) && !namesAttachment(form, questionPath);
}

/** Whether HQ's build writes an action's key read from `questionPath` as an
 *  `<attachment>` of the case block rather than into its `<update>`
 *  (`xform.py::XFormCaseBlock.is_attachment`: the `ref` of an `<upload>` in
 *  the form's body, by the stored text): the upload question's row
 *  (`BASIC_CLAIMS.uploadQuestion`), never a property's. */
export function namesAttachment(
	form: DraftForm,
	questionPath: unknown,
): boolean {
	const parsed = form.xform?.parsed;
	return (
		parsed !== undefined &&
		typeof questionPath === "string" &&
		uploadRefs(parsed).has(questionPath)
	);
}

/** The claim of a basic update's (`child` false) or child's property key
 *  outside Nova's grammar (`propertyNameClass`), under the key's own surface;
 *  `unrecognized` for one past Nova's length. */
function propertyNameFinding(
	key: string,
	child: boolean,
): Claim<"refuse"> | "unrecognized" | undefined {
	switch (propertyNameClass(key)) {
		case undefined:
			return undefined;
		case "too-long":
			return "unrecognized";
		case "illegal":
			return child ? BASIC_CLAIMS.illegalChildKey : BASIC_CLAIMS.illegalKey;
		case "non-core":
			return child ? BASIC_CLAIMS.nonCoreChildKey : BASIC_CLAIMS.nonCoreKey;
		case "non-ascii":
			return child ? BASIC_CLAIMS.nonAsciiChildKey : BASIC_CLAIMS.nonAsciiKey;
	}
}

// ── Case types an index reaches ─────────────────────────────────────────

/**
 * The case type each `(case type, index name)` reaches, as the app's links
 * say: a basic child case under its menu's case type, an advanced open
 * action's indices, and each menu's parent selection. Where nothing in the
 * app says what an index of a type reaches, the type the reading was told
 * Nova holds for it (`ReaderInput.knownCaseTypes`). Undefined where nothing
 * says, or two say different types.
 */
function indexTargets(
	ctx: ReadContext,
): (caseType: string, identifier: string) => string | undefined {
	const seen = new Map<string, Set<string>>();
	const note = (child: unknown, identifier: string, parent: unknown) => {
		if (
			typeof child !== "string" ||
			typeof parent !== "string" ||
			child === "" ||
			parent === ""
		)
			return;
		const key = `${child}\u0000${identifier}`;
		const types = seen.get(key) ?? new Set<string>();
		types.add(parent);
		seen.set(key, types);
	};
	for (const module of ctx.draft.modules) {
		const caseType = module.module.caseType;
		const parent = ctx.draft.modules.find(
			(other) => other.uuid === module.module.parentCaseModuleUuid,
		);
		if (parent !== undefined) note(caseType, "parent", parent.module.caseType);
		for (const form of module.forms) {
			const actions = form.json.peek("actions");
			if (!isJsonObject(actions)) continue;
			for (const subcase of Array.isArray(actions.subcases)
				? actions.subcases
				: []) {
				if (!isJsonObject(subcase)) continue;
				const reference = subcase.reference_id;
				note(
					subcase.case_type,
					typeof reference === "string" && reference !== ""
						? reference
						: "parent",
					caseType,
				);
			}
			const tags = new Map<string, unknown>();
			for (const list of [actions.load_update_cases, actions.open_cases])
				for (const action of Array.isArray(list) ? list : [])
					if (isJsonObject(action) && typeof action.case_tag === "string")
						tags.set(action.case_tag, action.case_type);
			for (const open of Array.isArray(actions.open_cases)
				? actions.open_cases
				: []) {
				if (!isJsonObject(open)) continue;
				for (const index of Array.isArray(open.case_indices)
					? open.case_indices
					: []) {
					if (!isJsonObject(index) || typeof index.tag !== "string") continue;
					const reference = index.reference_id;
					note(
						open.case_type,
						typeof reference === "string" && reference !== ""
							? reference
							: "parent",
						tags.get(index.tag),
					);
				}
			}
		}
	}
	const known = ctx.input.knownCaseTypes;
	return (caseType, identifier) => {
		const types = seen.get(`${caseType}\u0000${identifier}`);
		// Where the app fixes no type for the index, the one Nova holds for it.
		if (types === undefined)
			return known?.targetOf(caseType, identifier)?.caseType;
		return types?.size === 1 ? [...types][0] : undefined;
	};
}

const INDEX_TARGETS = new WeakMap<
	ReadContext,
	ReturnType<typeof indexTargets>
>();

/** The case type `identifier` reaches from a case of `caseType`. */
export function indexTarget(
	ctx: ReadContext,
	caseType: string,
	identifier: string,
): string | undefined {
	let known = INDEX_TARGETS.get(ctx);
	if (known === undefined) {
		known = indexTargets(ctx);
		INDEX_TARGETS.set(ctx, known);
	}
	return known(caseType, identifier);
}

/** The steps of an index path from `caseType`, each typed with the case type
 *  it reaches, as `relationDestination.ts::resolveRelationDestination` walks
 *  an ancestor step; and every type of the chain, `caseType` first. Undefined
 *  where the app fixes no type for a step. */
export function ancestorSteps(
	ctx: ReadContext,
	caseType: string,
	segments: readonly string[],
): { readonly steps: RelationStep[]; readonly types: string[] } | undefined {
	const steps: RelationStep[] = [];
	const types = [caseType];
	let at = caseType;
	for (const segment of segments) {
		const reached = indexTarget(ctx, at, segment);
		if (reached === undefined) return undefined;
		steps.push({ identifier: segment, throughCaseType: reached });
		types.push(reached);
		at = reached;
	}
	return { steps, types };
}

// ── The first pass ───────────────────────────────────────────────────────

interface FormReading {
	readonly ctx: ReadContext;
	readonly module: DraftModule;
	readonly form: DraftForm;
	readonly type: FormType;
	readonly caseType: string;
	readonly applied: boolean;
	/** The names a create reads: the questions whose bind's `required` is HQ's. */
	readonly createNames: DraftField[];
	/** The questions a child case the reading refuses reads its name or external id
	 *  from (`BasicCaseReading.refusedScalarFields`). */
	readonly refusedScalarFields: DraftField[];
}

function rewrite(ctx: ReadContext, entry: string, path: string): void {
	ctx.facts.sameStateRewrites.push({
		entry,
		path,
		register: CASE_SETTINGS_RESPELLED,
	});
}

/** A relation finding about the value at `pointer` in the app's JSON, recorded around it
 *  (`Accounting.findingAt`). */
function finding(
	ctx: ReadContext,
	claim: Claim<"refuse">,
	place: HqPlace,
	pointer: string,
	detail?: FindingDetail,
) {
	ctx.accounting.findingAt(claim, place, pointer, detail);
}

function consume<T>(admitted: Admitted<T>): T {
	return admitted.value;
}

/** An active condition whose question names no question of the form: its
 *  finding at the form. The condition's own key stays claimed under its row. */
/**
 * A condition's question that names nothing is its own finding. An answer the
 * source stores beside `boolean_true` is one HQ's build never reads
 * (`xform.py::XForm.action_relevance` writes the question's path alone), and
 * HQ's own starter apps store `"1"` there; Nova writes none, so the first
 * publish respells it, recorded at `pointer`, the condition's, under `entry`.
 */
function noteConditionQuestion(
	r: FormReading,
	condition: unknown,
	entry: string,
	pointer: string,
): void {
	if (
		conditionType(condition) === "if" &&
		conditionField(r.form, condition) === undefined
	)
		finding(r.ctx, CONDITION_CLAIMS.noQuestion, r.form.place, pointer);
	if (
		conditionType(condition) === "if" &&
		isJsonObject(condition) &&
		condition.operator === "boolean_true" &&
		condition.answer !== null &&
		condition.answer !== undefined
	)
		rewrite(r.ctx, entry, `${pointer}/answer`);
}

/** One entry of an update map refused under its key's class: the entry's
 *  cursor refused whole, so its question path and mode stand under the one
 *  finding, recorded at the map, where the map's key holds the entry's key. */
function refuseEntry(
	cursor: JsonCursor,
	claim: Claim<"refuse">,
	key: string,
): void {
	cursor.refuseMapEntry(claim, { name: key });
}

/** One entry of an update map no row names: `unrecognized` once at the form,
 *  under `name`, with every key of the entry covered by it. */
function unrecognizedEntry(
	r: FormReading,
	cursor: JsonCursor,
	name: string,
): void {
	const place = r.form.place;
	r.ctx.accounting.circumstance("unrecognized", place, { name });
	const raised = circumstanceFinding("unrecognized", place, { name });
	for (const key of ["question_path", "update_mode", ...cursor.undeclared()])
		r.ctx.accounting.cover({ json: cursor, key }, raised);
}

/**
 * The entry a question path that read into `read` is claimed under, by the
 * rows of "A question path" before the key's own row: a capture's link, a
 * date-and-time question's sibling, then `keyClaim` (the `name`, `owner_id`,
 * `category` and `state` keys), then `pathClaim`. A Hidden Value's
 * date-and-time sibling is `"join"`: whether its calculate is the
 * date-and-time join is known once the form is bound.
 */
function pathClaimOf(
	read: QuestionValue & { readonly kind: "value" },
	pathClaim: Claim<"take">,
	keyClaim: Claim<"take"> | undefined,
): Claim<"take"> | "join" {
	if (read.value.link) return BASIC_CLAIMS.captureLink;
	if (read.datetimeSibling)
		return read.value.field.kind === "hidden"
			? "join"
			: BASIC_CLAIMS.datetimeSibling;
	return keyClaim ?? pathClaim;
}

/** One `ConditionalCaseUpdate` of a write: its question path and its mode.
 *  `own` is a property write of a follow-up or close form's own case;
 *  `keyClaim` the row its key names, where one does. */
function readUpdate(
	r: FormReading,
	cursor: JsonCursor,
	property: string,
	own: boolean,
	pathClaim: Claim<"take">,
	keyClaim?: Claim<"take">,
): {
	readonly value?: ProposedValue;
	readonly onlyIfChanged?: true;
	readonly ok: boolean;
} {
	const path = cursor.peek("question_path");
	let onlyIfChanged: true | undefined;
	let ok = true;
	if (cursor.peek("update_mode") === "edit") {
		if (own) {
			consume(
				cursor.take("update_mode", BASIC_CLAIMS.editHeld, (value) => value),
			);
			if (r.applied) onlyIfChanged = true;
			else
				rewrite(
					r.ctx,
					BASIC_CLAIMS.editHeld.entry,
					`${cursor.pointer}/update_mode`,
				);
		} else if (r.applied) {
			cursor.refuse("update_mode", BASIC_CLAIMS.editNotHeld);
			ok = false;
		} else cursor.drop("update_mode", BASIC_CLAIMS.editNotApplied);
	}
	const read =
		typeof path === "string" && path !== ""
			? questionValue(r.ctx, r.form, path, property)
			: undefined;
	if (read === undefined || read.kind === "finding") {
		consume(cursor.take("question_path", pathClaim, (value) => value));
		finding(
			r.ctx,
			read?.claim ?? CONDITION_CLAIMS.noQuestion,
			r.form.place,
			`${cursor.pointer}/question_path`,
			{ name: property },
		);
		return { ok: false };
	}
	// A row that names the key by the map's own surface key (a key through the
	// cases above) stands at the map, where the key sits, and the question path
	// is then the update's own.
	const mapRow =
		keyClaim !== undefined && keyClaim.key !== pathClaim.key
			? keyClaim
			: undefined;
	const pathRow = mapRow === undefined ? keyClaim : undefined;
	if (mapRow !== undefined) cursor.holdMapEntry(mapRow);
	const claim = pathClaimOf(read, pathClaim, pathRow);
	if (claim === "join")
		deferJoinClaim(r.form, cursor, read.value.field, pathRow ?? pathClaim);
	else consume(cursor.take("question_path", claim, (value) => value));
	return {
		value: read.value,
		...(onlyIfChanged !== undefined && { onlyIfChanged }),
		ok,
	};
}

/** Whether a value's question stands where a slot in `repeat` reads it: in
 *  no repeat, or in that one. */
function valueInScope(
	value: ProposedValue,
	repeat: DraftField | undefined,
): boolean {
	const own = repeatOfField(value.field);
	return own === undefined || own === repeat;
}

/** The own case's `update_case.update` and the usercase's, read key by key. */
function readUpdateMap(
	r: FormReading,
	parent: JsonCursor,
	mapClaim: Claim<"take">,
	pathClaim: Claim<"take">,
	slot: "own" | "usercase",
): {
	readonly writes: ProposedWrite[];
	name?: ProposedValue;
	owner?: ProposedValue;
} {
	const out: {
		writes: ProposedWrite[];
		name?: ProposedValue;
		owner?: ProposedValue;
	} = {
		writes: [],
	};
	const stored = parent.peek("update");
	const values = parent.map("update", "ConditionalCaseUpdate", mapClaim);
	if (isJsonObject(stored))
		for (const [key, value] of Object.entries(stored))
			if (!isJsonObject(value))
				finding(
					r.ctx,
					BASIC_CLAIMS.bareString,
					r.form.place,
					`${parent.pointer}/update/${pointerToken(key)}`,
					{ name: key },
				);
	const loads = r.type === "followup" || r.type === "close";
	for (const [key, cursor] of values) {
		if (slot === "usercase") {
			if (key.includes("/")) {
				refuseEntry(cursor, BASIC_CLAIMS.usercaseSlash, key);
				continue;
			}
		}
		// HQ's validator holds the whole key, its index steps included, to its
		// grammar (`check_case_properties` → `validate_property`), so a key an
		// index step of which fails it is a key HQ's build refuses, never an
		// index path Nova may come to read.
		if (!HQ_PROPERTY_PATH.test(key)) {
			refuseEntry(cursor, BASIC_CLAIMS.illegalKey, key);
			continue;
		}
		const segments = key.split("/");
		const property = segments[segments.length - 1] as string;
		const indices = segments.slice(0, -1);
		let via: CaseWriteVia | undefined;
		if (slot === "own" && indices.length > 0) {
			const known = indices.every(
				(segment) => segment === "parent" || segment === "host",
			);
			if (!known) {
				const users = indices.every(
					(segment) =>
						segment === "parent" || segment === "host" || segment === "user",
				);
				refuseEntry(
					cursor,
					users ? BASIC_CLAIMS.viaUser : BASIC_CLAIMS.viaOther,
					key,
				);
				continue;
			}
			if (!loads) {
				refuseEntry(cursor, BASIC_CLAIMS.viaOnOpen, key);
				continue;
			}
			const steps = ancestorSteps(r.ctx, r.caseType, indices);
			if (steps === undefined) {
				refuseEntry(cursor, BASIC_CLAIMS.ancestorUnknown, key);
				continue;
			}
			via = steps.steps as CaseWriteVia;
			// The case above's name and owner: HQ's build writes `name` as that
			// case's `case_name` (`xform.py::XFormCaseBlock.add_case_updates`) and
			// `owner_id` as its owner, and Nova renames and gives an owner only to
			// the operation's own case.
			if (property === "name" || property === "owner_id") {
				refuseEntry(cursor, BASIC_CLAIMS.viaFacet, key);
				continue;
			}
		}
		// HQ's server stores these two elsewhere wherever a case block's
		// `<update>` holds them (`update_strategy.py::_apply_update_action`): the
		// form's own case's, a case's above it and the worker's record's alike.
		if (isServerDivertedWrite(r.form, property, cursor.peek("question_path"))) {
			refuseEntry(cursor, BASIC_CLAIMS.locationKeys, key);
			continue;
		}
		const facet =
			indices.length === 0 && (property === "name" || property === "owner_id");
		const categoryOrState = property === "category" || property === "state";
		if (!facet && !categoryOrState) {
			const named = propertyNameFinding(property, false);
			if (named === "unrecognized") {
				unrecognizedEntry(r, cursor, "schema:UpdateCaseAction.update");
				continue;
			}
			if (named !== undefined) {
				refuseEntry(cursor, named, key);
				continue;
			}
		}
		// The worker's record takes a write only to a worker property the reading
		// declares (`worldEntities.ts::holdsWorkerRecordWrite`): HQ's build writes
		// `name` as its `case_name` and `owner_id` as its owner, which HQ's
		// user-case sync writes over as it writes every key Nova keeps in step
		// with the worker's profile. A key read from an upload names an
		// attachment, which is the upload question's row.
		if (
			slot === "usercase" &&
			!holdsWorkerRecordWrite(property) &&
			!namesAttachment(r.form, cursor.peek("question_path"))
		) {
			refuseEntry(cursor, BASIC_CLAIMS.workerKey, key);
			continue;
		}
		const ownWrite = slot === "own" && loads && !facet && via === undefined;
		// The rows the own case's `update` names by its key: a key through the
		// cases above the loaded one is its own row's.
		const keyClaim =
			via !== undefined
				? BASIC_CLAIMS.viaOnLoad
				: slot !== "own" || indices.length > 0
					? undefined
					: property === "name" && r.type !== "registration"
						? BASIC_CLAIMS.nameKey
						: property === "owner_id"
							? BASIC_CLAIMS.ownerKey
							: categoryOrState
								? BASIC_CLAIMS.categoryStateKey
								: facet
									? undefined
									: BASIC_CLAIMS.asciiKey;
		const read = readUpdate(r, cursor, property, ownWrite, pathClaim, keyClaim);
		if (!read.ok || read.value === undefined) continue;
		// The own case and the worker's record are written once, from questions in no repeat.
		if (!valueInScope(read.value, undefined)) {
			finding(
				r.ctx,
				BASIC_CLAIMS.notOffered,
				r.form.place,
				`${cursor.pointer}/question_path`,
				{ name: key },
			);
			continue;
		}
		if (facet && property === "name") {
			if (r.type === "registration") {
				r.ctx.accounting.circumstance("unrecognized", r.form.place, {
					name: "schema:UpdateCaseAction.update",
				});
				continue;
			}
			out.name = read.value;
			continue;
		}
		if (facet && property === "owner_id") {
			out.owner = read.value;
			continue;
		}
		out.writes.push({
			property,
			value: read.value,
			...(via !== undefined && { via }),
			...(read.onlyIfChanged !== undefined && {
				onlyIfChanged: read.onlyIfChanged,
			}),
		});
	}
	claimUndeclared(parent, undeclaredUpdateKey);
	const conflicts = parent.peek("conflicts");
	if (
		isJsonObject(conflicts) &&
		Object.values(conflicts).some((value) => Array.isArray(value))
	)
		parent.refuse("conflicts", BASIC_CLAIMS.updateConflicts);
	return out;
}

/** Mints one operation's UUID from its place in the form. */
function mint(
	r: FormReading,
	place: CaseOperationPlaceKey,
	action: CaseOperation["action"],
	n: number,
): Uuid | undefined {
	return r.ctx.accounting.identity(
		r.ctx.resolver.claim(
			externalKey.caseOperation(r.form.xmlns, place, action, n),
			whereText(r.form.place),
		),
		r.form.place,
		"schema:Form.actions",
	);
}

/**
 * Reads `form.actions` of a basic form into its type and its proposed case
 * operations, claiming every key. Writes the form's type into the draft;
 * the operations wait for the form's fields (`writeBasicOperations`).
 */
export function readBasicActions(
	ctx: ReadContext,
	module: DraftModule,
	form: DraftForm,
): void {
	const json = form.json;
	const stored = json.peek("actions");
	const actions = isJsonObject(stored) ? stored : {};
	const requires = json.peek("requires") ?? "none";
	const active = activeActions(actions, requires);
	const openCase = isJsonObject(actions.open_case) ? actions.open_case : {};
	const menu = {
		case_details: module.json.peek("case_details"),
		search_config: module.json.peek("search_config"),
	};
	const multi = isMultiSelectMenu(menu);
	const registry = menuMayLoadRegistryCase(menu);
	const row = formTypeRow(
		requires,
		active,
		conditionType(openCase.condition),
		module,
		!multi && !registry,
	);
	if (row.kind === "finding") {
		json.refuse("requires", row.requires);
		json.refuse("actions", row.actions);
		REFUSED_CASE_MANAGEMENT.set(form, row.requires);
		// A form that requires a referral chooses a case as a follow-up does
		// (`FormBase.requires`), so its logic binds over the case it reads, and
		// a read of that case stands under this one finding.
		if (requires !== "none")
			ctx.writeDraft(() => {
				form.form.type = "followup";
			});
		return;
	}
	consume(json.take("requires", row.requires, (value) => value));
	ctx.writeDraft(() => {
		form.form.type = row.type;
	});
	const A = json.object("actions", "FormActions", row.actions);
	const inactive = INACTIVE_BY_ENTRY.get(row.actions.entry) as InactiveClaims;
	ACTIONS.set(form, { cursor: A, inactive });
	const caseType = module.module.caseType ?? "";
	const r: FormReading = {
		ctx,
		module,
		form,
		type: row.type,
		caseType,
		applied: ctx.input.saveOnlyEditedApplied === true,
		createNames: [],
		refusedScalarFields: [],
	};
	const opens = active.has("open_case");
	const loads = row.type === "followup" || row.type === "close";
	// HQ's build writes a form's update, close and child cases only here
	// (`xform.py::XForm._create_casexml`, `default_case_management`).
	const defaultCaseManagement = (!multi && !registry) || opens;
	// A form of a menu that selects several cases has no own block: its own
	// case's change is a Save to Case block of each selected case
	// (`saveToCase.ts::withSeveralCaseOwn`).
	const ownBlock = opens || (loads && defaultCaseManagement);

	const operations: ProposedOperation[] = [];
	const conditions: BasicCaseReading["conditions"][number][] = [];
	const counts = new Map<string, number>();
	const ordinal = (place: CaseOperationPlaceKey, action: string) => {
		const key = JSON.stringify([place, action]);
		const n = counts.get(key) ?? 0;
		counts.set(key, n + 1);
		return n;
	};
	const takenIds = new Set<string>();
	const operationId = (type: string) => {
		const id = ownCaseOperationId(type, takenIds);
		takenIds.add(id);
		return id;
	};

	// The own case.
	let ownName: ProposedValue | undefined;
	let ownOwner: ProposedValue | undefined;
	const ownWrites: ProposedWrite[] = [];
	let openCondition: ProposedCondition | undefined;
	let closeCondition: ProposedCondition | "match-all" | undefined;

	if (opens && requires === "none") {
		const O = A.object("open_case", "OpenCaseAction", BASIC_CLAIMS.openCase);
		const conditionClaim =
			row.actions.entry ===
			FORM_TYPE_CLAIMS.conditionalRegistrationActions.entry
				? BASIC_CLAIMS.openConditionalCondition
				: row.actions.entry ===
						FORM_TYPE_CLAIMS.closingRegistrationActions.entry
					? BASIC_CLAIMS.openClosingCondition
					: BASIC_CLAIMS.openRegistrationCondition;
		const condition = consume(
			O.take("condition", conditionClaim, (value) => value),
		);
		noteConditionQuestion(
			r,
			condition,
			conditionClaim.entry,
			`${O.pointer}/condition`,
		);
		if (conditionType(condition) === "if") {
			const field = conditionField(form, condition);
			openCondition = {
				stored: condition,
				own: true,
				repeat: undefined,
				place: field?.place ?? form.place,
				pointer: `${O.pointer}/condition`,
			};
		}
		const nameUpdate = consume(
			O.take("name_update", BASIC_CLAIMS.nameUpdate, (value) => value),
		);
		if (isJsonObject(nameUpdate)) {
			if (nameUpdate.update_mode === "edit")
				rewrite(
					ctx,
					BASIC_CLAIMS.nameUpdate.entry,
					`${O.pointer}/name_update/update_mode`,
				);
			const path = nameUpdate.question_path;
			if (typeof path === "string" && path !== "") {
				const read = questionValue(ctx, form, path, "name");
				const at = `${O.pointer}/name_update/question_path`;
				if (read.kind === "finding")
					finding(ctx, read.claim, form.place, at, { name: "name" });
				else if (repeatOfField(read.value.field) !== undefined)
					finding(ctx, BASIC_CLAIMS.notOffered, form.place, at, {
						name: "name",
					});
				else {
					ownName = read.value;
					r.createNames.push(read.value.field);
				}
			}
		}
		const external = O.peek("external_id");
		if (typeof external === "string" && external !== "") {
			consume(
				O.take("external_id", BASIC_CLAIMS.externalIdActive, (value) => value),
			);
			rewrite(
				ctx,
				BASIC_CLAIMS.externalIdActive.entry,
				`${O.pointer}/external_id`,
			);
			const read = questionValue(ctx, form, external, "external_id");
			if (read.kind === "finding")
				finding(ctx, read.claim, form.place, `${O.pointer}/external_id`, {
					name: "external_id",
				});
			else ownWrites.push({ property: "external_id", value: read.value });
		}
		if (
			Array.isArray(O.peek("conflicts")) &&
			(O.peek("conflicts") as unknown[]).length > 0
		)
			O.refuse("conflicts", BASIC_CLAIMS.openConflicts);
		claimUndeclared(O, undeclaredOpenKey);
	} else if (
		opens ||
		(requires === "case" &&
			(conditionType(openCase.condition) === "if" ||
				conditionType(openCase.condition) === "always"))
	)
		// `activeActions` leaves an open action out on a form that requires a
		// case; HQ's build never reads it there.
		A.drop("open_case", BASIC_CLAIMS.openOnFollowup);
	else if (
		typeof openCase.external_id === "string" &&
		openCase.external_id !== ""
	)
		A.drop("open_case", BASIC_CLAIMS.externalIdInactive);
	else A.derived("open_case", inactiveClaim(inactive, "open_case"));

	// `update_case`.
	const update = isJsonObject(actions.update_case) ? actions.update_case : {};
	const updateType = conditionType(update.condition);
	if (row.type === "survey")
		A.derived("update_case", inactiveClaim(inactive, "update_case"));
	else if (loads && !defaultCaseManagement) {
		if (updateType === "never") {
			// HQ writes no primary block here under either word; Nova writes `always`.
			const U = A.object(
				"update_case",
				"UpdateCaseAction",
				BASIC_CLAIMS.updateNeverMulti,
			);
			consume(
				U.take(
					"condition",
					BASIC_CLAIMS.updateNeverMultiCondition,
					(value) => value,
				),
			);
			if (U.used("update")) U.drop("update", BASIC_CLAIMS.updateMapUnderNever);
			rewrite(
				ctx,
				BASIC_CLAIMS.updateNeverMulti.entry,
				`${A.pointer}/update_case/condition`,
			);
		} else A.drop("update_case", BASIC_CLAIMS.multiSelectNoBlock);
	} else {
		const others = [...active].some((type) => type !== "update_case");
		let claims:
			| { container: Claim<"take">; condition?: Claim<"take"> }
			| undefined;
		if (updateType === "always")
			claims = {
				container: BASIC_CLAIMS.updateAlways,
				condition: BASIC_CLAIMS.updateAlwaysCondition,
			};
		else if (updateType === "if") {
			if (conditionField(form, update.condition) === undefined) {
				A.refuse("update_case", BASIC_CLAIMS.updateIfGone);
			} else {
				claims = {
					container: BASIC_CLAIMS.updateIf,
					condition: BASIC_CLAIMS.updateIfCondition,
				};
				rewrite(
					ctx,
					BASIC_CLAIMS.updateIf.entry,
					`${A.pointer}/update_case/condition`,
				);
			}
		} else if (row.type === "registration") {
			claims = {
				container: BASIC_CLAIMS.updateNeverRegistration,
				condition: BASIC_CLAIMS.updateNeverRegistrationCondition,
			};
			rewrite(
				ctx,
				BASIC_CLAIMS.updateNeverRegistration.entry,
				`${A.pointer}/update_case/condition`,
			);
		} else if (others) {
			claims = {
				container: BASIC_CLAIMS.updateNeverWithOthers,
				condition: BASIC_CLAIMS.updateNeverWithOthersCondition,
			};
			rewrite(
				ctx,
				BASIC_CLAIMS.updateNeverWithOthers.entry,
				`${A.pointer}/update_case/condition`,
			);
		} else A.refuse("update_case", BASIC_CLAIMS.updateNeverAlone);
		if (claims !== undefined) {
			const U = A.object("update_case", "UpdateCaseAction", claims.container);
			if (claims.condition !== undefined)
				consume(U.take("condition", claims.condition, (value) => value));
			if (updateType === "always" || updateType === "if") {
				const read = readUpdateMap(
					r,
					U,
					BASIC_CLAIMS.updateMap,
					BASIC_CLAIMS.questionPath,
					"own",
				);
				ownWrites.push(...read.writes);
				if (read.name !== undefined) ownName = read.name;
				if (read.owner !== undefined) ownOwner = read.owner;
			} else if (U.used("update"))
				U.drop("update", BASIC_CLAIMS.updateMapUnderNever);
		}
	}

	// `close_case`.
	const close = isJsonObject(actions.close_case) ? actions.close_case : {};
	if (active.has("close_case")) {
		if (loads && !defaultCaseManagement)
			A.drop("close_case", BASIC_CLAIMS.multiSelectNoClose);
		else if (row.type === "survey")
			consume(A.take("close_case", BASIC_CLAIMS.surveyClose, (value) => value));
		else {
			const registration = row.type === "registration";
			const C = A.object(
				"close_case",
				"FormAction",
				registration ? BASIC_CLAIMS.registrationClose : BASIC_CLAIMS.closeCase,
			);
			const type = conditionType(close.condition);
			const operator = isJsonObject(close.condition)
				? close.condition.operator
				: undefined;
			const claim = registration
				? BASIC_CLAIMS.registrationCloseCondition
				: type === "always"
					? BASIC_CLAIMS.closeAlways
					: operator === "boolean_true"
						? BASIC_CLAIMS.closeBooleanTrue
						: BASIC_CLAIMS.closeCompared;
			const condition = consume(C.take("condition", claim, (value) => value));
			noteConditionQuestion(
				r,
				condition,
				claim.entry,
				`${C.pointer}/condition`,
			);
			if (type === "if") {
				const field = conditionField(form, condition);
				closeCondition = {
					stored: condition,
					own: true,
					repeat: undefined,
					place: field?.place ?? form.place,
					pointer: `${C.pointer}/condition`,
				};
			} else if (registration) closeCondition = "match-all";
		}
	} else A.derived("close_case", inactiveClaim(inactive, "close_case"));

	// The own arm. One that opens nothing and carries nothing is the form's own case only
	// where no Save to Case block takes it (`saveToCase.ts`, `ownTaken`), which is known once
	// the blocks are read, so its key is claimed when the operations are written.
	let ownUuid: Uuid | undefined;
	let bareOwn: BasicCaseReading["bareOwn"];
	let bareOwnId: string | undefined;
	const ownPlace: CaseOperationPlaceKey = ["basic", "own"];
	if (
		caseType !== "" &&
		row.type !== "survey" &&
		ownBlock &&
		!opens &&
		ownName === undefined &&
		ownOwner === undefined &&
		ownWrites.length === 0
	) {
		const id = operationId(caseType);
		bareOwnId = id;
		bareOwn = () => {
			const uuid = mint(r, ownPlace, "own", ordinal(ownPlace, "own"));
			return uuid === undefined
				? undefined
				: {
						uuid,
						id: READINGS.get(form)?.bareOwnId ?? id,
						action: "own",
						writes: [],
						placement: { kind: "basic", slot: "own" },
					};
		};
	} else if (caseType !== "" && row.type !== "survey" && (ownBlock || opens)) {
		const place = ownPlace;
		ownUuid = mint(r, place, "own", ordinal(place, "own"));
		if (ownUuid !== undefined)
			operations.push({
				uuid: ownUuid,
				id: operationId(caseType),
				action: "own",
				...(ownName !== undefined && { name: ownName }),
				...(ownOwner !== undefined && { owner: ownOwner }),
				writes: ownWrites,
				placement: { kind: "basic", slot: "own" },
			});
	}
	if (openCondition !== undefined)
		conditions.push({ condition: openCondition, slot: "open" });
	if (closeCondition !== undefined && closeCondition !== "match-all")
		conditions.push({ condition: closeCondition, slot: "close" });

	// `subcases`.
	const storedSubcases = Array.isArray(actions.subcases)
		? actions.subcases
		: [];
	if (storedSubcases.length > 0) {
		if (!defaultCaseManagement) {
			const sharing = ctx.app.peek("case_sharing") === true;
			if (sharing) A.refuse("subcases", BASIC_CLAIMS.subcasesShared);
			else {
				A.drop("subcases", BASIC_CLAIMS.subcasesUnshared);
				ctx.facts.childCasesUnread.push(form.xmlns);
			}
		} else
			readSubcases(
				r,
				A,
				storedSubcases,
				ownUuid,
				operations,
				conditions,
				ordinal,
				operationId,
			);
	}

	// `usercase_update`.
	const usercase = isJsonObject(actions.usercase_update)
		? actions.usercase_update
		: {};
	if (active.has("usercase_update")) {
		const W = A.object(
			"usercase_update",
			"UpdateCaseAction",
			BASIC_CLAIMS.usercase,
		);
		consume(
			W.take("condition", BASIC_CLAIMS.usercaseCondition, (value) => value),
		);
		const read = readUpdateMap(
			r,
			W,
			BASIC_CLAIMS.usercaseUpdate,
			BASIC_CLAIMS.usercaseQuestionPath,
			"usercase",
		);
		if (read.writes.length > 0) {
			const place: CaseOperationPlaceKey = ["basic", "usercase"];
			const uuid = mint(r, place, "update", ordinal(place, "update"));
			if (uuid !== undefined)
				operations.push({
					uuid,
					id: operationId("commcare-user"),
					action: "update",
					caseType: "commcare-user",
					target: "worker-record",
					writes: read.writes,
					placement: { kind: "basic", slot: "usercase" },
				});
		}
	} else if (conditionType(usercase.condition) === "never")
		A.drop("usercase_update", BASIC_CLAIMS.usercaseNever);

	// The referral actions, which no build reads.
	for (const key of [
		"open_referral",
		"update_referral",
		"close_referral",
		"referral_preload",
	]) {
		const action = actions[key];
		const used = isJsonObject(action)
			? key === "referral_preload"
				? isJsonObject(action.preload) && Object.keys(action.preload).length > 0
				: conditionType(action.condition) === "if" ||
					conditionType(action.condition) === "always"
			: false;
		if (!used) A.drop(key, BASIC_CLAIMS.referralInactive);
		else if (caseType !== "") A.drop(key, BASIC_CLAIMS.referralWithType);
		else A.refuse(key, BASIC_CLAIMS.referralWithoutType);
	}
	for (const key of A.undeclared())
		A.refuse(key, BASIC_CLAIMS.undeclaredActions, { name: key });

	// The question that names a created case: HQ's build writes its bind's
	// `required` whatever the source holds.
	claimCreateNameRequired(r);

	READINGS.set(form, {
		type: row.type,
		operations,
		...(openCondition !== undefined && { openCondition }),
		...(closeCondition !== undefined && { closeCondition }),
		conditions,
		...(bareOwn !== undefined && { bareOwn, bareOwnId }),
		caseType,
		refusedScalarFields: r.refusedScalarFields,
	});
}

/**
 * Names `form`'s Case Management operations past `carried`, the ids the
 * form's Save to Case blocks carry. A block carries its operation's id as its
 * element name, and HQ's form actions name no operation, so each operation a
 * slot keeps takes its case type's id free among the carried ones and those
 * named before it, in the order the slots are read: the own arm, each child
 * case and the close that shares its place, the worker's record. That is the
 * id `assemble.ts`'s `basic-slot-operation-ids-are-derived` gives it.
 */
export function nameBasicOperationsPast(
	form: DraftForm,
	carried: ReadonlySet<string>,
): void {
	const reading = READINGS.get(form);
	if (reading === undefined || carried.size === 0) return;
	const taken = new Set(carried);
	const next = (caseType: string) => {
		const id = ownCaseOperationId(caseType, taken);
		taken.add(id);
		return id;
	};
	const bareOwnId =
		reading.bareOwnId === undefined ? undefined : next(reading.caseType);
	const operations = reading.operations.map((one) => ({
		...one,
		id: next(one.caseType ?? reading.caseType),
	}));
	READINGS.set(form, {
		...reading,
		operations,
		...(bareOwnId !== undefined && { bareOwnId }),
	});
}

function readSubcases(
	r: FormReading,
	A: JsonCursor,
	stored: readonly unknown[],
	ownUuid: Uuid | undefined,
	operations: ProposedOperation[],
	conditions: BasicCaseReading["conditions"][number][],
	ordinal: (place: CaseOperationPlaceKey, action: string) => number,
	operationId: (type: string) => string,
): void {
	const { ctx, form } = r;
	const moduleTypes = new Set(
		ctx.draft.modules.flatMap((module) =>
			module.module.caseType ? [module.module.caseType] : [],
		),
	);
	const perRepeat = new Map<string, number>();
	for (const subcase of stored) {
		const context =
			isJsonObject(subcase) && typeof subcase.repeat_context === "string"
				? subcase.repeat_context
				: "";
		perRepeat.set(context, (perRepeat.get(context) ?? 0) + 1);
	}
	const cursors = A.list(
		"subcases",
		"OpenSubCaseAction",
		BASIC_CLAIMS.subcases,
	);
	cursors.forEach((S, index) => {
		const subcase = stored[index] as Record<string, unknown>;
		const conditionStored = S.peek("condition");
		const type = conditionType(conditionStored);
		// A child case that never opens is one cause, whatever else the entry
		// holds: HQ's build reads every entry (`FormActions.get_subcases` keeps
		// it, `Form.active_actions` drops no entry of a non-empty list) and
		// writes its block with a create whose relevance is `false()`
		// (`xform.py::XForm._create_casexml`, `action_relevance`), which Nova
		// writes in no shape. Removing the child case on HQ's Case Management
		// page removes all of it, so the entry is refused once, whole.
		if (type === "never") {
			S.refuseWhole(BASIC_CLAIMS.subcaseNever);
			// The check Nova's emitter conjoins onto the question that names the
			// child, and onto the one its external id reads, stands under this
			// finding too.
			const properties = isJsonObject(subcase.case_properties)
				? subcase.case_properties
				: {};
			const scalars: [unknown, string][] = [
				[subcase.name_update, "name"],
				[properties.external_id, "external_id"],
			];
			for (const [update, property] of scalars) {
				const path = isJsonObject(update) ? update.question_path : undefined;
				const read =
					typeof path === "string" && path !== ""
						? questionValue(ctx, form, path, property)
						: undefined;
				if (read?.kind === "value")
					r.refusedScalarFields.push(read.value.field);
			}
			return;
		}
		let ok = true;
		const caseType = S.peek("case_type");
		if (typeof caseType !== "string" || !moduleTypes.has(caseType)) {
			S.refuse("case_type", BASIC_CLAIMS.subcaseTypeUnknown);
			ok = false;
		} else
			consume(S.take("case_type", BASIC_CLAIMS.subcaseType, (value) => value));
		if (S.peek("relationship") === "extension") {
			S.refuse("relationship", BASIC_CLAIMS.subcaseExtension);
			ok = false;
		}
		const reference = S.peek("reference_id");
		if (
			reference === null ||
			reference === undefined ||
			reference === "" ||
			reference === "parent"
		) {
			consume(
				S.take("reference_id", BASIC_CLAIMS.subcaseReference, (value) => value),
			);
			if (reference === "parent")
				rewrite(
					ctx,
					BASIC_CLAIMS.subcaseReference.entry,
					`${S.pointer}/reference_id`,
				);
		} else {
			S.refuse("reference_id", BASIC_CLAIMS.subcaseReferenceOther);
			ok = false;
		}
		consume(
			S.take("condition", BASIC_CLAIMS.subcaseCondition, (value) => value),
		);
		noteConditionQuestion(
			r,
			conditionStored,
			BASIC_CLAIMS.subcaseCondition.entry,
			`${S.pointer}/condition`,
		);

		// The name and the writes.
		const nameUpdate = consume(
			S.take("name_update", BASIC_CLAIMS.subcaseName, (value) => value),
		);
		let name: ProposedValue | undefined;
		if (isJsonObject(nameUpdate)) {
			if (nameUpdate.update_mode === "edit")
				rewrite(
					ctx,
					BASIC_CLAIMS.subcaseName.entry,
					`${S.pointer}/name_update/update_mode`,
				);
			const path = nameUpdate.question_path;
			if (typeof path === "string" && path !== "") {
				const read = questionValue(ctx, form, path, "name");
				if (read.kind === "finding") {
					finding(
						ctx,
						read.claim,
						form.place,
						`${S.pointer}/name_update/question_path`,
						{ name: "name" },
					);
					ok = false;
				} else name = read.value;
			}
		}
		if (name === undefined) {
			finding(
				ctx,
				CONDITION_CLAIMS.noQuestion,
				form.place,
				`${S.pointer}/name_update/question_path`,
				{ name: "name" },
			);
			ok = false;
		}
		const nameRepeat =
			name === undefined ? undefined : repeatOfField(name.field);
		const context = S.peek("repeat_context");
		let repeat: DraftField | undefined;
		if (typeof context === "string" && context !== "") {
			if (
				nameRepeat !== undefined &&
				repeatAtPath(form, context) === nameRepeat
			) {
				consume(
					S.take(
						"repeat_context",
						BASIC_CLAIMS.subcaseRepeat,
						(value) => value,
					),
				);
				repeat = nameRepeat;
			} else {
				S.refuse("repeat_context", BASIC_CLAIMS.subcaseRepeatOther);
				ok = false;
			}
		} else if (nameRepeat !== undefined) {
			finding(
				ctx,
				BASIC_CLAIMS.notOffered,
				form.place,
				`${S.pointer}/name_update/question_path`,
				{ name: "name" },
			);
			ok = false;
		} else {
			// A blank context names the root, where a name question in no repeat stands.
			consume(
				S.take("repeat_context", BASIC_CLAIMS.subcaseRepeat, (value) => value),
			);
		}
		const writes: ProposedWrite[] = [];
		let owner: ProposedValue | undefined;
		const properties = S.map(
			"case_properties",
			"ConditionalCaseUpdate",
			BASIC_CLAIMS.subcaseProperties,
		);
		for (const [key, cursor] of properties) {
			if (key.includes("/")) {
				refuseEntry(cursor, BASIC_CLAIMS.illegalChildKey, key);
				ok = false;
				continue;
			}
			if (isServerDivertedWrite(r.form, key, cursor.peek("question_path"))) {
				refuseEntry(cursor, BASIC_CLAIMS.locationChildKeys, key);
				ok = false;
				continue;
			}
			const named =
				key === "owner_id" ? undefined : propertyNameFinding(key, true);
			if (named === "unrecognized") {
				unrecognizedEntry(
					r,
					cursor,
					"schema:OpenSubCaseAction.case_properties",
				);
				ok = false;
				continue;
			}
			if (named !== undefined) {
				refuseEntry(cursor, named, key);
				ok = false;
				continue;
			}
			const read = readUpdate(
				r,
				cursor,
				key,
				false,
				BASIC_CLAIMS.subcaseQuestionPath,
			);
			if (!read.ok || read.value === undefined) {
				ok = false;
				continue;
			}
			if (!valueInScope(read.value, repeat)) {
				finding(
					ctx,
					BASIC_CLAIMS.notOffered,
					form.place,
					`${cursor.pointer}/question_path`,
					{ name: key },
				);
				ok = false;
				continue;
			}
			if (key === "owner_id") owner = read.value;
			else writes.push({ property: key, value: read.value });
		}
		const closeStored = S.peek("close_condition");
		const closeType = conditionType(closeStored);
		if (closeType === "never")
			S.drop("close_condition", BASIC_CLAIMS.subcaseCloseNever);
		else {
			consume(
				S.take("close_condition", BASIC_CLAIMS.subcaseClose, (value) => value),
			);
			noteConditionQuestion(
				r,
				closeStored,
				BASIC_CLAIMS.subcaseClose.entry,
				`${S.pointer}/close_condition`,
			);
		}
		if (!ok || name === undefined || typeof caseType !== "string") {
			if (name !== undefined) r.refusedScalarFields.push(name.field);
			for (const write of writes)
				if (write.property === "external_id")
					r.refusedScalarFields.push(write.value.field);
			return;
		}
		r.createNames.push(name.field);

		const shared =
			(perRepeat.get(
				typeof subcase.repeat_context === "string"
					? subcase.repeat_context
					: "",
			) ?? 0) > 1;
		const placement: CasePlacement =
			repeat === undefined || shared
				? { kind: "basic", slot: "subcase", index }
				: { kind: "basic", slot: "subcase-row" };
		const place: CaseOperationPlaceKey =
			placement.kind === "basic" && placement.slot === "subcase-row"
				? ["basic", "subcase-row", fieldIds(repeat as DraftField)]
				: ["basic", "subcase", index];
		const uuid = mint(r, place, "create", ordinal(place, "create"));
		if (uuid === undefined) return;
		const condition: ProposedCondition | undefined =
			type === "if"
				? {
						stored: conditionStored,
						own: false,
						repeat,
						place: conditionField(form, conditionStored)?.place ?? form.place,
						pointer: `${S.pointer}/condition`,
					}
				: undefined;
		operations.push({
			uuid,
			id: operationId(caseType),
			action: "create",
			caseType,
			name,
			...(owner !== undefined && { owner }),
			writes,
			...(condition !== undefined && { condition }),
			...(repeat !== undefined && { forEach: repeat }),
			linksOwn: ownUuid !== undefined || r.type !== "registration",
			placement,
		});
		if (condition !== undefined)
			conditions.push({ condition, slot: { operation: uuid } });
		if (closeType === "if" || closeType === "always") {
			const closeUuid = mint(r, place, "close", ordinal(place, "close"));
			if (closeUuid === undefined) return;
			const closeCondition: ProposedCondition | undefined =
				closeType === "if"
					? {
							stored: closeStored,
							own: false,
							repeat,
							place: conditionField(form, closeStored)?.place ?? form.place,
							pointer: `${S.pointer}/close_condition`,
						}
					: undefined;
			operations.push({
				uuid: closeUuid,
				id: operationId(caseType),
				action: "close",
				caseType,
				writes: [],
				...(closeCondition !== undefined && { condition: closeCondition }),
				...(repeat !== undefined && { forEach: repeat }),
				closes: uuid,
			});
			if (closeCondition !== undefined)
				conditions.push({
					condition: closeCondition,
					slot: { operation: closeUuid },
				});
		}
	});
}

/** Drops the `required` of each visible question that names a created case,
 *  and the record stage 3 made of it: HQ's build writes its own there. */
function claimCreateNameRequired(r: FormReading): void {
	dropCreateNameRequired(r.ctx, r.form, r.createNames);
}

/**
 * Drops the `required` of each visible question in `names`, the questions that
 * name a case the form creates, wherever the create is kept (a basic slot, an
 * advanced open action, a Save to Case block): HQ's build, and Nova's emitter
 * with it, writes `required="true()"` on that bind whatever the source holds,
 * so the draft field holds no required of its own there.
 */
export function dropCreateNameRequired(
	ctx: ReadContext,
	form: DraftForm,
	names: readonly DraftField[],
): void {
	const xform = form.xform;
	if (xform === null) return;
	const seen = new Set<DraftField>();
	for (const field of names) {
		if (seen.has(field)) continue;
		seen.add(field);
		if (field.kind === "hidden") continue;
		const bind = xform.binds.get(field.node);
		if (bind?.element.attribs.required === undefined) continue;
		xform.cursor.drop(
			{ element: bind.element, attribute: "required" },
			BASIC_CLAIMS.createNameRequired,
		);
		ctx.writeDraft(() => {
			delete field.field.required;
			const at = field.expressions.findIndex((one) => one.slot === "required");
			if (at !== -1) field.expressions.splice(at, 1);
		});
	}
}

// ── The writes, once the fields have their UUIDs ────────────────────────

function valueExpression(value: ProposedValue): Expression | undefined {
	const uuid = value.field.uuid;
	if (uuid === undefined) return undefined;
	return value.link
		? term({ kind: "capture-link", field: uuid })
		: term(formField(uuid));
}

function conditionExpression(
	form: DraftForm,
	condition: ProposedCondition,
): Expression | undefined {
	const read = readActionCondition(
		condition.stored,
		{ own: condition.own, repeat: condition.repeat?.uuid },
		form,
	);
	return read.kind === "if" ? read.expression : undefined;
}

/**
 * Writes one basic form's proposed operations and conditions into its draft. `ownInBlock`:
 * a Save to Case block of the form took the form's own case, so an own arm that changes
 * nothing is not the form's own case and claims no key.
 */
export function writeBasicOperations(
	ctx: ReadContext,
	form: DraftForm,
	ownInBlock: boolean,
): void {
	const reading = READINGS.get(form);
	if (reading === undefined) return;
	const bareOwn = ownInBlock ? undefined : reading.bareOwn?.();
	const proposals =
		bareOwn === undefined
			? reading.operations
			: [bareOwn, ...reading.operations];
	const operations: CaseOperation[] = [];
	const ownUuid = proposals.find((one) => one.action === "own")?.uuid;
	for (const proposal of proposals) {
		const name =
			proposal.name === undefined ? undefined : valueExpression(proposal.name);
		const owner =
			proposal.owner === undefined
				? undefined
				: valueExpression(proposal.owner);
		const writes: CaseOperationWrite[] = [];
		for (const write of proposal.writes) {
			const value = valueExpression(write.value);
			if (value === undefined) continue;
			writes.push({
				property: write.property,
				value,
				...(write.via !== undefined && { via: write.via }),
				...(write.onlyIfChanged !== undefined && { onlyIfChanged: true }),
			});
		}
		const condition =
			proposal.condition === undefined
				? undefined
				: conditionExpression(form, proposal.condition);
		const forEach =
			proposal.forEach?.uuid === undefined
				? undefined
				: { repeat: proposal.forEach.uuid };
		const common = {
			uuid: proposal.uuid,
			id: proposal.id,
			...(writes.length > 0 && { writes }),
			...(proposal.placement !== undefined && {
				placement: proposal.placement,
			}),
		};
		if (proposal.action === "own")
			operations.push({
				...common,
				action: "own",
				...(name !== undefined && { name }),
				...(owner !== undefined && { owner }),
			});
		else if (proposal.action === "create" && name !== undefined)
			operations.push({
				...common,
				action: "create",
				caseType: proposal.caseType as string,
				target: { kind: "new" },
				name,
				...(owner !== undefined && { owner }),
				...(condition !== undefined && { condition }),
				...(forEach !== undefined && { forEach }),
				...(proposal.linksOwn === true && {
					links: [
						{
							identifier: "parent",
							targetType: ctx.draft.modules.find((one) =>
								one.forms.includes(form),
							)?.module.caseType as string,
							target:
								reading.type === "registration" && ownUuid !== undefined
									? { kind: "op", opUuid: ownUuid }
									: { kind: "session" },
							relationship: "child",
						},
					],
				}),
			} as CaseOperation);
		else if (proposal.action === "close" && proposal.closes !== undefined)
			operations.push({
				uuid: proposal.uuid,
				id: proposal.id,
				action: "close",
				caseType: proposal.caseType as string,
				target: { kind: "op", opUuid: proposal.closes },
				...(condition !== undefined && { condition }),
				...(forEach !== undefined && { forEach }),
			} as CaseOperation);
		else if (
			proposal.action === "update" &&
			proposal.target === "worker-record"
		)
			operations.push({
				...common,
				action: "update",
				caseType: "commcare-user",
				target: { kind: "worker-record" },
			} as CaseOperation);
	}
	const open =
		reading.openCondition === undefined
			? undefined
			: conditionExpression(form, reading.openCondition);
	const close =
		reading.closeCondition === undefined
			? undefined
			: reading.closeCondition === "match-all"
				? matchAll()
				: conditionExpression(form, reading.closeCondition);
	ctx.writeDraft(() => {
		if (operations.length > 0) form.form.caseOperations = operations;
		if (open !== undefined) form.form.openCondition = open;
		if (close !== undefined) form.form.closeCondition = close;
	});
}
