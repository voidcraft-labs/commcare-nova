/**
 * An advanced form's case actions (`models/form_actions.py::AdvancedFormActions`)
 * read into its type, its menu's parent selection and its case operations,
 * and an advanced menu's own keys read into its held kind.
 *
 * HQ's `AdvancedModule` stores no parent selection: each form states its own
 * selections as loads. The menu's one chain is the one every case-loading
 * form agrees on (`readLoadChain`), and the reading holds only where the
 * loads Nova derives from it (`planFormCaseWire`) are HQ's, tag by tag. Every
 * operation read from a load or an open action holds the action's tag as its
 * placement, so a publish keeps each `case_<tag>` and `case_id_<tag>` HQ's
 * forms read.
 */
import {
	type CaseOperation,
	type CaseOperationLink,
	type CaseOperationWrite,
	type Expression,
	type FormType,
	isCaseOperationIdentifier,
	ownCaseOperationId,
	type TargetedCaseOperation,
	type Term,
	type Uuid,
} from "@/lib/domain";
import { advancedKindBlockers } from "@/lib/domain/advancedModule";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	actingUser,
	formField,
	matchAll,
	term,
	unowned,
} from "@/lib/domain/expression/builders";
import { XML_ELEMENT_NAME_PATTERN } from "@/lib/domain/expression/types";
import type { HqPlace } from "@/lib/publish/hqFindings";
import type { PlannedLoad } from "../../advancedSelections";
import { HQ_CASE_TAG_PATTERN } from "../../advancedTags";
import { planFormCaseWire } from "../../casePlacementPlan";
import {
	datumIdsFromFacts,
	type HqAppEntryFacts,
	hqEntryFacts,
} from "../../hq/entryFacts";
import { planPlacements } from "../../placement";
import { generatedBaseName } from "../../xform/generatedNodes";
import type { Admitted } from "../accounting";
import { type Claim, defineClaims, drop, refuse, take } from "../claims";
import type { DraftForm, DraftModule, ReadContext } from "../context";
import { externalKey } from "../identity";
import { isJsonObject, type JsonCursor, sameJson } from "../jsonCursor";
import { whereText } from "../place";
import { readProjectionInputs } from "../projectionInputs";
import type { DraftField } from "../xform";
import { isAllocatedName } from "../xform/generated";
import type { DataNode } from "../xform/model";
import {
	type ProposedValue,
	questionValue,
	repeatOfField,
} from "./basicActions";
import {
	conditionField,
	conditionFinding,
	conditionQuestionPath,
	conditionType,
	readActionCondition,
	repeatAtPath,
	statedBack,
} from "./conditions";
import {
	addPreloadCandidate,
	fieldAt,
	holdsDefault,
	writeDefault,
} from "./preloads";

const F = "forms-and-case-writes";
const M = "menus-and-case-lists";

export const ADVANCED_CLAIMS = defineClaims("caseManagement.advancedActions", {
	// The menu.
	productDefault: drop(
		`${M}/advancedmodule-product-details-equal-to-the-default-single-name`,
		"schema:AdvancedModule.product_details",
	),
	productOther: refuse(
		`${M}/advancedmodule-product-details-differing-from-the-default`,
		"schema:AdvancedModule.product_details",
	),
	hasSchedule: refuse(
		`${M}/advancedmodule-has-schedule-true-or-schedule-phases-non-empty`,
		"schema:AdvancedModule.has_schedule",
	),
	schedulePhases: refuse(
		`${M}/advancedmodule-has-schedule-true-or-schedule-phases-non-empty`,
		"schema:AdvancedModule.schedule_phases",
	),
	autoSelectCase: refuse(
		`${M}/auto-select-case-on-an-advanced-module`,
		"schema:AdvancedModule.auto_select_case",
	),
	kindBlocked: refuse(
		`${M}/advanced-module-nova-would-write-as-a-basic-one`,
		"schema:AdvancedModule",
	),

	// The form.
	scheduleOff: drop(
		`${F}/advancedform-schedule-with-enabled-false`,
		"schema:AdvancedForm.schedule",
	),
	scheduleOn: refuse(
		`${F}/advancedform-schedule-with-enabled-true-visits-transition`,
		"schema:AdvancedForm.schedule",
	),
	scheduleMissingQuestion: refuse(
		`${F}/advancedform-schedule-with-enabled-false-on-an-advanced-form`,
		"schema:AdvancedForm.schedule",
	),
	arbitraryDatums: refuse(
		`${F}/arbitrary-datums-datum-id-datum-function`,
		"schema:AdvancedForm.arbitrary_datums",
	),
	actions: take(
		`${F}/load-update-cases-loadupdateaction`,
		"schema:AdvancedForm.actions",
	),
	loads: take(
		`${F}/load-update-cases-loadupdateaction`,
		"schema:AdvancedFormActions.load_update_cases",
	),
	opens: take(
		`${F}/open-cases-advancedopencaseaction-any-other`,
		"schema:AdvancedFormActions.open_cases",
	),

	// A load.
	tag: take(
		`${F}/loadupdateaction-case-tag-without`,
		"schema:LoadUpdateAction.case_tag",
	),
	tagSlash: refuse(
		`${F}/a-load-or-open-action-s-case-tag-containing-which-the-advanced`,
		"schema:LoadUpdateAction.case_tag",
	),
	tagBlank: refuse(
		`${F}/case-tag-blank-on-a-non-auto-select-action`,
		"schema:LoadUpdateAction.case_tag",
	),
	tagFailsPage: refuse(
		`${F}/case-tag-of-a-non-auto-select-action-failing-actions-js`,
		"schema:LoadUpdateAction.case_tag",
	),
	tagHyphen: refuse(
		`${F}/case-tag-holding-a-hyphen`,
		"schema:LoadUpdateAction.case_tag",
	),
	caseType: take(
		`${F}/loadupdateaction-case-type`,
		"schema:LoadUpdateAction.case_type",
	),
	detailsModule: take(
		`${F}/loadupdateaction-details-module`,
		"schema:LoadUpdateAction.details_module",
	),
	detailsModuleOther: refuse(
		`${F}/details-module-naming-another-module-of-a-different-case-type-or`,
		"schema:LoadUpdateAction.details_module",
	),
	notOneChain: refuse(
		`${F}/advanced-form-loads-other-than-its-menu-s-one-chain`,
		"schema:AdvancedFormActions.load_update_cases",
	),
	underivedTag: refuse(
		`${F}/load-changing-no-case-with-a-tag-nova-does-not-derive`,
		"schema:LoadUpdateAction.case_tag",
	),
	usercaseWritesNothing: refuse(
		`${F}/load-changing-no-case-with-a-tag-nova-does-not-derive`,
		"schema:LoadUpdateAction.auto_select",
	),
	caseIndex: take(
		`${F}/loadupdateaction-case-index-tag-reference-id-relationship`,
		"schema:LoadUpdateAction.case_index",
	),
	caseIndexOnFirst: refuse(
		`${F}/loadupdateaction-case-index-on-an-auto-selected-load-or-on-the`,
		"schema:LoadUpdateAction.case_index",
	),
	caseIndexNoAction: refuse(
		`${F}/case-index-tag-naming-no-action`,
		"schema:LoadUpdateAction.case_index",
	),
	caseIndexOtherLoad: refuse(
		`${F}/loadupdateaction-case-index-tag-naming-a-load-other-than-the-one`,
		"schema:LoadUpdateAction.case_index",
	),
	fromFixture: refuse(
		`${F}/load-case-from-fixture-loadcasefromfixture-all-fields`,
		"schema:LoadUpdateAction.load_case_from_fixture",
	),
	productStock: refuse(
		`${F}/show-product-stock-true-or-a-non-empty-product-program`,
		"schema:LoadUpdateAction.show_product_stock",
	),
	productStockOff: drop(
		`${F}/show-product-stock-false-and-product-program`,
		"schema:LoadUpdateAction.show_product_stock",
	),
	productProgramOff: drop(
		`${F}/show-product-stock-false-and-product-program`,
		"schema:LoadUpdateAction.product_program",
	),
	loadProperties: take(
		`${F}/loadupdateaction-case-properties`,
		"schema:LoadUpdateAction.case_properties",
	),
	loadQuestionPath: take(
		`${F}/loadupdateaction-case-properties`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	slashOnIndexedLoad: refuse(
		`${F}/loadupdateaction-preload-or-case-properties-property-with-on-a`,
		"schema:LoadUpdateAction.case_properties",
	),
	slashPreloadOnIndexedLoad: refuse(
		`${F}/loadupdateaction-preload-or-case-properties-property-with-on-a`,
		"schema:LoadUpdateAction.preload",
	),
	editNotHeld: refuse(
		`${F}/update-mode-edit-off-a-follow-up-form-s-own-update`,
		"schema:ConditionalCaseUpdate.update_mode",
	),
	editNotApplied: drop(
		`${F}/update-mode-edit-in-a-project-space-that-saves-every-time`,
		"schema:ConditionalCaseUpdate.update_mode",
	),
	ownClose: take(
		`${F}/loadupdateaction-close-condition-on-the-form-s-own-selection`,
		"schema:LoadUpdateAction.close_condition",
	),
	otherClose: take(
		`${F}/loadupdateaction-close-condition-on-any-other-selection`,
		"schema:LoadUpdateAction.close_condition",
	),
	preload: take(
		`${F}/loadupdateaction-preload-question-property`,
		"schema:LoadUpdateAction.preload",
	),
	preloadLater: refuse(
		`${F}/loadupdateaction-preload-read-later-in-the-load`,
		"schema:LoadUpdateAction.preload",
	),
	preloadNoDefault: refuse(
		`${F}/case-preload-into-a-question-that-holds-no-default`,
		"schema:LoadUpdateAction.preload",
	),
	labelQuestion: refuse(
		`${F}/an-advanced-load-s-update-or-preload-or-an-open-action-s-name-or`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	usercase: take(
		`${F}/auto-select-mode-usercase`,
		"schema:LoadUpdateAction.auto_select",
	),
	autoRaw: refuse(
		`${F}/auto-select-mode-raw-value-key`,
		"schema:LoadUpdateAction.auto_select",
	),
	autoUser: refuse(
		`${F}/auto-select-mode-user`,
		"schema:LoadUpdateAction.auto_select",
	),
	autoFixture: refuse(
		`${F}/auto-select-mode-fixture`,
		"schema:LoadUpdateAction.auto_select",
	),
	autoCase: refuse(
		`${F}/auto-select-mode-case-index-of-an-earlier-load`,
		"schema:LoadUpdateAction.auto_select",
	),
	autoCaseLater: refuse(
		`${F}/auto-select-mode-case-naming-itself-a-later-load-or-an-open`,
		"schema:LoadUpdateAction.auto_select",
	),
	autoMissingKey: refuse(
		`${F}/auto-select-missing-its-key-in-case-fixture-user-or-raw-mode`,
		"schema:LoadUpdateAction.auto_select",
	),
	autoBlank: refuse(
		`${F}/an-auto-select-load-with-a-blank-mode-or-a-blank-case-type`,
		"schema:LoadUpdateAction.auto_select",
	),

	// An open action.
	openOwn: take(
		`${F}/open-cases-advancedopencaseaction-the-one-open-action-outside`,
		"schema:AdvancedOpenCaseAction.case_tag",
	),
	openOwnType: take(
		`${F}/open-cases-advancedopencaseaction-the-one-open-action-outside`,
		"schema:AdvancedOpenCaseAction.case_type",
	),
	openTag: take(
		`${F}/open-cases-advancedopencaseaction-any-other`,
		"schema:AdvancedOpenCaseAction.case_tag",
	),
	openType: take(
		`${F}/open-cases-advancedopencaseaction-any-other`,
		"schema:AdvancedOpenCaseAction.case_type",
	),
	openTagSlash: refuse(
		`${F}/a-load-or-open-action-s-case-tag-containing-which-the-advanced`,
		"schema:AdvancedOpenCaseAction.case_tag",
	),
	openTagBlank: refuse(
		`${F}/case-tag-blank-on-a-non-auto-select-action`,
		"schema:AdvancedOpenCaseAction.case_tag",
	),
	openTagFailsPage: refuse(
		`${F}/case-tag-of-a-non-auto-select-action-failing-actions-js`,
		"schema:AdvancedOpenCaseAction.case_tag",
	),
	openTagHyphen: refuse(
		`${F}/case-tag-holding-a-hyphen`,
		"schema:AdvancedOpenCaseAction.case_tag",
	),
	openTypeUnknown: refuse(
		`${F}/open-case-type-not-any-module-s-case-type-and-not-commcare-user`,
		"schema:AdvancedOpenCaseAction.case_type",
	),
	openName: take(
		`${F}/advancedopencaseaction-name-update`,
		"schema:AdvancedOpenCaseAction.name_update",
	),
	openProperties: take(
		`${F}/advancedopencaseaction-case-properties-keys-without`,
		"schema:AdvancedOpenCaseAction.case_properties",
	),
	openQuestionPath: take(
		`${F}/advancedopencaseaction-case-properties-keys-without`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	openSlashKey: refuse(
		`${F}/advancedopencaseaction-case-properties-key-with-parent-p`,
		"schema:AdvancedOpenCaseAction.case_properties",
	),
	openRepeat: take(
		`${F}/advancedopencaseaction-repeat-context-equal-to-the-name-question`,
		"schema:AdvancedOpenCaseAction.repeat_context",
	),
	openRepeatOther: refuse(
		`${F}/advancedopencaseaction-repeat-context-other-than-the-name`,
		"schema:AdvancedOpenCaseAction.repeat_context",
	),
	openSharedRepeat: refuse(
		`${F}/two-or-more-open-actions-whose-repeat-context-is-one-repeat`,
		"schema:AdvancedOpenCaseAction.repeat_context",
	),
	openCondition: take(
		`${F}/advancedopencaseaction-open-condition`,
		"schema:AdvancedOpenCaseAction.open_condition",
	),
	openClose: take(
		`${F}/advancedopencaseaction-close-condition`,
		"schema:AdvancedOpenCaseAction.close_condition",
	),
	openIndices: take(
		`${F}/advancedopencaseaction-case-indices-child-extension-one-or-many`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	openIndexOwnOrLater: refuse(
		`${F}/advancedopencaseaction-case-indices-naming-its-own-or-a-later`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	openIndexNoAction: refuse(
		`${F}/case-index-tag-naming-no-action`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	openIndexQuestion: refuse(
		`${F}/relationship-question-without-relationship-question`,
		"schema:CaseIndex.relationship",
	),
	openIndexOutsideRepeat: refuse(
		`${F}/an-advanced-open-action-indexed-to-an-open-action-that-has-a-neither`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	openIndexName: refuse(
		`${F}/index-identifier-outside-an-xml-element-name`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	openIndexRenamedLoad: refuse(
		`${F}/an-advanced-open-action-s-index-to-a-load-whose-datum-hq-renames`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	questionToLoad: refuse(
		`${F}/caseindex-relationship-question-relationship-question-the-index-naming-a`,
		"schema:CaseIndex.relationship",
	),
	questionInRepeat: refuse(
		`${F}/caseindex-relationship-question-inside-a-repeat`,
		"schema:CaseIndex.relationship_question",
	),
	questionToOpen: refuse(
		`${F}/caseindex-relationship-question-relationship-question-the-index-naming-an`,
		"schema:CaseIndex.relationship",
	),
	questionAfterOpenIndex: refuse(
		`${F}/caseindex-relationship-question-on-an-index-to-a-load-that`,
		"schema:CaseIndex.relationship",
	),
});

// ── What the first pass proposes ────────────────────────────────────────

type ProposedCaseRef =
	| { readonly kind: "session" }
	| { readonly kind: "selected"; readonly module: Uuid }
	| { readonly kind: "op"; readonly uuid: Uuid };

interface ProposedLink {
	readonly identifier: string;
	readonly targetType: string;
	readonly relationship: "child" | "extension";
	readonly target: ProposedCaseRef;
}

interface ProposedCondition {
	readonly stored: unknown;
	readonly repeat: DraftField | undefined;
	readonly place: HqPlace;
}

interface AdvancedProposal {
	readonly uuid: Uuid;
	readonly id: string;
	readonly action: "own" | "create" | "update" | "close";
	readonly caseType?: string;
	readonly tag: string;
	readonly row?: true;
	readonly name?: ProposedValue;
	readonly rename?: ProposedValue;
	readonly owner?: ProposedValue | "acting-user" | "unowned";
	readonly writes: readonly {
		readonly property: string;
		readonly value: ProposedValue;
	}[];
	readonly condition?: ProposedCondition;
	readonly forEach?: DraftField;
	readonly target?:
		| ProposedCaseRef
		| { readonly kind: "worker-record" }
		| { readonly kind: "new" };
	readonly links: readonly ProposedLink[];
	/** A close sharing its place: the create or update it follows. */
	readonly shares?: Uuid;
}

/** One chosen load as stored: its tag, case type, list menu and index. */
export interface StoredLoad {
	readonly tag: string;
	readonly caseType: string;
	/** The menu whose list chooses the case, by `unique_id`; the form's own where blank. */
	readonly detailsModule: string;
	readonly index?: { readonly tag: string; readonly identifier: string };
	/** Whether it writes or closes a case. */
	readonly changes: boolean;
}

interface AdvancedReading {
	readonly type: FormType;
	readonly operations: readonly AdvancedProposal[];
	readonly openCondition?: ProposedCondition;
	readonly closeCondition?: ProposedCondition;
	/** A registration that closes the case it opens on every submission. */
	readonly closesAlways?: true;
	/** The chosen loads, in order; empty for a registration or a survey. */
	readonly chosen: readonly StoredLoad[];
	/** The worker's load, where HQ holds one. */
	readonly worker?: StoredLoad;
	/** The form's own chain of list menus, root first; undefined where a load was a finding. */
	readonly chain?: readonly Uuid[];
}

const READINGS = new WeakMap<DraftForm, AdvancedReading>();

/** The first pass's reading of an advanced form. */
export function advancedCaseReading(
	form: DraftForm,
): AdvancedReading | undefined {
	return READINGS.get(form);
}

function consume<T>(admitted: Admitted<T>): T {
	return admitted.value;
}

function activeCondition(condition: unknown): boolean {
	const type = conditionType(condition);
	return type === "if" || type === "always";
}

/** The refusal a tag is, in the rows' order; undefined for a tag Nova holds. */
function tagFinding(tag: unknown, open: boolean): Claim<"refuse"> | undefined {
	const C = ADVANCED_CLAIMS;
	if (typeof tag !== "string" || tag === "")
		return open ? C.openTagBlank : C.tagBlank;
	if (tag.includes("/")) return open ? C.openTagSlash : C.tagSlash;
	if (!HQ_CASE_TAG_PATTERN.test(tag))
		return open ? C.openTagFailsPage : C.tagFailsPage;
	if (tag.includes("-")) return open ? C.openTagHyphen : C.tagHyphen;
	return undefined;
}

// ── The menu ────────────────────────────────────────────────────────────

/** Whether a menu's `product_details` is HQ's default: one `name` column of
 *  the product headed "Product", and an empty long detail. */
function defaultProductDetails(value: unknown): boolean {
	if (!isJsonObject(value)) return true;
	const short = isJsonObject(value.short) ? value.short : {};
	const long = isJsonObject(value.long) ? value.long : {};
	const columns = Array.isArray(short.columns) ? short.columns : [];
	const longColumns = Array.isArray(long.columns) ? long.columns : [];
	if (columns.length !== 1 || longColumns.length > 0) return false;
	const column = columns[0];
	if (
		!isJsonObject(column) ||
		column.field !== "name" ||
		column.model !== "product"
	)
		return false;
	const header = isJsonObject(column.header)
		? Object.values(column.header)
		: [];
	return header.length > 0 && header.every((text) => text === "Product");
}

/**
 * An advanced menu's own keys (`AdvancedModule`): its held kind, and the
 * product list, schedule and auto-selection HQ keeps on it.
 */
export function readAdvancedMenu(ctx: ReadContext, module: DraftModule): void {
	if (module.docType !== "AdvancedModule") return;
	const json = module.json;
	ctx.writeDraft(() => {
		module.module.heldKind = "advanced";
	});
	if (json.used("product_details")) {
		if (defaultProductDetails(json.peek("product_details")))
			json.drop("product_details", ADVANCED_CLAIMS.productDefault);
		else json.refuse("product_details", ADVANCED_CLAIMS.productOther);
	}
	if (json.peek("has_schedule") === true)
		json.refuse("has_schedule", ADVANCED_CLAIMS.hasSchedule);
	const phases = json.peek("schedule_phases");
	if (Array.isArray(phases) && phases.length > 0)
		json.refuse("schedule_phases", ADVANCED_CLAIMS.schedulePhases);
	if (json.peek("auto_select_case") === true)
		json.refuse("auto_select_case", ADVANCED_CLAIMS.autoSelectCase);
}

// ── The chain ───────────────────────────────────────────────────────────

/**
 * The menu's one chain of list menus, root first and ending at the menu,
 * from its forms' chosen loads (steps 3 and 4 of the chain test): every
 * form that has a chain agrees on it. Each form whose chain differs is
 * named, with the tag of its own load. Undefined where no form has one.
 */
export function readLoadChain(
	module: DraftModule,
	forms: readonly DraftForm[],
): {
	readonly chain: readonly Uuid[] | undefined;
	readonly disagreeing: readonly {
		readonly form: DraftForm;
		readonly tag: string;
	}[];
} {
	let chain: readonly Uuid[] | undefined;
	const disagreeing: { form: DraftForm; tag: string }[] = [];
	for (const form of forms) {
		const reading = READINGS.get(form);
		const own = reading?.chain;
		if (reading === undefined || own === undefined || own.length === 0)
			continue;
		const tag = reading.chosen[reading.chosen.length - 1]?.tag ?? "";
		// A form's chain ends at the menu the form stands in.
		if (own[own.length - 1] !== module.uuid) {
			disagreeing.push({ form, tag });
			continue;
		}
		if (chain === undefined) chain = own;
		else if (!sameJson(chain, own)) disagreeing.push({ form, tag });
	}
	return { chain, disagreeing };
}

/** The entry facts of each source, read once. */
const SOURCE_FACTS = new WeakMap<object, HqAppEntryFacts>();

/**
 * Whether CommCare HQ's entry gives the load tagged `tag` another session
 * value than its `case_id_<tag>`: a child menu's load its parent's first
 * form already selects (`entries.py::EntriesHelper.add_parent_datums`), by
 * HQ's own id rules over the source's facts (`datumIdsFromFacts`). A form
 * whose facts HQ's rules cannot read gives no answer here; the entry facts
 * comparison judges it.
 */
function loadDatumRenamed(
	ctx: ReadContext,
	form: DraftForm,
	tag: string,
): boolean {
	const raw = ctx.input.source.raw as object;
	let facts = SOURCE_FACTS.get(raw);
	if (facts === undefined) {
		facts = hqEntryFacts(raw);
		SOURCE_FACTS.set(raw, facts);
	}
	const own = facts.forms.get(form.xmlns);
	if (own === undefined) return false;
	let ids: readonly string[];
	try {
		ids = datumIdsFromFacts(own, facts);
	} catch {
		return false;
	}
	return !ids.includes(`case_id_${tag}`);
}

// ── The first pass ──────────────────────────────────────────────────────

interface Reading {
	readonly ctx: ReadContext;
	readonly module: DraftModule;
	readonly form: DraftForm;
	readonly applied: boolean;
	ok: boolean;
}

/** One write map (`case_properties`) of a load or an open action, key by key. */
function readProperties(
	r: Reading,
	parent: JsonCursor,
	claims: {
		readonly map: Claim<"take">;
		readonly path: Claim<"take">;
		readonly slash: Claim<"refuse"> | undefined;
	},
	indexed: boolean,
	/** An open action's: whose `owner_id` may name Nova's owner node, which the open action
	 *  settles once its operation has an id. */
	opens = false,
): {
	writes: { property: string; value: ProposedValue }[];
	name?: ProposedValue;
	owner?: ProposedValue | "acting-user" | "unowned";
	ownerNode?: OwnerNode;
} {
	const out: ReturnType<typeof readProperties> = { writes: [] };
	if (!parent.used("case_properties")) return out;
	const entries = parent.map(
		"case_properties",
		"ConditionalCaseUpdate",
		claims.map,
	);
	for (const [key, cursor] of entries) {
		if (key.includes("/")) {
			if (claims.slash !== undefined)
				cursor.refuseWhole(claims.slash, { name: key });
			else if (indexed)
				cursor.refuseWhole(ADVANCED_CLAIMS.slashOnIndexedLoad, { name: key });
			else
				r.ctx.accounting.circumstance("unrecognized", r.form.place, {
					name: "schema:LoadUpdateAction.case_properties",
				});
			r.ok = false;
			continue;
		}
		if (cursor.peek("update_mode") === "edit") {
			if (r.applied) {
				cursor.refuse("update_mode", ADVANCED_CLAIMS.editNotHeld);
				r.ok = false;
			} else cursor.drop("update_mode", ADVANCED_CLAIMS.editNotApplied);
		}
		const path = consume(
			cursor.take("question_path", claims.path, (value) => value),
		);
		if (typeof path !== "string" || path === "") {
			r.ok = false;
			r.ctx.accounting.circumstance("unrecognized", r.form.place, {
				name: "schema:ConditionalCaseUpdate.question_path",
			});
			continue;
		}
		// An open action's owner may name the owner node Nova folds beside it.
		if (key === "owner_id" && opens) {
			const owner = ownerNode(r, path);
			if (owner !== undefined) {
				out.ownerNode = owner;
				continue;
			}
		}
		const read = questionValue(r.ctx, r.form, path, key);
		if (read.kind === "finding") {
			r.ctx.accounting.finding(advancedReadClaim(read.claim), r.form.place, {
				name: key,
			});
			r.ok = false;
			continue;
		}
		if (key === "name") out.name = read.value;
		else if (key === "owner_id") out.owner = read.value;
		else out.writes.push({ property: key, value: read.value });
	}
	return out;
}

/** An open action's `owner_id` naming a node the form stage proposed as an owner node. */
interface OwnerNode {
	readonly node: DataNode;
	readonly value: "acting-user" | "unowned";
	/** The stored `question_path`. */
	readonly path: string;
}

/** The owner node an open action's `owner_id` names, where the form stage proposed one there. */
function ownerNode(r: Reading, path: string): OwnerNode | undefined {
	const xform = r.form.xform;
	const relative = conditionQuestionPath(r.form, path);
	const node = relative === undefined ? undefined : xform?.nodes.get(relative);
	const role = node === undefined ? undefined : xform?.roles.get(node);
	if (
		node === undefined ||
		role?.kind !== "generated-candidate" ||
		role.purpose !== "owner" ||
		role.ownerValue === undefined
	)
		return undefined;
	return { node, value: role.ownerValue, path };
}

const OWNER_NODE_PREFIX = generatedBaseName("owner", "");

/** The operation id an owner node's name gives: what follows `nova_owner_`, where that is
 *  an operation id. A suffix the allocator added on a collision reads as part of the id,
 *  which names the node the same. */
function ownerNodeOperationId(
	owner: OwnerNode | undefined,
): string | undefined {
	if (owner === undefined || !owner.node.name.startsWith(OWNER_NODE_PREFIX))
		return undefined;
	const id = owner.node.name.slice(OWNER_NODE_PREFIX.length);
	return isCaseOperationIdentifier(id) ? id : undefined;
}

/** Whether a node stands in the scope the emitter writes an open action's owner node in: the
 *  form's root, or a row of the action's repeat. */
function standsInScope(
	form: DraftForm,
	node: DataNode,
	repeat: DraftField | undefined,
): boolean {
	if (node.parent === null) return repeat === undefined;
	const role = form.xform?.roles.get(node.parent);
	const holder =
		role?.kind === "field"
			? role.field
			: role?.kind === "query-row"
				? role.repeat
				: undefined;
	return holder !== undefined && holder === repeat;
}

/**
 * Settles the owner node an open action names, once the action's operation has its id: Nova's
 * node where it holds the allocator's name for that id in the action's scope, and the owner
 * its value states; otherwise the person's own Hidden Value, and the owner a read of it.
 * Undefined where that read is a finding, which it records.
 */
function settleOwner(
	r: Reading,
	owner: OwnerNode,
	operation: string,
	repeat: DraftField | undefined,
): ProposedValue | "acting-user" | "unowned" | undefined {
	const xform = r.form.xform;
	if (xform === null || xform === undefined) return undefined;
	const open = xform.candidates.includes(owner.node);
	if (
		open &&
		isAllocatedName(owner.node.name, generatedBaseName("owner", operation)) &&
		standsInScope(r.form, owner.node, repeat)
	) {
		r.ctx.writeDraft(() => xform.settle(owner.node, "generated", operation));
		return owner.value;
	}
	if (open) r.ctx.writeDraft(() => xform.settle(owner.node, "field"));
	const read = questionValue(r.ctx, r.form, owner.path, "owner_id");
	if (read.kind === "finding") {
		r.ctx.accounting.finding(advancedReadClaim(read.claim), r.form.place, {
			name: "owner_id",
		});
		r.ok = false;
		return undefined;
	}
	return read.value;
}

/** A basic action's finding as an advanced action's: a label read is the advanced entry's. */
function advancedReadClaim(claim: Claim<"refuse">): Claim<"refuse"> {
	return claim.entry ===
		`${F}/a-case-write-name-or-preload-on-a-question-the-picker-does-not`
		? ADVANCED_CLAIMS.labelQuestion
		: claim;
}

function mint(
	r: Reading,
	tag: string,
	action: CaseOperation["action"],
	n: number,
): Uuid | undefined {
	return r.ctx.accounting.identity(
		r.ctx.resolver.claim(
			externalKey.caseOperation(r.form.xmlns, ["advanced", tag], action, n),
			whereText(r.form.place),
		),
		r.form.place,
		"schema:AdvancedForm.actions",
	);
}

/** The menus of the app by `unique_id`. */
function menusById(ctx: ReadContext): ReadonlyMap<string, DraftModule> {
	return new Map(ctx.draft.modules.map((module) => [module.uniqueId, module]));
}

/**
 * Reads `form.actions` of an advanced form (`AdvancedFormActions`) into its
 * type and its proposed case operations, claiming every key; its chosen
 * loads are kept for the chain test. The form's own keys `schedule` and
 * `arbitrary_datums` are claimed here.
 */
export function readAdvancedActions(
	ctx: ReadContext,
	module: DraftModule,
	form: DraftForm,
): void {
	const json = form.json;
	const schedule = json.peek("schedule");
	if (isJsonObject(schedule)) {
		if (schedule.enabled === true)
			json.refuse("schedule", ADVANCED_CLAIMS.scheduleOn);
		else if (scheduleNamesMissingQuestion(form, schedule))
			json.refuse("schedule", ADVANCED_CLAIMS.scheduleMissingQuestion);
		else json.drop("schedule", ADVANCED_CLAIMS.scheduleOff);
	}
	const datums = json.peek("arbitrary_datums");
	if (Array.isArray(datums) && datums.length > 0)
		json.refuse("arbitrary_datums", ADVANCED_CLAIMS.arbitraryDatums);

	const stored = json.peek("actions");
	const actions = isJsonObject(stored) ? stored : {};
	const A = json.object(
		"actions",
		"AdvancedFormActions",
		ADVANCED_CLAIMS.actions,
	);
	const r: Reading = {
		ctx,
		module,
		form,
		applied: ctx.input.saveOnlyEditedApplied === true,
		ok: true,
	};
	const menus = menusById(ctx);
	const menuType =
		module.module.caseType ??
		(typeof module.json.peek("case_type") === "string"
			? (module.json.peek("case_type") as string)
			: "");
	const storedLoads = Array.isArray(actions.load_update_cases)
		? actions.load_update_cases
		: [];
	const storedOpens = Array.isArray(actions.open_cases)
		? actions.open_cases
		: [];
	const loadCursors =
		storedLoads.length > 0
			? A.list("load_update_cases", "LoadUpdateAction", ADVANCED_CLAIMS.loads)
			: [];
	const openCursors =
		storedOpens.length > 0
			? A.list("open_cases", "AdvancedOpenCaseAction", ADVANCED_CLAIMS.opens)
			: [];

	const operations: AdvancedProposal[] = [];
	const takenIds = new Set<string>();
	const operationId = (type: string) => {
		const id = ownCaseOperationId(type, takenIds);
		takenIds.add(id);
		return id;
	};
	// An open action whose owner node names its operation keeps that id, so Nova names the node
	// as the source does.
	const openOperationId = (type: string, owner: OwnerNode | undefined) => {
		const named = ownerNodeOperationId(owner);
		if (named === undefined || takenIds.has(named)) return operationId(type);
		takenIds.add(named);
		return named;
	};
	const counts = new Map<string, number>();
	const ordinal = (tag: string, action: string) => {
		const key = `${tag}\u0000${action}`;
		const n = counts.get(key) ?? 0;
		counts.set(key, n + 1);
		return n;
	};

	// The chosen loads, with every check of step 2.
	const chosenIndexes = storedLoads
		.map((load, i) =>
			isJsonObject(load) &&
			(load.auto_select === null || load.auto_select === undefined)
				? i
				: -1,
		)
		.filter((i) => i >= 0);
	const chosen: StoredLoad[] = [];
	const chain: Uuid[] = [];
	let chainOk = true;
	const loadTags = new Map<string, number>();
	storedLoads.forEach((load, i) => {
		if (isJsonObject(load) && typeof load.case_tag === "string")
			loadTags.set(load.case_tag, i);
	});
	const openTags = new Map<string, number>();
	storedOpens.forEach((open, j) => {
		if (isJsonObject(open) && typeof open.case_tag === "string")
			openTags.set(open.case_tag, j);
	});
	let type: FormType = "survey";
	let closeCondition: ProposedCondition | undefined;
	let closesAlways = false;
	let openCondition: ProposedCondition | undefined;
	let worker: StoredLoad | undefined;
	const loadUuids = new Map<number, ProposedCaseRef>();

	loadCursors.forEach((L, i) => {
		const load = storedLoads[i] as Record<string, unknown>;
		if (load.auto_select !== null && load.auto_select !== undefined) {
			const earlierTags = new Set(
				storedLoads
					.slice(0, i)
					.flatMap((one) =>
						isJsonObject(one) && typeof one.case_tag === "string"
							? [one.case_tag]
							: [],
					),
			);
			const read = readAutoSelectLoad(
				r,
				L,
				load,
				earlierTags,
				operations,
				operationId,
				ordinal,
			);
			if (read !== undefined) worker = read;
			return;
		}
		const position = chosenIndexes.indexOf(i);
		const last = position === chosenIndexes.length - 1;
		const tag = load.case_tag;
		const tagClaim = tagFinding(tag, false);
		if (tagClaim !== undefined) {
			L.refuseWhole(
				tagClaim,
				typeof tag === "string" && tag !== "" ? { name: tag } : undefined,
			);
			chainOk = false;
			r.ok = false;
			return;
		}
		consume(L.take("case_tag", ADVANCED_CLAIMS.tag, (value) => value));
		const caseType = load.case_type;
		consume(L.take("case_type", ADVANCED_CLAIMS.caseType, (value) => value));
		const detailsId =
			typeof load.details_module === "string" ? load.details_module : "";
		const listMenu =
			detailsId === "" ? (last ? module : undefined) : menus.get(detailsId);
		if (last) {
			if (
				caseType !== menuType ||
				(detailsId !== "" && detailsId !== module.uniqueId)
			) {
				L.refuseWhole(ADVANCED_CLAIMS.notOneChain, { name: tag as string });
				chainOk = false;
				r.ok = false;
				return;
			}
		} else if (
			listMenu === undefined ||
			(listMenu.module.caseType !== caseType &&
				listMenu.json.peek("case_type") !== caseType)
		) {
			L.refuse("details_module", ADVANCED_CLAIMS.detailsModuleOther, {
				name: tag as string,
			});
			chainOk = false;
			r.ok = false;
		}
		if (L.used("details_module"))
			consume(
				L.take(
					"details_module",
					ADVANCED_CLAIMS.detailsModule,
					(value) => value,
				),
			);
		// The index: none on the first, the tag of the load before on each later one.
		const index = isJsonObject(load.case_index) ? load.case_index : {};
		const indexTag = typeof index.tag === "string" ? index.tag : "";
		let indexRead: StoredLoad["index"];
		if (position === 0) {
			if (indexTag !== "") {
				L.refuse("case_index", ADVANCED_CLAIMS.caseIndexOnFirst);
				chainOk = false;
				r.ok = false;
			} else {
				// An index with a blank tag indexes nothing: HQ's page writes one on a load that
				// indexes no case (`advanced/actions.js`, `case_index.tag('')`).
				consume(
					L.take("case_index", ADVANCED_CLAIMS.caseIndex, (value) => value),
				);
			}
		} else {
			const previous = storedLoads[
				chosenIndexes[position - 1] as number
			] as Record<string, unknown>;
			if (!loadTags.has(indexTag) && !openTags.has(indexTag)) {
				L.refuse("case_index", ADVANCED_CLAIMS.caseIndexNoAction);
				chainOk = false;
				r.ok = false;
			} else if (indexTag !== previous.case_tag) {
				L.refuse("case_index", ADVANCED_CLAIMS.caseIndexOtherLoad);
				chainOk = false;
				r.ok = false;
			} else if (
				index.relationship !== undefined &&
				index.relationship !== "child"
			) {
				L.refuseWhole(ADVANCED_CLAIMS.notOneChain, { name: tag as string });
				chainOk = false;
				r.ok = false;
				return;
			} else {
				consume(
					L.take("case_index", ADVANCED_CLAIMS.caseIndex, (value) => value),
				);
				indexRead = {
					tag: indexTag,
					identifier:
						typeof index.reference_id === "string" && index.reference_id !== ""
							? index.reference_id
							: "parent",
				};
			}
		}
		if (
			load.load_case_from_fixture !== null &&
			load.load_case_from_fixture !== undefined
		) {
			L.refuse("load_case_from_fixture", ADVANCED_CLAIMS.fromFixture);
			r.ok = false;
		}
		if (
			load.show_product_stock === true ||
			(typeof load.product_program === "string" && load.product_program !== "")
		) {
			L.refuse("show_product_stock", ADVANCED_CLAIMS.productStock);
			if (L.used("product_program"))
				L.refuse("product_program", ADVANCED_CLAIMS.productStock);
			r.ok = false;
		} else {
			if (L.used("show_product_stock"))
				L.drop("show_product_stock", ADVANCED_CLAIMS.productStockOff);
			if (L.used("product_program"))
				L.drop("product_program", ADVANCED_CLAIMS.productProgramOff);
		}
		const indexed = indexRead !== undefined;
		const properties = readProperties(
			r,
			L,
			{
				map: ADVANCED_CLAIMS.loadProperties,
				path: ADVANCED_CLAIMS.loadQuestionPath,
				slash: undefined,
			},
			indexed,
		);
		readLoadPreloads(r, L, load, caseType as string, indexed);
		const closeStored = load.close_condition;
		const closes = activeCondition(closeStored);
		// A close that never runs is read as no close. HQ's page stores one with its question,
		// answer and operator cleared (`advanced/actions.js::actionBase.clean_condition`), which
		// is not the schema's default, so the claim is made whether or not it closes.
		consume(
			L.take(
				"close_condition",
				last ? ADVANCED_CLAIMS.ownClose : ADVANCED_CLAIMS.otherClose,
				(value) => value,
			),
		);
		const changes =
			properties.writes.length > 0 ||
			properties.name !== undefined ||
			properties.owner !== undefined ||
			closes;
		chosen.push({
			tag: tag as string,
			caseType: caseType as string,
			detailsModule: detailsId === "" ? module.uniqueId : detailsId,
			...(indexRead !== undefined && { index: indexRead }),
			changes,
		});
		if (listMenu !== undefined) chain.push(listMenu.uuid);
		const placement = tag as string;
		const ref: ProposedCaseRef = last
			? { kind: "session" }
			: { kind: "selected", module: (listMenu ?? module).uuid };
		loadUuids.set(i, ref);
		const condition = (stored: unknown): ProposedCondition | undefined =>
			conditionType(stored) === "if"
				? {
						stored,
						repeat: undefined,
						place: conditionField(form, stored)?.place ?? form.place,
					}
				: undefined;
		if (last) {
			type = closes ? "close" : "followup";
			if (closes) closeCondition = condition(closeStored);
			// A follow-up or close form always carries its own arm, the first change, whether or
			// not its load writes anything (`CASE_OWN_OPERATION`).
			const uuid = mint(r, placement, "own", ordinal(placement, "own"));
			if (uuid !== undefined)
				operations.unshift({
					uuid,
					id: operationId(menuType),
					action: "own",
					tag: placement,
					...(properties.name !== undefined && { name: properties.name }),
					...(properties.owner !== undefined && { owner: properties.owner }),
					writes: properties.writes,
					links: [],
				});
			return;
		}
		let updateUuid: Uuid | undefined;
		if (
			properties.writes.length > 0 ||
			properties.name !== undefined ||
			properties.owner !== undefined
		) {
			updateUuid = mint(r, placement, "update", ordinal(placement, "update"));
			if (updateUuid !== undefined)
				operations.push({
					uuid: updateUuid,
					id: operationId(caseType as string),
					action: "update",
					caseType: caseType as string,
					tag: placement,
					target: ref,
					...(properties.name !== undefined && { rename: properties.name }),
					...(properties.owner !== undefined && { owner: properties.owner }),
					writes: properties.writes,
					links: [],
				});
		}
		if (closes) {
			const closeUuid = mint(
				r,
				placement,
				"close",
				ordinal(placement, "close"),
			);
			const closeOn = condition(closeStored);
			if (closeUuid !== undefined)
				operations.push({
					uuid: closeUuid,
					id: operationId(caseType as string),
					action: "close",
					caseType: caseType as string,
					tag: placement,
					target: ref,
					writes: [],
					links: [],
					...(closeOn !== undefined && { condition: closeOn }),
					...(updateUuid !== undefined && { shares: updateUuid }),
				});
		}
	});

	// The open actions.
	const moduleTypes = new Set(
		ctx.draft.modules.flatMap((one) => {
			const caseType = one.module.caseType ?? one.json.peek("case_type");
			return typeof caseType === "string" && caseType !== "" ? [caseType] : [];
		}),
	);
	const opUuidOfOpen = new Map<number, Uuid>();
	// HQ's build nests a repeat's open actions under `case_<tag>` only where two or more of
	// them carry indices (`xform.py::_create_casexml_advanced`, `get_action_path`, over
	// `AdvancedFormActions.count_subcases_per_repeat_context`); otherwise every open action of
	// the repeat writes its block at the row's one `case`.
	const repeatsWithIndices = new Map<string, number>();
	const repeatsWithOpens = new Map<string, number>();
	storedOpens.forEach((open) => {
		if (!isJsonObject(open)) return;
		const context =
			typeof open.repeat_context === "string" ? open.repeat_context : "";
		if (context === "") return;
		repeatsWithOpens.set(context, (repeatsWithOpens.get(context) ?? 0) + 1);
		const indices = Array.isArray(open.case_indices) ? open.case_indices : [];
		if (indices.length > 0)
			repeatsWithIndices.set(
				context,
				(repeatsWithIndices.get(context) ?? 0) + 1,
			);
	});
	/** Whether the open actions of a repeat share the row's one block. */
	const sharesRowBlock = (context: string) =>
		(repeatsWithOpens.get(context) ?? 0) > 1 &&
		(repeatsWithIndices.get(context) ?? 0) < 2;
	const ownOpenIndex =
		chosen.length === 0
			? storedOpens.findIndex(
					(open) =>
						isJsonObject(open) &&
						open.case_type === menuType &&
						(typeof open.repeat_context !== "string" ||
							open.repeat_context === ""),
				)
			: -1;
	openCursors.forEach((O, j) => {
		const open = storedOpens[j] as Record<string, unknown>;
		const own = j === ownOpenIndex;
		const tag = open.case_tag;
		const tagClaim = tagFinding(tag, true);
		if (tagClaim !== undefined) {
			O.refuseWhole(
				tagClaim,
				typeof tag === "string" && tag !== "" ? { name: tag } : undefined,
			);
			r.ok = false;
			return;
		}
		const caseType = open.case_type;
		if (
			typeof caseType !== "string" ||
			(!moduleTypes.has(caseType) && caseType !== "commcare-user")
		) {
			O.refuseWhole(ADVANCED_CLAIMS.openTypeUnknown, {
				name: String(caseType ?? ""),
			});
			r.ok = false;
			return;
		}
		consume(
			O.take(
				"case_tag",
				own ? ADVANCED_CLAIMS.openOwn : ADVANCED_CLAIMS.openTag,
				(value) => value,
			),
		);
		consume(
			O.take(
				"case_type",
				own ? ADVANCED_CLAIMS.openOwnType : ADVANCED_CLAIMS.openType,
				(value) => value,
			),
		);
		const nameUpdate = consume(
			O.take("name_update", ADVANCED_CLAIMS.openName, (value) => value),
		);
		// No build reads a create's name mode, so the comparison leaves it out and Nova writes it as saved every time.
		if (isJsonObject(nameUpdate) && nameUpdate.update_mode === "edit")
			ctx.facts.sameStateRewrites.push({
				entry: ADVANCED_CLAIMS.openName.entry,
				path: `${O.pointer}/name_update/update_mode`,
				register: "case-settings-respelled",
			});
		const namePath = isJsonObject(nameUpdate)
			? nameUpdate.question_path
			: undefined;
		let name: ProposedValue | undefined;
		if (typeof namePath === "string" && namePath !== "") {
			const read = questionValue(ctx, form, namePath, "name");
			if (read.kind === "finding") {
				ctx.accounting.finding(ADVANCED_CLAIMS.labelQuestion, form.place, {
					name: "name",
				});
				r.ok = false;
			} else name = read.value;
		}
		const properties = readProperties(
			r,
			O,
			{
				map: ADVANCED_CLAIMS.openProperties,
				path: ADVANCED_CLAIMS.openQuestionPath,
				slash: ADVANCED_CLAIMS.openSlashKey,
			},
			false,
			true,
		);
		// The repeat: the name question's innermost.
		const context =
			typeof open.repeat_context === "string" ? open.repeat_context : "";
		const nameRepeat =
			name === undefined ? undefined : repeatOfField(name.field);
		let repeat: DraftField | undefined;
		if (context !== "") {
			if (sharesRowBlock(context)) {
				O.refuse("repeat_context", ADVANCED_CLAIMS.openSharedRepeat);
				r.ok = false;
			} else if (
				nameRepeat !== undefined &&
				repeatAtPath(form, context) === nameRepeat
			) {
				consume(
					O.take(
						"repeat_context",
						ADVANCED_CLAIMS.openRepeat,
						(value) => value,
					),
				);
				repeat = nameRepeat;
			} else {
				O.refuse("repeat_context", ADVANCED_CLAIMS.openRepeatOther);
				r.ok = false;
			}
		} else if (nameRepeat === undefined) {
			// A blank context names the root, where a name question in no repeat stands.
			consume(
				O.take("repeat_context", ADVANCED_CLAIMS.openRepeat, (value) => value),
			);
		}
		const openStored = open.open_condition;
		if (O.used("open_condition"))
			consume(
				O.take(
					"open_condition",
					ADVANCED_CLAIMS.openCondition,
					(value) => value,
				),
			);
		const closeStored = open.close_condition;
		const closes = activeCondition(closeStored);
		// A close that never runs is read as no close, claimed as a load's is.
		consume(
			O.take("close_condition", ADVANCED_CLAIMS.openClose, (value) => value),
		);
		const condition = (stored: unknown): ProposedCondition | undefined =>
			conditionType(stored) === "if"
				? {
						stored,
						repeat,
						place: conditionField(form, stored)?.place ?? form.place,
					}
				: undefined;

		// The links.
		const links: ProposedLink[] = [];
		const indices = Array.isArray(open.case_indices) ? open.case_indices : [];
		if (indices.length > 0) {
			const indexCursors = O.list(
				"case_indices",
				"CaseIndex",
				ADVANCED_CLAIMS.openIndices,
			);
			// Whether an index before this one, on this open action, names an open action.
			let afterOpenIndex = false;
			indexCursors.forEach((I, k) => {
				const index = indices[k] as Record<string, unknown>;
				const indexTag = typeof index.tag === "string" ? index.tag : "";
				const identifier =
					typeof index.reference_id === "string" && index.reference_id !== ""
						? index.reference_id
						: "parent";
				const loadIndex = loadTags.get(indexTag);
				const openIndex = openTags.get(indexTag);
				const namesOpen = openIndex !== undefined && loadIndex === undefined;
				const earlierOpenIndex = afterOpenIndex;
				if (namesOpen) afterOpenIndex = true;
				if (!XML_ELEMENT_NAME_PATTERN.test(identifier)) {
					I.refuseWhole(ADVANCED_CLAIMS.openIndexName, { name: identifier });
					r.ok = false;
					return;
				}
				// A load HQ's entry renames is one the index's `case_id_<tag>` read never finds.
				if (loadIndex !== undefined && loadDatumRenamed(ctx, form, indexTag)) {
					I.refuseWhole(ADVANCED_CLAIMS.openIndexRenamedLoad, {
						name: indexTag,
					});
					r.ok = false;
					return;
				}
				if (index.relationship === "question") {
					const question =
						typeof index.relationship_question === "string"
							? index.relationship_question
							: "";
					const field = question === "" ? undefined : fieldAt(form, question);
					const claim =
						question === ""
							? ADVANCED_CLAIMS.openIndexQuestion
							: field !== undefined && repeatOfField(field) !== undefined
								? ADVANCED_CLAIMS.questionInRepeat
								: namesOpen
									? ADVANCED_CLAIMS.questionToOpen
									: loadIndex !== undefined && earlierOpenIndex
										? ADVANCED_CLAIMS.questionAfterOpenIndex
										: loadIndex !== undefined && loadUuids.has(loadIndex)
											? ADVANCED_CLAIMS.questionToLoad
											: undefined;
					if (claim !== undefined) {
						I.refuseWhole(claim);
						r.ok = false;
						return;
					}
				}
				const relationship =
					index.relationship === "extension" ? "extension" : "child";
				if (loadIndex !== undefined && !loadUuids.has(loadIndex)) {
					// An index to a load the form selects no case for (an auto-selected
					// one) names an action the chain does not hold: nothing here reads it.
					r.ok = false;
					return;
				}
				if (loadIndex !== undefined && loadUuids.has(loadIndex)) {
					const load = storedLoads[loadIndex] as Record<string, unknown>;
					links.push({
						identifier,
						targetType: String(load.case_type),
						relationship,
						target: loadUuids.get(loadIndex) as ProposedCaseRef,
					});
				} else if (
					openIndex !== undefined &&
					openIndex < j &&
					opUuidOfOpen.has(openIndex)
				) {
					const target = storedOpens[openIndex] as Record<string, unknown>;
					const targetContext =
						typeof target.repeat_context === "string"
							? target.repeat_context
							: "";
					if (targetContext !== "" && targetContext !== context) {
						I.refuseWhole(ADVANCED_CLAIMS.openIndexOutsideRepeat);
						r.ok = false;
						return;
					}
					links.push({
						identifier,
						targetType: String(target.case_type),
						relationship,
						target: { kind: "op", uuid: opUuidOfOpen.get(openIndex) as Uuid },
					});
				} else if (openIndex !== undefined) {
					I.refuseWhole(ADVANCED_CLAIMS.openIndexOwnOrLater);
					r.ok = false;
					return;
				} else {
					I.refuseWhole(ADVANCED_CLAIMS.openIndexNoAction);
					r.ok = false;
					return;
				}
				consume(I.take("tag", ADVANCED_CLAIMS.openIndices, (value) => value));
				for (const key of ["reference_id", "relationship"])
					if (I.used(key))
						consume(I.take(key, ADVANCED_CLAIMS.openIndices, (value) => value));
			});
		}
		// HQ's build refuses an open action with no name (`case_name required`,
		// `AdvancedFormValidator.check_actions`), and a `name` among its
		// properties renames the case it opens in the same block, which no
		// create of Nova's holds: neither is dropped unseen.
		const nameless = typeof namePath !== "string" || namePath === "";
		if (nameless || properties.name !== undefined) {
			ctx.accounting.circumstance("unrecognized", form.place, {
				name: nameless
					? "schema:AdvancedOpenCaseAction.name_update"
					: "schema:AdvancedOpenCaseAction.case_properties",
			});
			r.ok = false;
			return;
		}
		// A name question the reader refused is that finding already.
		if (name === undefined) return;
		/** The operation's owner: an owner node it names settled once the operation has its id. */
		const ownerOfOpen = (id: string) =>
			properties.ownerNode === undefined
				? properties.owner
				: settleOwner(r, properties.ownerNode, id, repeat);
		const placementTag = tag as string;
		const row =
			repeat !== undefined && (repeatsWithIndices.get(context) ?? 0) < 2
				? (true as const)
				: undefined;
		if (own) {
			type = "registration";
			openCondition = condition(openStored);
			if (closes) {
				closeCondition = condition(closeStored);
				closesAlways = conditionType(closeStored) === "always";
			}
			const uuid = mint(r, placementTag, "own", ordinal(placementTag, "own"));
			if (uuid === undefined) return;
			opUuidOfOpen.set(j, uuid);
			const id = openOperationId(caseType, properties.ownerNode);
			const owner = ownerOfOpen(id);
			operations.unshift({
				uuid,
				id,
				action: "own",
				tag: placementTag,
				name,
				...(owner !== undefined && { owner }),
				writes: properties.writes,
				links,
			});
			return;
		}
		const uuid = mint(
			r,
			placementTag,
			"create",
			ordinal(placementTag, "create"),
		);
		if (uuid === undefined) return;
		opUuidOfOpen.set(j, uuid);
		const openOn = condition(openStored);
		const id = openOperationId(caseType, properties.ownerNode);
		const owner = ownerOfOpen(id);
		operations.push({
			uuid,
			id,
			action: "create",
			caseType,
			tag: placementTag,
			...(row !== undefined && { row }),
			name,
			...(owner !== undefined && { owner }),
			writes: properties.writes,
			...(openOn !== undefined && { condition: openOn }),
			...(repeat !== undefined && { forEach: repeat }),
			target: { kind: "new" },
			links,
		});
		if (closes) {
			const closeUuid = mint(
				r,
				placementTag,
				"close",
				ordinal(placementTag, "close"),
			);
			const closeOn = condition(closeStored);
			if (closeUuid !== undefined)
				operations.push({
					uuid: closeUuid,
					id: operationId(caseType),
					action: "close",
					caseType,
					tag: placementTag,
					target: { kind: "op", uuid },
					writes: [],
					links: [],
					...(closeOn !== undefined && { condition: closeOn }),
					...(repeat !== undefined && { forEach: repeat }),
					shares: uuid,
				});
		}
	});
	// The worker's record is written last.
	const workerIndex = operations.findIndex(
		(one) => one.target?.kind === "worker-record",
	);
	if (workerIndex !== -1) operations.push(...operations.splice(workerIndex, 1));

	ctx.writeDraft(() => {
		form.form.type = type;
	});
	READINGS.set(form, {
		type,
		operations,
		...(openCondition !== undefined && { openCondition }),
		...(closeCondition !== undefined && { closeCondition }),
		...(closesAlways ? { closesAlways: true as const } : {}),
		chosen,
		...(worker !== undefined && { worker }),
		...(chainOk && chain.length === chosen.length && { chain: [...chain] }),
	});
}

/** Whether a disabled schedule's conditions name a question the form no longer has. */
function scheduleNamesMissingQuestion(
	form: DraftForm,
	schedule: Readonly<Record<string, unknown>>,
): boolean {
	for (const key of ["transition_condition", "termination_condition"]) {
		const condition = schedule[key];
		if (conditionType(condition) !== "if") continue;
		if (conditionField(form, condition) === undefined) return true;
	}
	return false;
}

/** An auto-selected load: the worker's record where it writes it, else its finding. */
function readAutoSelectLoad(
	r: Reading,
	L: JsonCursor,
	load: Readonly<Record<string, unknown>>,
	earlierTags: ReadonlySet<string>,
	operations: AdvancedProposal[],
	operationId: (type: string) => string,
	ordinal: (tag: string, action: string) => number,
): StoredLoad | undefined {
	const auto = isJsonObject(load.auto_select) ? load.auto_select : {};
	const mode = auto.mode;
	const C = ADVANCED_CLAIMS;
	if (
		typeof mode !== "string" ||
		mode === "" ||
		typeof load.case_type !== "string" ||
		load.case_type === ""
	) {
		L.refuseWhole(C.autoBlank);
		r.ok = false;
		return undefined;
	}
	const key = auto.value_key;
	if (mode !== "usercase" && (typeof key !== "string" || key === "")) {
		L.refuseWhole(C.autoMissingKey);
		r.ok = false;
		return undefined;
	}
	if (mode === "raw") return refuseLoad(r, L, C.autoRaw);
	if (mode === "user") return refuseLoad(r, L, C.autoUser);
	if (mode === "fixture") return refuseLoad(r, L, C.autoFixture);
	if (mode === "case") {
		const source = auto.value_source;
		const earlier = earlierTags.has(typeof source === "string" ? source : "");
		return refuseLoad(r, L, earlier ? C.autoCase : C.autoCaseLater);
	}
	if (mode !== "usercase") return refuseLoad(r, L, C.autoBlank);
	const tag = load.case_tag;
	const properties = readProperties(
		r,
		L,
		{ map: C.loadProperties, path: C.loadQuestionPath, slash: undefined },
		false,
	);
	if (
		properties.writes.length === 0 ||
		activeCondition(load.close_condition) ||
		properties.name !== undefined ||
		properties.owner !== undefined ||
		typeof tag !== "string" ||
		tag === "" ||
		tagFinding(tag, false) !== undefined
	) {
		L.refuseWhole(
			C.usercaseWritesNothing,
			typeof tag === "string" && tag !== "" ? { name: tag } : undefined,
		);
		r.ok = false;
		return undefined;
	}
	// The worker's load Nova writes names no value and saves answers outside
	// any repeat: a stray `value_source` or `value_key`, or a write from a
	// repeat's question, is a load Nova does not write, never claimed unseen.
	const stray = ["value_source", "value_key"].find(
		(one) => typeof auto[one] === "string" && auto[one] !== "",
	);
	const repeated = properties.writes.some(
		(write) => repeatOfField(write.value.field) !== undefined,
	);
	if (stray !== undefined || repeated) {
		r.ctx.accounting.circumstance("unrecognized", r.form.place, {
			name:
				stray !== undefined
					? `schema:AutoSelectCase.${stray}`
					: "schema:LoadUpdateAction.case_properties",
		});
		r.ok = false;
		return undefined;
	}
	// The index: none on an auto-selected load. HQ's page stores one with a blank tag, which
	// indexes nothing (`advanced/actions.js`, `case_index.tag('')`).
	const index = isJsonObject(load.case_index) ? load.case_index : {};
	if (typeof index.tag === "string" && index.tag !== "") {
		L.refuse("case_index", C.caseIndexOnFirst);
		r.ok = false;
		return undefined;
	}
	if (L.used("case_index"))
		consume(L.take("case_index", C.caseIndex, (value) => value));
	if (
		load.show_product_stock === true ||
		(typeof load.product_program === "string" && load.product_program !== "")
	) {
		L.refuse("show_product_stock", C.productStock);
		if (L.used("product_program")) L.refuse("product_program", C.productStock);
		r.ok = false;
		return undefined;
	}
	if (L.used("show_product_stock"))
		L.drop("show_product_stock", C.productStockOff);
	if (L.used("product_program")) L.drop("product_program", C.productProgramOff);
	// A close that never runs is read as no close, claimed as another selection's is.
	consume(L.take("close_condition", C.otherClose, (value) => value));
	consume(L.take("auto_select", C.usercase, (value) => value));
	consume(L.take("case_tag", C.tag, (value) => value));
	consume(L.take("case_type", C.caseType, (value) => value));
	const uuid = mint(r, tag, "update", ordinal(tag, "update"));
	if (uuid !== undefined)
		operations.push({
			uuid,
			id: operationId("commcare-user"),
			action: "update",
			caseType: "commcare-user",
			tag,
			target: { kind: "worker-record" },
			writes: properties.writes,
			links: [],
		});
	return { tag, caseType: "commcare-user", detailsModule: "", changes: true };
}

function refuseLoad(
	r: Reading,
	L: JsonCursor,
	claim: Claim<"refuse">,
): undefined {
	L.refuseWhole(claim);
	r.ok = false;
	return undefined;
}

/** A load's `preload`: each into a question outside any repeat, from a
 *  property with no `/`, read as the question's default; any other is the
 *  finding that it would hold its place at the end of the load. */
function readLoadPreloads(
	r: Reading,
	L: JsonCursor,
	load: Readonly<Record<string, unknown>>,
	caseType: string,
	indexed: boolean,
): void {
	const preload = isJsonObject(load.preload) ? load.preload : {};
	if (Object.keys(preload).length === 0) return;
	if (
		indexed &&
		Object.values(preload).some(
			(property) => typeof property === "string" && property.includes("/"),
		)
	) {
		L.refuse("preload", ADVANCED_CLAIMS.slashPreloadOnIndexedLoad);
		r.ok = false;
		return;
	}
	const entries = Object.entries(preload).map(([path, property]) => ({
		path,
		property,
		field: fieldAt(r.form, path),
	}));
	const label = entries.find(
		({ field }) => field?.kind === "label" || field === undefined,
	);
	if (label !== undefined) {
		L.refuse("preload", ADVANCED_CLAIMS.labelQuestion);
		r.ok = false;
		return;
	}
	const noDefault = entries.find(
		({ field }) => field !== undefined && !holdsDefault(r.form, field),
	);
	if (noDefault !== undefined) {
		L.refuse("preload", ADVANCED_CLAIMS.preloadNoDefault);
		r.ok = false;
		return;
	}
	const later = entries.find(
		({ field, property }) =>
			field === undefined ||
			repeatOfField(field) !== undefined ||
			typeof property !== "string" ||
			property.includes("/"),
	);
	if (later !== undefined) {
		L.refuse("preload", ADVANCED_CLAIMS.preloadLater);
		r.ok = false;
		return;
	}
	consume(L.take("preload", ADVANCED_CLAIMS.preload, (value) => value));
	// Nova writes the load as each question's default, never as a stored
	// preload: the first publish respells the case settings.
	if (entries.length > 0)
		r.ctx.facts.sameStateRewrites.push({
			entry: ADVANCED_CLAIMS.preload.entry,
			path: `${L.pointer}/preload`,
			register: "case-settings-respelled",
		});
	for (const { field, property } of entries) {
		const question = field as DraftField;
		const read: Term = {
			kind: "form-case",
			caseType,
			property: property === "name" ? "case_name" : (property as string),
		};
		writeDefault(r.ctx, r.form, question, term(read));
		addPreloadCandidate(r.form, {
			field: question,
			place: question.place,
			moves: ADVANCED_CLAIMS.preloadLater,
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

function conditionOf(
	form: DraftForm,
	condition: ProposedCondition | undefined,
): Expression | undefined {
	if (condition === undefined) return undefined;
	const read = readActionCondition(
		condition.stored,
		{ own: false, repeat: condition.repeat?.uuid },
		form,
	);
	return read.kind === "if" ? read.expression : undefined;
}

function selectedCase(module: Uuid): Expression {
	return term({
		kind: "session-datum",
		datum: { kind: "selected-case", module },
	} as never);
}

function caseTarget(
	ref: NonNullable<AdvancedProposal["target"]>,
): TargetedCaseOperation["target"] {
	switch (ref.kind) {
		case "session":
			return { kind: "session" };
		case "selected":
			return { kind: "expression", expr: selectedCase(ref.module) };
		case "op":
			return { kind: "op", opUuid: ref.uuid };
		case "worker-record":
			return { kind: "worker-record" };
		case "new":
			return { kind: "new" };
	}
}

function linkTarget(ref: ProposedCaseRef): CaseOperationLink["target"] {
	switch (ref.kind) {
		case "session":
			return { kind: "session" };
		case "selected":
			return { kind: "expression", expr: selectedCase(ref.module) };
		case "op":
			return { kind: "op", opUuid: ref.uuid };
	}
}

function ownerOf(owner: AdvancedProposal["owner"]): Expression | undefined {
	if (owner === undefined) return undefined;
	if (owner === "acting-user") return actingUser();
	if (owner === "unowned") return unowned();
	return valueExpression(owner);
}

/** Writes one advanced form's proposed operations and conditions into its draft. */
export function writeAdvancedOperations(
	ctx: ReadContext,
	form: DraftForm,
): void {
	const reading = READINGS.get(form);
	if (reading === undefined) return;
	const operations: CaseOperation[] = [];
	for (const proposal of reading.operations) {
		const writes: CaseOperationWrite[] = [];
		for (const write of proposal.writes) {
			const value = valueExpression(write.value);
			if (value !== undefined) writes.push({ property: write.property, value });
		}
		const placement = {
			kind: "advanced" as const,
			tag: proposal.tag,
			...(proposal.row !== undefined && { row: true as const }),
		};
		// A case the action opens is the worker's where it states no owner
		// (`generatedNodes.ts::advancedOwnerNodeValue`), so the worker's owner
		// node reads as none (`assemble.ts`, `opened-case-owner-acting-user-is-absent`).
		const owner =
			proposal.owner === "acting-user" &&
			(proposal.action === "own" || proposal.action === "create")
				? undefined
				: ownerOf(proposal.owner);
		const name =
			proposal.name === undefined ? undefined : valueExpression(proposal.name);
		const rename =
			proposal.rename === undefined
				? undefined
				: valueExpression(proposal.rename);
		const condition = conditionOf(form, proposal.condition);
		const links: CaseOperationLink[] = proposal.links.map(
			(link) =>
				({
					identifier: link.identifier,
					targetType: link.targetType,
					relationship: link.relationship,
					target: linkTarget(link.target),
				}) as CaseOperationLink,
		);
		const forEach =
			proposal.forEach?.uuid === undefined
				? undefined
				: { repeat: proposal.forEach.uuid };
		const common = {
			uuid: proposal.uuid,
			id: proposal.id,
			...(writes.length > 0 && { writes }),
			...(proposal.shares === undefined && { placement }),
		};
		if (proposal.action === "own")
			operations.push({
				...common,
				action: "own",
				...(name !== undefined && { name }),
				...(owner !== undefined && { owner }),
				...(links.length > 0 && { links }),
			} as CaseOperation);
		else if (proposal.action === "create" && name !== undefined)
			operations.push({
				...common,
				action: "create",
				caseType: proposal.caseType as string,
				target: { kind: "new" },
				name,
				...(owner !== undefined && { owner }),
				...(links.length > 0 && { links }),
				...(condition !== undefined && { condition }),
				...(forEach !== undefined && { forEach }),
			} as CaseOperation);
		else if (proposal.action === "update")
			operations.push({
				...common,
				action: "update",
				caseType: proposal.caseType as string,
				target: caseTarget(proposal.target ?? { kind: "session" }),
				...(owner !== undefined && { owner }),
				...(rename !== undefined && { rename }),
			} as CaseOperation);
		else if (proposal.action === "close")
			operations.push({
				uuid: proposal.uuid,
				id: proposal.id,
				...(proposal.shares === undefined && { placement }),
				action: "close",
				caseType: proposal.caseType as string,
				target: caseTarget(proposal.target ?? { kind: "session" }),
				...(condition !== undefined && { condition }),
				...(forEach !== undefined && { forEach }),
			} as CaseOperation);
	}
	const open = conditionOf(form, reading.openCondition);
	const close =
		reading.closesAlways === true
			? matchAll()
			: conditionOf(form, reading.closeCondition);
	ctx.writeDraft(() => {
		if (operations.length > 0) form.form.caseOperations = operations;
		if (open !== undefined) form.form.openCondition = open;
		if (close !== undefined) form.form.closeCondition = close;
	});
}

/** Each menu's parent selection from its forms' loads (step 4), and each
 *  form whose chain differs from the menu's one chain (its finding). */
export function writeAdvancedChains(ctx: ReadContext): void {
	for (const module of ctx.draft.modules) {
		if (module.docType !== "AdvancedModule") continue;
		const forms = module.forms.filter((form) => READINGS.has(form));
		const { chain, disagreeing } = readLoadChain(module, forms);
		for (const { form, tag } of disagreeing)
			ctx.accounting.finding(ADVANCED_CLAIMS.notOneChain, form.place, {
				name: tag,
			});
		if (chain === undefined || chain.length < 2) continue;
		const parent = chain[chain.length - 2] as Uuid;
		ctx.writeDraft(() => {
			module.module.parentCaseModuleUuid = parent;
		});
	}
}

// ── Pass 2: acceptance by re-emission ───────────────────────────────────

/** What step 5 of the chain test finds: nothing, a load whose only
 *  difference is a tag Nova would not derive, or a chain that differs. */
export type LoadsVerdict =
	| { readonly kind: "same" }
	| { readonly kind: "tag"; readonly tag: string }
	| { readonly kind: "chain"; readonly tag: string };

/**
 * Step 5 of the chain test: Nova's loads for the form over `doc` against
 * HQ's chosen loads, in count, order, case type, list menu and index, then
 * the worker's load. `menuIdOf` names a planned list menu by the id the
 * source gives it.
 */
export function judgeLoads(
	planned: readonly PlannedLoad[],
	chosen: readonly StoredLoad[],
	worker: StoredLoad | undefined,
	menuIdOf: (uuid: Uuid) => string,
): LoadsVerdict {
	const plannedChosen = planned.filter((load) => !load.worker);
	const plannedWorker = planned.find((load) => load.worker);
	const lastTag = chosen[chosen.length - 1]?.tag ?? worker?.tag ?? "";
	if (plannedChosen.length !== chosen.length)
		return { kind: "chain", tag: lastTag };
	let tagOnly: string | undefined;
	for (let i = 0; i < chosen.length; i++) {
		const ours = plannedChosen[i] as PlannedLoad;
		const theirs = chosen[i] as StoredLoad;
		if (
			ours.caseType !== theirs.caseType ||
			ours.listModule === null ||
			menuIdOf(ours.listModule) !== theirs.detailsModule ||
			(ours.index === undefined) !== (theirs.index === undefined) ||
			(ours.index !== undefined &&
				ours.index.identifier !== theirs.index?.identifier)
		)
			return { kind: "chain", tag: theirs.tag };
		const sameIndexTag =
			ours.index === undefined ||
			ours.index.tag === theirs.index?.tag ||
			// An index names the load before it: a tag that differs there is that load's.
			plannedChosen[i - 1]?.tag !== chosen[i - 1]?.tag;
		if (!sameIndexTag) return { kind: "chain", tag: theirs.tag };
		if (ours.tag !== theirs.tag) {
			if (theirs.changes) return { kind: "chain", tag: theirs.tag };
			tagOnly ??= theirs.tag;
		}
	}
	if ((plannedWorker === undefined) !== (worker === undefined))
		return { kind: "chain", tag: worker?.tag ?? lastTag };
	if (
		plannedWorker !== undefined &&
		worker !== undefined &&
		plannedWorker.tag !== worker.tag
	)
		return { kind: "chain", tag: worker.tag };
	return tagOnly === undefined
		? { kind: "same" }
		: { kind: "tag", tag: tagOnly };
}

type JsonObject = Readonly<Record<string, unknown>>;

function object(value: unknown): JsonObject {
	return isJsonObject(value) ? value : {};
}

/** A question path of `form`, mapped through each generated node to the
 *  question it belongs to; an owner node as `#owner:` and its path. */
function ownerPathOf(form: DraftForm, path: unknown): string | null {
	if (typeof path !== "string" || path === "") return null;
	const xform = form.xform;
	if (xform === null) return path;
	const relative = conditionQuestionPath(form, path) ?? path;
	const node = xform.nodes.get(relative);
	const role = node === undefined ? undefined : xform.roles.get(node);
	if (role?.kind === "generated")
		return role.purpose === "owner"
			? `#owner:${relative}`
			: role.owner.path.join("/");
	if (role?.kind === "generated-candidate")
		return role.purpose === "owner" ? `#owner:${relative}` : relative;
	return relative;
}

/** A planned question path; an owner node the plan names (each in
 *  `plannedOwnerPaths` by its path from the data root) as `#owner:` and
 *  that path, so which open action names which node is compared by name. */
function plannedPath(
	form: DraftForm,
	path: unknown,
	plannedOwnerPaths: ReadonlySet<string>,
): string | null {
	if (typeof path !== "string" || path === "") return null;
	const root = form.xform?.parsed.dataRoot.name ?? "data";
	const relative = path.startsWith(`/${root}/`)
		? path.slice(root.length + 2)
		: path.startsWith("/data/")
			? path.slice(6)
			: path;
	return plannedOwnerPaths.has(relative) ? `#owner:${relative}` : relative;
}

function conditionShape(
	stored: unknown,
	mapPath: (path: unknown) => string | null,
): unknown {
	const value = object(stored);
	const type = value.type ?? "never";
	if (type !== "if") return type;
	return {
		question: mapPath(value.question),
		answer: value.answer ?? null,
		operator: value.operator ?? "=",
	};
}

function propertiesShape(
	stored: unknown,
	mapPath: (path: unknown) => string | null,
	applied: boolean,
): unknown {
	return Object.entries(object(stored))
		.map(([key, update]) => {
			const one = object(update);
			return [
				key,
				mapPath(one.question_path),
				one.update_mode === "edit" && applied ? "edit" : "always",
			];
		})
		.sort(([a], [b]) =>
			String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
		);
}

/** An advanced form's actions as the comparison reads them: the loads'
 *  tags and lists left to the chain test, preloads read as defaults, each
 *  `name_update`'s mode left out, and every question path mapped to its
 *  question. */
function comparableActions(
	actions: unknown,
	mapPath: (path: unknown) => string | null,
	applied: boolean,
): unknown {
	const stored = object(actions);
	const loads = Array.isArray(stored.load_update_cases)
		? stored.load_update_cases
		: [];
	const opens = Array.isArray(stored.open_cases) ? stored.open_cases : [];
	return {
		loads: loads.map((one) => {
			const load = object(one);
			return {
				case_properties: propertiesShape(
					load.case_properties,
					mapPath,
					applied,
				),
				close_condition: conditionShape(load.close_condition, mapPath),
				auto_select: isJsonObject(load.auto_select)
					? object(load.auto_select).mode
					: null,
			};
		}),
		opens: opens.map((one) => {
			const open = object(one);
			const indices = Array.isArray(open.case_indices) ? open.case_indices : [];
			return {
				case_type: open.case_type,
				case_tag: open.case_tag,
				name: mapPath(object(open.name_update).question_path),
				case_properties: propertiesShape(
					open.case_properties,
					mapPath,
					applied,
				),
				repeat_context: mapPath(open.repeat_context),
				case_indices: indices.map((index) => {
					const value = object(index);
					return {
						tag: value.tag,
						reference_id: value.reference_id || "parent",
						relationship: value.relationship ?? "child",
					};
				}),
				open_condition: conditionShape(open.open_condition, mapPath),
				close_condition: conditionShape(open.close_condition, mapPath),
			};
		}),
	};
}

/**
 * Accepts one advanced form over the bound document: its conditions stated
 * back, its loads Nova's (step 5), its actions the stored ones, every
 * placement held where it was read, and the owner nodes the plan names the
 * ones the form reader folded.
 */
export function settleAdvancedForm(
	ctx: ReadContext,
	doc: BlueprintDoc,
	form: DraftForm,
): void {
	const reading = READINGS.get(form);
	if (reading === undefined || doc.forms[form.uuid] === undefined) return;
	for (const proposal of [
		...reading.operations.map((one) => one.condition),
		reading.openCondition,
		reading.closeCondition,
	]) {
		if (proposal === undefined) continue;
		const scope = { own: false, repeat: proposal.repeat?.uuid };
		const read = readActionCondition(proposal.stored, scope, form);
		if (read.kind !== "if") continue;
		const stated = statedBack(doc, form.uuid, read.expression, scope);
		if (stated.reasons.length > 0) {
			const claim = conditionFinding(stated.reasons, false);
			if (claim !== undefined) ctx.accounting.finding(claim, proposal.place);
			else
				ctx.accounting.circumstance("unrecognized", form.place, {
					name: "schema:FormActionCondition.question",
				});
			return;
		}
	}
	const inputs = readProjectionInputs(ctx);
	let planned: ReturnType<typeof planFormCaseWire>;
	try {
		planned = planFormCaseWire(doc, form.uuid, {
			identity: inputs.identity,
			attachmentTarget: inputs.attachmentTarget,
		});
	} catch {
		ctx.accounting.circumstance("unrecognized", form.place, {
			name: "planFormCaseWire",
		});
		return;
	}
	if (planned.kind !== "advanced") {
		// A menu whose kind Nova cannot hold already stands as its one finding
		// at the menu; a basic plan for any other cause is a reading Nova
		// would write another way.
		const menu = ctx.draft.modules.find((one) => one.forms.includes(form));
		if (menu === undefined || !ctx.accounting.hasFindingAt(menu.place))
			ctx.accounting.circumstance("unrecognized", form.place, {
				name: "schema:Form.actions",
			});
		return;
	}
	const verdict = judgeLoads(
		planned.loads,
		reading.chosen,
		reading.worker,
		(uuid) => inputs.identity.moduleUniqueId(uuid),
	);
	if (verdict.kind === "tag") {
		ctx.accounting.finding(ADVANCED_CLAIMS.underivedTag, form.place, {
			name: verdict.tag,
		});
		return;
	}
	if (verdict.kind === "chain") {
		if (!ctx.accounting.hasFindingAt(form.place))
			ctx.accounting.finding(ADVANCED_CLAIMS.notOneChain, form.place, {
				name: verdict.tag,
			});
		return;
	}
	const applied = ctx.input.saveOnlyEditedApplied === true;
	const plannedOwnerPaths = new Set(
		planned.generated.map((node) =>
			// `/<root>/...`: the path from the data root.
			node.scope.child(node.name).toXPath().split("/").slice(2).join("/"),
		),
	);
	if (
		!sameJson(
			comparableActions(
				form.json.peek("actions"),
				(path) => ownerPathOf(form, path),
				applied,
			),
			comparableActions(
				planned.actions,
				(path) => plannedPath(form, path, plannedOwnerPaths),
				true,
			),
		)
	) {
		ctx.accounting.circumstance("unrecognized", form.place, {
			name: "schema:AdvancedForm.actions",
		});
		return;
	}
	const plan = planPlacements(doc, form.uuid);
	const operations = doc.forms[form.uuid]?.caseOperations ?? [];
	// A close with no placement shares the place of the action it was read
	// from: the create it closes, or its load's update.
	const sharedWith = (uuid: Uuid): Uuid | undefined =>
		reading.operations.find((one) => one.uuid === uuid)?.shares;
	const held =
		plan.inexpressible.length === 0 &&
		operations.every((operation) => {
			const placed = plan.placements.get(operation.uuid);
			if (operation.placement !== undefined) return placed?.held === true;
			const shares = sharedWith(operation.uuid);
			return shares !== undefined && placed?.sharesWith === shares;
		});
	// The own close, where the form closes its own case, shares the own arm's place.
	const own = operations.find((operation) => operation.action === "own");
	const formDoc = doc.forms[form.uuid];
	const closesOwn =
		formDoc?.type === "close" ||
		(formDoc?.type === "registration" && formDoc.closeCondition !== undefined);
	const ownCloseHeld =
		!closesOwn ||
		own === undefined ||
		formDoc?.ownClosePlacement !== undefined ||
		plan.placements.get("own-close")?.sharesWith === own.uuid;
	// The owner nodes the plan names are the ones the form reader folded, one to one by the
	// operation each serves.
	const folded = (form.xform?.generated ?? [])
		.filter((node) => node.purpose === "owner")
		.map((node) => node.owner.slice(node.owner.lastIndexOf("#") + 1))
		.sort();
	const plannedOwners = planned.generated
		.map(
			(node) =>
				operations.find((operation) => operation.uuid === node.operationUuid)
					?.id ?? "",
		)
		.sort();
	if (!held || !ownCloseHeld || !sameJson(folded, plannedOwners))
		ctx.accounting.circumstance("unrecognized", form.place, {
			name: "schema:AdvancedForm.actions",
		});
}

/** A menu read with a held kind that Nova would write basic: one finding at the menu. */
export function settleAdvancedMenu(
	ctx: ReadContext,
	doc: BlueprintDoc,
	module: DraftModule,
): void {
	if (
		module.docType !== "AdvancedModule" ||
		doc.modules[module.uuid] === undefined
	)
		return;
	if (advancedKindBlockers(doc, module.uuid).length > 0)
		ctx.accounting.finding(ADVANCED_CLAIMS.kindBlocked, module.place);
}
