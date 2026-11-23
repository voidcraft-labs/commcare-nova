/**
 * Registration from the case list (`case_list_form`), by the order in which
 * a block made in CommCare HQ falls into its row, the first that holds: a
 * blank block reads as nothing; a block HQ's build or a running app refuses
 * is a finding; the hidden menu Nova's emission makes for a registration
 * offered after an empty search folds back into its host; every other block
 * is a registration the case list always offers. Each label reads as the
 * text HQ's build writes for it.
 */

import type { HqApplication } from "@/lib/commcare";
import {
	type BlueprintDoc,
	declaresWebApps,
	makeTranslationUnitId,
	type Uuid,
} from "@/lib/domain";
import { advancedRegistrationTarget } from "@/lib/domain/caseListActionTargets";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import { caseListFormLabelUnit } from "../../emissionPlan";
import { formChoosesCase } from "../../hq/entryFacts";
import { emptyShortListColumns } from "../../hqJson/caseList";
import { hqXPath, serializeHqModule } from "../../hqJson/xpath";
import { detailPair, moduleShell } from "../../hqShells";
import { repeatForLanguages } from "../../localization";
import { caseListActionUndeclaredInstances } from "../../suite/case-list/actionCondition";
import { EMPTY_CASE_LIST_TEXT } from "../../suite/case-list/detailTexts";
import {
	NEVER_RELEVANT,
	NO_MATCHES_RELEVANCY,
} from "../../suite/case-search/noMatches";
import { servedSchemaPropertyDefault } from "../../surface/schemaDefaults";
import type { ValidationError } from "../../validator/errors";
import {
	caseListRegistrationApp,
	caseListRegistrationForm,
	caseListRegistrationFormInModule,
} from "../../validator/rules/case-search/caseListRegistration";
import { caseListReturnFirstMenuCase } from "../../validator/rules/formsInMenuAbove";
import { serializeWire } from "../../xpath/wire/serialize";
import { withCandidate } from "../candidate";
import {
	type Claim,
	defineClaims,
	derived,
	drop,
	refuse,
	take,
} from "../claims";
import type { DraftApp, DraftForm, DraftModule, ReadContext } from "../context";
import {
	recordTextRewrite,
	refuseLineEndKey,
	refuseUnheldText,
} from "../heldText";
import { isJsonObject, objectMembers, sameJson } from "../jsonCursor";
import { pendingPlaceholder } from "../pendingExpressions";
import { keptMediaPaths } from "../projectionInputs";
import { sameXPathText } from "../syntaxCompare";
import {
	appLanguageCodes,
	caseListPlaceOf,
	draftFormByReadId,
	effectiveNames,
	heldLabel,
	labelAsBuilt,
	labelMap,
	labelSpelledAsBuilt,
	rawForms,
	rawModuleById,
	rawModules,
	selectsSeveral,
	unheldLabel,
	withReadTranslations,
	writeBuiltLabel,
} from "./modules";
import { readNavMedia, shownBlockMedia } from "./navMedia";

const M = "menus-and-case-lists";

type MenuClass = DraftModule["docType"];

/** The registration rows that read the whole block, each per host class. */
function blockClaims<U extends "take" | "refuse" | "drop">(
	make: (entry: string, key: string) => Claim<U>,
	entry: string,
): Readonly<Record<MenuClass, Claim<U>>> {
	return {
		Module: make(`${M}/${entry}`, "schema:Module.case_list_form"),
		ShadowModule: make(`${M}/${entry}`, "schema:ShadowModule.case_list_form"),
		AdvancedModule: make(
			`${M}/${entry}`,
			"schema:AdvancedModule.case_list_form",
		),
	};
}

const REGISTRATION = {
	blank: blockClaims(drop, "case-list-form-fields-beside-a-blank-form-id"),
	missing: blockClaims(
		refuse,
		"case-list-form-missing-not-a-registration-form-toggle-off-or",
	),
	topLevelAbove: blockClaims(
		drop,
		"case-list-form-on-a-top-level-put-in-root-module-whose-case-list",
	),
	childAbove: blockClaims(
		refuse,
		"case-list-form-on-a-child-put-in-root-module-whose-parent-s-case",
	),
	tileAbove: blockClaims(
		refuse,
		"case-list-form-on-a-put-in-root-module-whose-case-list-is-a-tile",
	),
	notCaseFirst: blockClaims(
		refuse,
		"case-list-form-on-a-module-whose-forms-do-not-all-require-a-case",
	),
	advanced: blockClaims(
		take,
		"case-list-form-on-an-advanced-module-or-naming-an-advanced-form",
	),
	advancedRulesBroken: refuse(
		"forms-and-case-writes/advanced-forms-in-a-module-whose-case-list-offers-a-registration",
		"schema:AdvancedModule.case_list_form",
	),
	childCase: blockClaims(
		take,
		"case-list-form-pointing-at-a-form-whose-one-registration-of-the-type-is-a-child-case",
	),
	anotherList: blockClaims(
		take,
		"case-list-form-naming-a-form-another-list-offers-after-an-empty-search",
	),
	sharedFirstMenuCase: derived(
		`${M}/case-list-form-on-a-host-under-a-menu-that-shares-the-first-menu-s-case`,
		"schema:Module.case_list_form",
	),
	sharesFirstMenuCase: refuse(
		`${M}/first-menu-registration-return-without-a-compatible-case`,
		"schema:Module.case_list_form",
	),
	parentFollowUp: blockClaims(
		take,
		"case-list-form-pointing-at-a-follow-up-form-of-the-parent-case",
	),
	hiddenDefault: blockClaims(
		take,
		"case-list-form-post-form-workflow-default-on-the-hidden-module-shape",
	),
	multiSelectDefault: blockClaims(
		refuse,
		"case-list-form-post-form-workflow-default-on-a-multi-select-host",
	),
	hidden: blockClaims(
		take,
		"case-list-form-on-a-search-first-host-pointing-at-a-registration",
	),
	hiddenFormId: take(
		`${M}/case-list-form-on-a-search-first-host-pointing-at-a-registration`,
		"schema:CaseListForm.form_id",
	),
	/** The hidden-menu shape's own relevancy, Nova's no-matches condition, which the settle
	 *  compares with the expansion's. */
	hiddenRelevancy: take(
		`${M}/case-list-form-on-a-search-first-host-pointing-at-a-registration`,
		"schema:CaseListForm.relevancy_expression",
	),
	always: blockClaims(
		take,
		"case-list-form-pointing-at-a-registration-form-in-another-module",
	),
	alwaysFormId: take(
		`${M}/case-list-form-pointing-at-a-registration-form-in-another-module`,
		"schema:CaseListForm.form_id",
	),
	label: take(`${M}/case-list-form-label-lang`, "schema:CaseListForm.label"),
	labelEmpty: take(
		`${M}/case-list-form-label-empty`,
		"schema:CaseListForm.label",
	),
	workflow: take(
		`${M}/case-list-form-post-form-workflow-default-case-list`,
		"schema:CaseListForm.post_form_workflow",
	),
	relevancyInert: drop(
		`${M}/case-list-form-relevancy-expression-without-that-toggle`,
		"schema:CaseListForm.relevancy_expression",
	),
	relevancyHeld: take(
		`${M}/case-list-form-relevancy-expression-with-followup-forms-as-case`,
		"schema:CaseListForm.relevancy_expression",
	),
	customIcons: drop(
		`${M}/case-list-action-badges`,
		"schema:CaseListForm.custom_icons",
	),
} as const;

defineClaims(
	"menus.registration",
	recordFromEntries(
		Object.entries(REGISTRATION).flatMap(([name, one]) =>
			"use" in one
				? [[name, one as Claim]]
				: Object.entries(one as Record<string, Claim>).map(([cls, claim]) => [
						`${name}@${cls}`,
						claim,
					]),
		),
	) as Record<string, Claim>,
);

/** HQ's build's words for a Register action with no text of its own
 *  (`app_strings.py::_create_case_list_form_app_strings`). */
const CREATE_A_NEW_CASE = "Create a new Case";

type JsonObject = Readonly<Record<string, unknown>>;

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function blank(value: unknown): boolean {
	return (
		value === null ||
		value === undefined ||
		(typeof value === "string" && value.trim() === "")
	);
}

/** The Register action's relevancy Nova's emission writes, as HQ JSON text. */
const NO_MATCHES_TEXT = serializeWire(NO_MATCHES_RELEVANCY, {
	target: "hq-json",
	interpolation: "none",
}).text;

type RegistrationSource =
	| { kind: "own" }
	| { kind: "child"; index: number }
	| { kind: "advanced"; tag: string };
type ListTargetSource =
	| RegistrationSource
	| { kind: "parent"; moduleUuid: Uuid };

/** The registration actions HQ considers, including a stored basic subcase
 * outside a repeat whose condition no longer runs. Its presence still affects
 * the form's eligibility (Form.get_registration_actions). */
function registrationsOf(
	form: JsonObject,
	formMenuType: string,
	caseType?: string,
): RegistrationSource[] {
	const actions = isJsonObject(form.actions) ? form.actions : NO_ENTRIES;
	if (form.doc_type === "AdvancedForm") {
		const opens = (objectMembers(actions.open_cases) ?? []).map((open) => ({
			tag: textOf(open.case_tag),
			parents: (objectMembers(open.case_indices) ?? []).map((index) =>
				textOf(index.tag),
			),
			caseType: textOf(open.case_type),
			repeat: !blank(open.repeat_context),
		}));
		const candidates = opens.filter(
			(open) =>
				(!open.repeat || open.parents.length === 0) &&
				(caseType === undefined || caseType === open.caseType),
		);
		if (candidates.length === 1) {
			const loads = (objectMembers(actions.load_update_cases) ?? []).map(
				(load) => ({
					tag: textOf(load.case_tag),
					parents:
						isJsonObject(load.case_index) && !blank(load.case_index.tag)
							? [textOf(load.case_index.tag)]
							: [],
					auto: isJsonObject(load.auto_select),
				}),
			);
			if (!advancedRegistrationTarget(candidates[0], opens, loads)) return [];
		}
		return candidates.map((open) => ({ kind: "advanced", tag: open.tag }));
	}
	const found: RegistrationSource[] = [];
	const own =
		isJsonObject(actions.open_case) && isJsonObject(actions.open_case.condition)
			? actions.open_case.condition.type
			: undefined;
	if (
		(own === "always" || own === "if") &&
		(caseType === undefined || formMenuType === caseType)
	)
		found.push({ kind: "own" });
	(objectMembers(actions.subcases) ?? []).forEach((subcase, index) => {
		if (
			(caseType === undefined || subcase.case_type === caseType) &&
			blank(subcase.repeat_context)
		)
			found.push({ kind: "child", index });
	});
	return found;
}

/** Whether the host's forms read the search: its search runs inline and launches itself. */
function formsReadSearch(host: JsonObject): boolean {
	const config = isJsonObject(host.search_config)
		? host.search_config
		: NO_ENTRIES;
	return config.inline_search === true && config.auto_launch === true;
}

/** The case type the host's parent selection names, where it names one. */
function hostParentType(
	ctx: ReadContext,
	host: JsonObject,
): string | undefined {
	const select = isJsonObject(host.parent_select)
		? host.parent_select
		: NO_ENTRIES;
	if (
		select.active !== true ||
		(select.relationship !== "parent" && select.relationship != null)
	)
		return undefined;
	const type = textOf(rawModuleById(ctx, select.module_id)?.case_type);
	return type === "" ||
		(select.relationship === "parent" && type === host.case_type)
		? undefined
		: type;
}

/** Whether the media maps of a block hold any path. */
function holdsMedia(block: JsonObject): boolean {
	const any = (value: unknown) =>
		isJsonObject(value) && Object.values(value).some((path) => !blank(path));
	return any(block.media_image) || any(block.media_audio);
}

/** Whether a value is blank as HQ stores an unset one: absent, null, empty text, or an empty
 *  map or list. */
function unset(value: unknown): boolean {
	return (
		blank(value) ||
		(Array.isArray(value) && value.length === 0) ||
		(isJsonObject(value) && Object.keys(value).length === 0)
	);
}

/**
 * Whether a stored value is the one Nova's shell writes, as HQ serves it:
 * texts the same (XPath as trees), lists element by element, and an object key
 * by key, where a key one side lacks holds HQ's default for the object's class
 * as a read serves it (`surface/schemaDefaults.ts::servedSchemaPropertyDefault`:
 * HQ serves every property its class declares),
 * or, in a map with no class, nothing.
 */
function sameAsShell(stored: unknown, ours: unknown): boolean {
	if (typeof stored === "string" && typeof ours === "string")
		return (
			stored === ours ||
			(stored.trim() !== "" &&
				ours.trim() !== "" &&
				sameXPathText(stored, ours))
		);
	if (Array.isArray(stored) || Array.isArray(ours))
		return (
			(Array.isArray(stored) &&
				Array.isArray(ours) &&
				stored.length === ours.length &&
				stored.every((one, index) => sameAsShell(one, ours[index]))) ||
			(unset(stored) && unset(ours))
		);
	if (isJsonObject(stored) && isJsonObject(ours))
		return differingKey(stored, ours, []) === undefined;
	return stored === ours || (unset(stored) && unset(ours));
}

/** The first key at which a stored object is not Nova's shell, `skip` left out. */
function differingKey(
	stored: JsonObject,
	ours: JsonObject,
	skip: readonly string[],
): string | undefined {
	const cls = typeof stored.doc_type === "string" ? stored.doc_type : undefined;
	for (const key of new Set([...Object.keys(stored), ...Object.keys(ours)])) {
		if (skip.includes(key)) continue;
		const inStored = Object.hasOwn(stored, key);
		const inOurs = Object.hasOwn(ours, key);
		if (inStored && inOurs) {
			if (!sameAsShell(stored[key], ours[key])) return key;
			continue;
		}
		// HQ names an object's class where Nova's shell may not.
		if (key === "doc_type") continue;
		const value = inStored ? stored[key] : ours[key];
		const fallback =
			cls === undefined ? undefined : servedSchemaPropertyDefault(cls, key);
		const atDefault =
			fallback?.known === true
				? sameAsShell(value, fallback.default)
				: unset(value);
		if (!atDefault) return key;
	}
	return undefined;
}

/**
 * The menu Nova's emission writes for a registration offered after an empty
 * search (`expander.ts`, the synthetic menu `emissionPlan.ts` adds): the basic
 * shell for the host's case type with the one `name` column every new menu
 * holds, its empty-list text in every language, no deep link, and hidden by
 * `false()`.
 */
function hiddenMenuAsWritten(ctx: ReadContext, caseType: string): JsonObject {
	const langs = appLanguageCodes(ctx);
	const details = detailPair(emptyShortListColumns(langs));
	details.short.no_items_text = repeatForLanguages(langs, EMPTY_CASE_LIST_TEXT);
	const shell = moduleShell(
		"",
		{},
		caseType,
		[],
		details,
		langs,
		declaresWebApps({
			appSettings: ctx.draft.appSettings as BlueprintDoc["appSettings"],
		}),
	);
	shell.session_endpoint_id = "";
	shell.case_list_session_endpoint_id = "";
	shell.module_filter = hqXPath(NEVER_RELEVANT, "no-case");
	return serializeHqModule(shell) as unknown as JsonObject;
}

/** The keys of a hidden menu that are its own and no setting: compared on their own, or not. */
const HIDDEN_MENU_OWN_KEYS = ["unique_id", "name", "forms"] as const;

/**
 * The hidden-menu shape: the named form's menu holds exactly that one form,
 * filters itself out of every menu with `false()`, is named as its form, and
 * holds no other key at a value other than Nova's shell for the host's case
 * type (no parent, no case list item, no search, no media, the default
 * details); the host's forms read the search; the block's relevancy is "the
 * search found nothing", it returns to the case list or goes on with the new
 * case, and it holds no media.
 */
function hiddenMenuShape(
	ctx: ReadContext,
	host: JsonObject,
	block: JsonObject,
	menu: JsonObject,
): boolean {
	if (menu === host || rawForms(menu).length !== 1) return false;
	const filter = menu.module_filter;
	if (typeof filter !== "string" || !sameXPathText(filter, "false()"))
		return false;
	const langs = appLanguageCodes(ctx);
	if (
		menu.doc_type !== "Module" ||
		textOf(menu.case_type) !== textOf(host.case_type) ||
		!sameJson(
			effectiveNames(menu.name, langs),
			effectiveNames(rawForms(menu)[0]?.name, langs),
		) ||
		differingKey(
			menu,
			hiddenMenuAsWritten(ctx, textOf(host.case_type)),
			HIDDEN_MENU_OWN_KEYS,
		) !== undefined
	)
		return false;
	const relevancy = block.relevancy_expression;
	return (
		formsReadSearch(host) &&
		typeof relevancy === "string" &&
		sameXPathText(relevancy, NO_MATCHES_TEXT) &&
		(block.post_form_workflow === "case_list" ||
			block.post_form_workflow === "default") &&
		!holdsMedia(block)
	);
}

/**
 * Whether an advanced host breaks the rules HQ's build holds a menu whose case
 * list offers a registration to (`helpers/validators.py::AdvancedModuleValidator.validate_with_raise`):
 * every form loads the same case types from a list, loads at least one, loads
 * only parents of the next, ends on a load of the menu's case type under one
 * tag, and lists that load from the menu's own details.
 */
function caseListModuleRulesBreak(host: JsonObject): boolean {
	let types: string | undefined;
	let tag: unknown;
	for (const form of rawForms(host)) {
		const actions = isJsonObject(form.actions) ? form.actions : NO_ENTRIES;
		const loads = (objectMembers(actions.load_update_cases) ?? []).filter(
			(load) => !isJsonObject(load.auto_select),
		);
		const loaded = JSON.stringify(
			[...new Set(loads.map((load) => textOf(load.case_type)))].sort(),
		);
		if (types === undefined) types = loaded;
		else if (types !== loaded) return true;
		const last = loads[loads.length - 1];
		if (last === undefined) return true;
		for (let index = 1; index < loads.length; index++) {
			const previous = (loads[index - 1] as JsonObject).case_tag;
			const indices = (loads[index] as JsonObject).case_indices;
			const tags = (objectMembers(indices) ?? []).map((one) => one.tag);
			if (!blank(previous) && !tags.includes(previous)) return true;
		}
		if (textOf(last.case_type) !== textOf(host.case_type)) return true;
		if (tag === undefined) tag = last.case_tag;
		else if (last.case_tag !== tag) return true;
		if (last.details_module !== host.unique_id) return true;
	}
	return false;
}

/** One host's block, as pass 1 left it for the acceptance. */
interface ReadBlock {
	readonly host: DraftModule;
	readonly kind: "after-empty-search" | "always";
	readonly form: DraftForm;
	/** The hidden menu folded, for the `after-empty-search` arm. */
	readonly hidden?: DraftModule;
	/** Whether a media map's asset was read, so the stored maps are compared. */
	readonly media: boolean;
	readonly source?: ListTargetSource;
}

const READINGS = new WeakMap<ReadContext, ReadBlock[]>();
const CONDITIONS = new WeakMap<ReadContext, Map<Uuid, number>>();

/** The label of a block, read as HQ's build writes it, with its record where the source
 *  spelling differs from Nova's. Absent where it is the form's name in every language. */
function readLabel(
	ctx: ReadContext,
	cursor: ReturnType<DraftModule["json"]["object"]>,
	host: DraftModule,
	formNames: unknown,
): string | undefined {
	const langs = appLanguageCodes(ctx);
	const stored = labelMap(cursor.peek("label"));
	const anyText =
		langs.some((lang) => textOf(stored[lang]) !== "") ||
		Object.values(stored).some((text) => textOf(text) !== "");
	const claim = anyText ? REGISTRATION.label : REGISTRATION.labelEmpty;
	cursor.take("label", claim, (value) => value).value;
	const asBuilt = labelAsBuilt(stored, langs, CREATE_A_NEW_CASE);
	const held = heldLabel(ctx, asBuilt, "case-list-registration-label");
	// A label Nova's gate admits no spelling of (`heldText.ts::unheldText`) is one finding at the
	// case list, whose settle then compares nothing there, and is kept as built here.
	if (held === undefined)
		refuseUnheldText(
			ctx,
			caseListPlaceOf(host),
			"schema:CaseListForm.label",
			unheldLabel(ctx, asBuilt, "case-list-registration-label"),
		);
	const built = held?.texts ?? asBuilt;
	const fixed = !anyText || langs.some((lang) => stored[lang] === "");
	if (fixed) {
		ctx.facts.sameStateRewrites.push({
			entry: claim.entry,
			path: `${cursor.pointer}/label`,
			register: "registration-label-fixed",
		});
		// The fix records the rewrite under its own register, which `recordTextRewrite` below may
		// not reach, so a held label whose rest after a carriage return defines another app string
		// is refused here too. A label Nova holds no spelling of has its one finding above,
		// whether or not a language holds the blank HQ's build fills.
		if (held !== undefined) refuseLineEndKey(ctx, `${cursor.pointer}/label`);
	}
	// Any other map Nova prints another way (a language with no key, a `null`, a language the app
	// no longer lists, a text held without the spaces at its ends) is written again by the first
	// publish: under `text-spaces-dropped` where a worker then reads another text, else under
	// `list-settings-respelled`, where the words HQ's build wrote stand.
	if (
		held !== undefined &&
		(held.workersSeeAnother ||
			(!fixed && !labelSpelledAsBuilt(stored, built, langs)))
	)
		recordTextRewrite(
			ctx,
			{ entry: claim.entry, path: `${cursor.pointer}/label` },
			"list-settings-respelled",
			held.workersSeeAnother,
		);
	const names = effectiveNames(formNames, langs);
	if (langs.every((lang) => built[lang] === names[lang])) return undefined;
	return writeBuiltLabel(
		ctx,
		makeTranslationUnitId("module", host.uuid, "case-list-registration-label"),
		built,
	);
}

/** Folds the hidden menu into its host: its form is the host's last. */
function fold(
	ctx: ReadContext,
	host: DraftModule,
	menu: DraftModule,
	form: DraftForm,
): void {
	ctx.writeDraft(() => {
		const at = menu.forms.indexOf(form);
		if (at !== -1) menu.forms.splice(at, 1);
		host.forms.push(form);
		ctx.draft.foldedMenus.push({
			menu,
			hostUuid: host.uuid,
			formUuid: form.uuid,
		});
	});
}

/**
 * First of the menu readings (`readMenus`): every host's `case_list_form` by the
 * first row that holds. A hidden menu read as a registration after an empty
 * search is folded here, before any other menu reading, so no reader takes
 * it for a menu of the document.
 */
export function readCaseListRegistration(
	ctx: ReadContext,
	app: DraftApp,
): void {
	const stored = rawModules(ctx);
	const blocks: ReadBlock[] = [];
	READINGS.set(ctx, blocks);
	CONDITIONS.set(ctx, new Map());
	const hiddenNamed = new Map<DraftForm, DraftModule>();
	const candidates: {
		host: DraftModule;
		block: JsonObject;
		named: ReturnType<typeof draftFormByReadId>;
	}[] = [];
	for (const host of app.modules) {
		const json = stored[host.index] ?? NO_ENTRIES;
		const block = isJsonObject(json.case_list_form)
			? json.case_list_form
			: NO_ENTRIES;
		if (!host.json.used("case_list_form")) continue;
		if (blank(block.form_id)) {
			host.json.drop("case_list_form", REGISTRATION.blank[host.docType]);
			continue;
		}
		const named = draftFormByReadId(ctx, block.form_id);
		candidates.push({ host, block, named });
		if (named !== undefined) {
			const menu = stored[named.module.index] ?? NO_ENTRIES;
			if (
				ctx.input.caseListActionsApplied === true &&
				hiddenMenuShape(ctx, json, block, menu) &&
				!hiddenNamed.has(named.form)
			)
				hiddenNamed.set(named.form, host);
		}
	}
	for (const { host, block, named } of candidates) {
		const cls = host.docType;
		const json = stored[host.index] ?? NO_ENTRIES;
		const caseType = textOf(json.case_type);
		const listPlace = caseListPlaceOf(host);
		const refuseBlock = (claim: Readonly<Record<MenuClass, Claim<"refuse">>>) =>
			host.json.refuse("case_list_form", claim[cls], undefined, listPlace);
		if (named === undefined) {
			refuseBlock(REGISTRATION.missing);
			continue;
		}
		const formMenu = stored[named.module.index] ?? NO_ENTRIES;
		const form = rawForms(formMenu)[named.form.index] ?? NO_ENTRIES;
		const formMenuType = textOf(formMenu.case_type);
		const registrations = registrationsOf(form, formMenuType, caseType);
		let source: ListTargetSource | undefined =
			registrations.length === 1 ? registrations[0] : undefined;
		if (
			source === undefined &&
			ctx.input.caseListActionsApplied === true &&
			formChoosesCase(form) &&
			hostParentType(ctx, json) === formMenuType &&
			registrationsOf(form, formMenuType).length !== 1 &&
			isJsonObject(json.parent_select)
		) {
			const parentId = json.parent_select.module_id;
			const parent = app.modules.find((item) => item.uniqueId === parentId);
			if (parent !== undefined)
				source = { kind: "parent", moduleUuid: parent.uuid };
		}
		if (!source) {
			refuseBlock(REGISTRATION.missing);
			continue;
		}
		if (json.put_in_root === true) {
			const details = isJsonObject(json.case_details)
				? json.case_details
				: NO_ENTRIES;
			const short = isJsonObject(details.short) ? details.short : NO_ENTRIES;
			if (!blank(short.case_tile_template)) refuseBlock(REGISTRATION.tileAbove);
			else if (!blank(json.root_module_id))
				refuseBlock(REGISTRATION.childAbove);
			else host.json.drop("case_list_form", REGISTRATION.topLevelAbove[cls]);
			continue;
		}
		if (!rawForms(json).every((one) => formChoosesCase(one))) {
			refuseBlock(REGISTRATION.notCaseFirst);
			continue;
		}
		if (cls === "AdvancedModule" && caseListModuleRulesBreak(json)) {
			host.json.refuse(
				"case_list_form",
				REGISTRATION.advancedRulesBroken,
				undefined,
				listPlace,
			);
			continue;
		}
		const hiddenHost = hiddenNamed.get(named.form);

		// An authored form destination takes precedence over the list's return.
		// A dormant list choice supplies no scalar case to a collection.
		const hasOwnFrame =
			source.kind === "parent" ||
			["root", "module", "parent_module", "previous_screen"].includes(
				textOf(form.post_form_workflow),
			) ||
			(form.post_form_workflow === "form" &&
				(objectMembers(form.form_links) ?? []).length > 0);
		if (
			block.post_form_workflow !== "case_list" &&
			selectsSeveral(json) &&
			!hasOwnFrame
		) {
			refuseBlock(REGISTRATION.multiSelectDefault);
			continue;
		}
		if (hiddenHost === host) {
			readHidden(ctx, host, named.module, named.form, form, block);
			blocks.push({
				host,
				kind: "after-empty-search",
				form: named.form,
				hidden: named.module,
				media: false,
			});
			continue;
		}
		const claim =
			source.kind === "parent"
				? REGISTRATION.parentFollowUp
				: source.kind === "child"
					? REGISTRATION.childCase
					: cls === "AdvancedModule" || source.kind === "advanced"
						? REGISTRATION.advanced
						: hiddenHost !== undefined
							? REGISTRATION.anotherList
							: REGISTRATION.always;
		const media = readAlways(ctx, host, named.form, form, block, claim[cls]);
		blocks.push({ host, kind: "always", form: named.form, media, source });
	}
}

/** The `after-empty-search` arm: the block read, the hidden menu folded. */
function readHidden(
	ctx: ReadContext,
	host: DraftModule,
	menu: DraftModule,
	form: DraftForm,
	stored: JsonObject,
	block: JsonObject,
): void {
	const newCase = block.post_form_workflow === "default";
	const cursor = host.json.object(
		"case_list_form",
		"CaseListForm",
		(newCase ? REGISTRATION.hiddenDefault : REGISTRATION.hidden)[host.docType],
		caseListPlaceOf(host),
	);
	cursor.take("form_id", REGISTRATION.hiddenFormId, (value) => value).value;
	cursor.take("post_form_workflow", REGISTRATION.workflow, (value) => value)
		.value;
	cursor.take(
		"relevancy_expression",
		REGISTRATION.hiddenRelevancy,
		(value) => value,
	).value;
	const label = readLabel(ctx, cursor, host, stored.name);
	fold(ctx, host, menu, form);
	ctx.writeDraft(() => {
		Object.assign(host.module, {
			caseListRegistrationForm: {
				kind: "after-empty-search",
				formUuid: form.uuid,
				...(newCase && { afterSubmit: "new-case" }),
				...(label === undefined ? {} : { label }),
			},
		});
	});
}

/** The `always` arm. Answers whether a media map's asset was read. */
function readAlways(
	ctx: ReadContext,
	host: DraftModule,
	form: DraftForm,
	stored: JsonObject,
	block: JsonObject,
	claim: Claim<"take">,
): boolean {
	const cursor = host.json.object(
		"case_list_form",
		"CaseListForm",
		claim,
		caseListPlaceOf(host),
	);
	cursor.take("form_id", REGISTRATION.alwaysFormId, (value) => value).value;
	const afterSubmit =
		block.post_form_workflow === "case_list" ? "case-list" : "new-case";
	cursor.take("post_form_workflow", REGISTRATION.workflow, (value) => value)
		.value;
	const text = block.relevancy_expression;
	let showWhen: import("@/lib/domain").AlwaysOfferedRegistration["showWhen"];
	if (
		ctx.input.caseListActionsApplied === true &&
		typeof text === "string" &&
		text.trim() !== ""
	) {
		if (
			formsReadSearch(rawModules(ctx)[host.index] ?? NO_ENTRIES) &&
			sameXPathText(text, NO_MATCHES_TEXT)
		) {
			cursor.take(
				"relevancy_expression",
				REGISTRATION.relevancyHeld,
				(value) => value,
			);
			showWhen = { kind: "empty-search" };
		} else {
			const index = ctx.pending.register(
				{
					ref: {
						entity: "module",
						uuid: host.uuid,
						slot: "case_list_action_condition",
					},
					text,
					mode: { target: "hq-json", interpolation: "none" },
					place: caseListPlaceOf(host),
					key: "schema:CaseListForm.relevancy_expression",
				},
				{ json: cursor, key: "relevancy_expression" },
			);
			CONDITIONS.get(ctx)?.set(host.uuid, index);
			showWhen = {
				kind: "condition",
				condition: pendingPlaceholder("condition"),
			};
		}
	} else if (!blank(text) && ctx.input.caseListActionsApplied !== false) {
		ctx.accounting.circumstance("unrecognized", caseListPlaceOf(host), {
			name: "schema:CaseListForm.relevancy_expression",
		});
	} else cursor.drop("relevancy_expression", REGISTRATION.relevancyInert);
	if (Array.isArray(block.custom_icons) && block.custom_icons.length > 0)
		cursor.drop("custom_icons", REGISTRATION.customIcons);
	const label = readLabel(ctx, cursor, host, stored.name);
	const media = readNavMedia(
		ctx,
		cursor,
		{
			image: "case_list_registration_icon",
			audio: "case_list_registration_audio_label",
		},
		cursor.place,
	);
	ctx.writeDraft(() => {
		Object.assign(host.module, {
			caseListRegistrationForm: {
				kind: "always",
				formUuid: form.uuid,
				...(showWhen === undefined ? {} : { showWhen }),
				...(label === undefined ? {} : { label }),
				...(media.icon === undefined ? {} : { icon: media.icon }),
				...(media.audioLabel === undefined
					? {}
					: { audioLabel: media.audioLabel }),
				afterSubmit,
			},
		});
	});
	return media.icon !== undefined || media.audioLabel !== undefined;
}

/** Each source operation now has its stable UUID and its original HQ placement.
 * Bind by that exact position or case tag, never by a display name or case type. */
export function bindCaseListActionTargets(ctx: ReadContext): void {
	for (const read of READINGS.get(ctx) ?? []) {
		const source = read.source;
		const slot = read.host.module.caseListRegistrationForm;
		if (!source || source.kind === "own" || slot?.kind !== "always") continue;
		if (source.kind === "parent") {
			ctx.writeDraft(() => {
				slot.target = { kind: "chosen-parent", moduleUuid: source.moduleUuid };
			});
			continue;
		}
		const operation = read.form.form.caseOperations?.find(({ placement }) =>
			source.kind === "advanced"
				? placement?.kind === "advanced" && placement.tag === source.tag
				: placement?.kind === "basic" &&
					placement.slot === "subcase" &&
					placement.index === source.index,
		);
		if (operation?.action === "own") continue;
		if (operation?.action === "create") {
			ctx.writeDraft(() => {
				slot.target = { kind: "created-case", operationUuid: operation.uuid };
			});
		} else {
			ctx.accounting.circumstance("unrecognized", caseListPlaceOf(read.host), {
				name: "schema:CaseListForm.form_id",
			});
		}
	}
}

export function settleCaseListActionConditions(ctx: ReadContext): void {
	const conditions = CONDITIONS.get(ctx);
	if (ctx.doc === undefined || !conditions?.size) return;
	ctx.doc = withCandidate(ctx.doc, (draft) => {
		for (const [host, index] of conditions) {
			const condition = ctx.pending.outcome(index).expression;
			const slot = draft.modules[host]?.caseListRegistrationForm;
			if (slot?.kind === "always" && condition !== undefined)
				slot.showWhen = { kind: "condition", condition };
		}
	});
	/* HQ's build declares no instance for what only the condition reads, so
	 * a condition reading one fails the list on the device: no document of
	 * Nova's holds it (`caseListActionVisibility`), and the reading stops. */
	const doc = ctx.doc;
	for (const host of conditions.keys()) {
		const slot = doc.modules[host]?.caseListRegistrationForm;
		if (slot?.kind !== "always") continue;
		if (
			caseListActionUndeclaredInstances(doc, host, slot.showWhen).length === 0
		)
			continue;
		const block = READINGS.get(ctx)?.find((read) => read.host.uuid === host);
		if (block === undefined) continue;
		ctx.accounting.circumstance("unrecognized", caseListPlaceOf(block.host), {
			name: "schema:CaseListForm.relevancy_expression",
		});
	}
}

// ── Acceptance ──────────────────────────────────────────────────────────

type HqModuleJson = HqApplication["modules"][number];

/** The gate's two registration rules over the document, each finding at a host this reading
 *  read a block for: the shared first-menu case is its entry's, any other `unrecognized`. */
function gateFindings(
	ctx: ReadContext,
	doc: BlueprintDoc,
	blocks: readonly ReadBlock[],
): Set<Uuid> {
	const errors: ValidationError[] = [
		...caseListRegistrationFormInModule(doc),
		...caseListRegistrationApp(doc),
		...doc.moduleOrder.flatMap((uuid) => {
			const mod = doc.modules[uuid];
			return mod === undefined ? [] : caseListRegistrationForm(mod, uuid, doc);
		}),
	];
	const refused = new Set<Uuid>();
	for (const block of blocks) {
		const found = errors.filter(
			(error) => error.location?.moduleUuid === block.host.uuid,
		);
		if (found.length === 0) continue;
		refused.add(block.host.uuid);
		const shared = found.find(
			(error) =>
				(error.details as { reason?: unknown } | undefined)?.reason ===
				"parent-shares-first-menu-case",
		);
		if (shared !== undefined)
			ctx.accounting.finding(
				REGISTRATION.sharesFirstMenuCase,
				caseListPlaceOf(block.host),
			);
		else
			ctx.accounting.circumstance("unrecognized", caseListPlaceOf(block.host), {
				name: `schema:${block.host.docType}.case_list_form`,
			});
	}
	return refused;
}

/** Whether two stored values are one: XPath text as trees, every other value as JSON. */
function sameValue(a: unknown, b: unknown): boolean {
	if (typeof a === "string" && typeof b === "string")
		return a === b || sameXPathText(a, b);
	return sameJson(a, b) || (blank(a) && blank(b));
}

/**
 * In the menus' settle, over the one expansion: the gate's registration rules hold over the
 * document, and the expansion's `case_list_form` for each host is the stored
 * block (its `form_id` literally, its label as built), and each folded hidden
 * menu is the menu Nova's emission writes for its form.
 */
export function settleRegistrations(
	ctx: ReadContext,
	moduleOf: (uniqueId: string) => HqModuleJson | undefined,
): void {
	const doc = ctx.doc;
	const blocks = READINGS.get(ctx) ?? [];
	if (doc === undefined || blocks.length === 0) return;
	const refused = gateFindings(ctx, doc, blocks);
	const langs = appLanguageCodes(ctx);
	const stored = rawModules(ctx);
	for (const block of blocks) {
		const listPlace = caseListPlaceOf(block.host);
		if (
			refused.has(block.host.uuid) ||
			ctx.accounting.hasFindingAt(block.host.place) ||
			ctx.accounting.hasFindingAt(listPlace)
		)
			continue;
		const host = stored[block.host.index] ?? NO_ENTRIES;
		const ours = moduleOf(block.host.uniqueId) as JsonObject | undefined;
		const source = isJsonObject(host.case_list_form)
			? host.case_list_form
			: NO_ENTRIES;
		const emitted = isJsonObject(ours?.case_list_form)
			? ours.case_list_form
			: NO_ENTRIES;
		const unrecognized = (name: string) =>
			ctx.accounting.circumstance("unrecognized", listPlace, { name });
		if (source.form_id !== emitted.form_id) {
			unrecognized("schema:CaseListForm.form_id");
			continue;
		}
		// Each label as the reading holds it (`modules.ts::heldLabel`).
		const builtSource = heldLabel(
			ctx,
			labelAsBuilt(labelMap(source.label), langs, CREATE_A_NEW_CASE),
			"case-list-registration-label",
		);
		const builtOurs = heldLabel(
			ctx,
			labelAsBuilt(
				withReadTranslations(
					ctx,
					caseListFormLabelUnit(doc, block.host.uuid, block.form.uuid),
					labelMap(emitted.label),
				),
				langs,
				CREATE_A_NEW_CASE,
			),
			"case-list-registration-label",
		);
		if (
			builtSource === undefined ||
			builtOurs === undefined ||
			!sameJson(builtSource.texts, builtOurs.texts)
		) {
			unrecognized("schema:CaseListForm.label");
			continue;
		}
		if (source.post_form_workflow !== emitted.post_form_workflow) {
			unrecognized("schema:CaseListForm.post_form_workflow");
			continue;
		}
		if (ctx.input.caseListActionsApplied === true) {
			if (
				!sameValue(source.relevancy_expression, emitted.relevancy_expression)
			) {
				unrecognized("schema:CaseListForm.relevancy_expression");
				continue;
			}
		}
		if (block.media) {
			const differs = (["media_image", "media_audio"] as const).find(
				(key) =>
					!sameJson(
						keptMediaPaths(
							ctx,
							shownBlockMedia((one) => source[one], key, langs),
						),
						shownBlockMedia((one) => emitted[one], key, langs),
					),
			);
			if (differs !== undefined) {
				unrecognized(`schema:CaseListForm.${differs}`);
				continue;
			}
		}
		if (caseListReturnFirstMenuCase(doc, block.host.uuid)?.conflict === false) {
			const claim = REGISTRATION.sharedFirstMenuCase;
			ctx.accounting.claimEntryClass(
				{ json: block.host.json, key: "case_list_form" },
				claim.entry,
				`schema:${block.host.docType}.case_list_form`,
				listPlace,
			);
		}
		if (block.hidden !== undefined) {
			const menu = stored[block.hidden.index] ?? NO_ENTRIES;
			const synthetic = moduleOf(block.hidden.uniqueId) as
				| JsonObject
				| undefined;
			if (synthetic === undefined) {
				ctx.accounting.circumstance("unrecognized", block.hidden.place, {
					name: "schema:Module",
				});
				continue;
			}
			const names = (value: unknown) => effectiveNames(value, langs);
			const key = !sameJson(names(menu.name), names(synthetic.name))
				? "name"
				: differingKey(menu, synthetic, HIDDEN_MENU_OWN_KEYS);
			if (key !== undefined)
				ctx.accounting.circumstance("unrecognized", block.hidden.place, {
					name: `schema:Module.${key}`,
				});
		}
	}
}

/**
 * The reader's canonical choice `registration-form-last`: a registration a
 * list offers after an empty search stands last among its menu's forms. Two
 * documents that differ only in where it stands print one source, since the
 * form is on no menu either way; the reader returns this one.
 */
export function registrationFormLast(doc: BlueprintDoc): BlueprintDoc {
	let changed = false;
	const formOrder = recordFromEntries(Object.entries(doc.formOrder));
	for (const moduleUuid of doc.moduleOrder) {
		const slot = doc.modules[moduleUuid]?.caseListRegistrationForm;
		if (slot?.kind !== "after-empty-search") continue;
		const forms = doc.formOrder[moduleUuid] ?? [];
		const at = forms.indexOf(slot.formUuid);
		if (at === -1 || at === forms.length - 1) continue;
		formOrder[moduleUuid] = [
			...forms.filter((uuid) => uuid !== slot.formUuid),
			slot.formUuid,
		];
		changed = true;
	}
	return changed ? { ...doc, formOrder } : doc;
}
