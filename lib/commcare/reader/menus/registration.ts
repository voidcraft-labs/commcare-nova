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
import { caseListFormLabelUnit } from "../../emissionPlan";
import { emptyShortListColumns } from "../../hqJson/caseList";
import { hqXPath, serializeHqModule } from "../../hqJson/xpath";
import { detailPair, moduleShell } from "../../hqShells";
import { repeatForLanguages } from "../../localization";
import { EMPTY_CASE_LIST_TEXT } from "../../suite/case-list/detailTexts";
import {
	NEVER_RELEVANT,
	NO_MATCHES_RELEVANCY,
} from "../../suite/case-search/noMatches";
import { schemaPropertyDefault } from "../../surface/schemaDefaults";
import type { ValidationError } from "../../validator/errors";
import {
	caseListRegistrationApp,
	caseListRegistrationForm,
	caseListRegistrationFormInModule,
} from "../../validator/rules/case-search/caseListRegistration";
import { serializeWire } from "../../xpath/wire/serialize";
import { type Claim, defineClaims, drop, refuse, take } from "../claims";
import type { DraftApp, DraftForm, DraftModule, ReadContext } from "../context";
import { isJsonObject, sameJson } from "../jsonCursor";
import { sameXPathText } from "../syntaxCompare";
import {
	appLanguageCodes,
	caseListPlaceOf,
	draftFormByReadId,
	effectiveNames,
	formChoosesCase,
	labelAsBuilt,
	labelMap,
	rawForms,
	rawModuleById,
	rawModules,
	selectsSeveral,
	withReadTranslations,
	writeBuiltLabel,
} from "./modules";
import { readNavMedia } from "./navMedia";

const M = "menus-and-case-lists";

type MenuClass = "Module" | "AdvancedModule";

/** The registration rows that read the whole block, each per host class. */
function blockClaims<U extends "take" | "refuse" | "drop">(
	make: (entry: string, key: string) => Claim<U>,
	entry: string,
): Readonly<Record<MenuClass, Claim<U>>> {
	return {
		Module: make(`${M}/${entry}`, "schema:Module.case_list_form"),
		AdvancedModule: make(
			`${M}/${entry}`,
			"schema:AdvancedModule.case_list_form",
		),
	};
}

const REGISTRATION = {
	blank: drop(
		`${M}/case-list-form-fields-beside-a-blank-form-id`,
		"schema:CaseListForm.label",
	),
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
		refuse,
		"case-list-form-on-an-advanced-module-or-naming-an-advanced-form",
	),
	advancedRulesBroken: refuse(
		"forms-and-case-writes/advanced-forms-in-a-module-whose-case-list-offers-a-registration",
		"schema:AdvancedModule.case_list_form",
	),
	childCase: blockClaims(
		refuse,
		"case-list-form-pointing-at-a-form-whose-one-registration-of-the-type-is-a-child-case",
	),
	anotherList: blockClaims(
		refuse,
		"case-list-form-naming-a-form-another-list-offers-after-an-empty-search",
	),
	sharesFirstMenuCase: refuse(
		`${M}/case-list-form-on-a-host-under-a-menu-that-shares-the-first-menu-s-case`,
		"schema:Module.case_list_form",
	),
	parentFollowUp: blockClaims(
		refuse,
		"case-list-form-pointing-at-a-follow-up-form-of-the-parent-case",
	),
	hiddenDefault: blockClaims(
		refuse,
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
	relevancyHeld: refuse(
		`${M}/case-list-form-relevancy-expression-with-followup-forms-as-case`,
		"schema:CaseListForm.relevancy_expression",
	),
	customIcons: refuse(
		`${M}/custom-icons-0-badge-localized-text-or-xpath`,
		"schema:CustomIcon",
	),
} as const;

defineClaims(
	"menus.registration",
	Object.fromEntries(
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

/** How a form registers `caseType`: each root registration it makes of the type. */
function registrationsOf(
	form: JsonObject,
	formMenuType: string,
	caseType: string,
): readonly ("own" | "child")[] {
	const actions = isJsonObject(form.actions) ? form.actions : {};
	const active = (action: unknown) => {
		const condition =
			isJsonObject(action) && isJsonObject(action.condition)
				? action.condition
				: {};
		return condition.type === "always" || condition.type === "if";
	};
	const atRoot = (one: JsonObject) => blank(one.repeat_context);
	if (form.doc_type === "AdvancedForm") {
		const opens = Array.isArray(actions.open_cases)
			? actions.open_cases.filter(isJsonObject)
			: [];
		return opens
			.filter((open) => open.case_type === caseType && atRoot(open))
			.map(() => "own" as const);
	}
	const found: ("own" | "child")[] = [];
	if (active(actions.open_case) && formMenuType === caseType) found.push("own");
	const subcases = Array.isArray(actions.subcases)
		? actions.subcases.filter(isJsonObject)
		: [];
	for (const subcase of subcases)
		if (subcase.case_type === caseType && atRoot(subcase) && active(subcase))
			found.push("child");
	return found;
}

/** Whether the host's forms read the search: its search runs inline and launches itself. */
function formsReadSearch(host: JsonObject): boolean {
	const config = isJsonObject(host.search_config) ? host.search_config : {};
	return config.inline_search === true && config.auto_launch === true;
}

/** The case type the host's parent selection names, where it names one. */
function hostParentType(
	ctx: ReadContext,
	host: JsonObject,
): string | undefined {
	const select = isJsonObject(host.parent_select) ? host.parent_select : {};
	if (select.active !== true) return undefined;
	const type = textOf(rawModuleById(ctx, select.module_id)?.case_type);
	return type === "" ? undefined : type;
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
 * (`surface/schemaDefaults.ts`: HQ serves every property its class declares),
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
			cls === undefined ? undefined : schemaPropertyDefault(cls, key);
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
		const actions = isJsonObject(form.actions) ? form.actions : {};
		const loads = (
			Array.isArray(actions.load_update_cases)
				? actions.load_update_cases.filter(isJsonObject)
				: []
		).filter((load) => !isJsonObject(load.auto_select));
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
			const tags = Array.isArray(indices)
				? indices.filter(isJsonObject).map((one) => one.tag)
				: [];
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
}

const READINGS = new WeakMap<ReadContext, ReadBlock[]>();

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
	const built = labelAsBuilt(stored, langs, CREATE_A_NEW_CASE);
	const fixed = !anyText || langs.some((lang) => stored[lang] === "");
	if (fixed)
		ctx.facts.sameStateRewrites.push({
			entry: claim.entry,
			path: `${cursor.pointer}/label`,
			register: "registration-label-fixed",
		});
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
 * Step 2, first of the menu readings: every host's `case_list_form` by the
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
	const hiddenNamed = new Map<DraftForm, DraftModule>();
	const candidates: {
		host: DraftModule;
		block: JsonObject;
		named: ReturnType<typeof draftFormByReadId>;
	}[] = [];
	for (const host of app.modules) {
		const json = stored[host.index] ?? {};
		const block = isJsonObject(json.case_list_form) ? json.case_list_form : {};
		if (!host.json.used("case_list_form")) continue;
		if (blank(block.form_id)) {
			host.json.drop("case_list_form", REGISTRATION.blank);
			continue;
		}
		const named = draftFormByReadId(ctx, block.form_id);
		candidates.push({ host, block, named });
		if (named !== undefined) {
			const menu = stored[named.module.index] ?? {};
			if (hiddenMenuShape(ctx, json, block, menu))
				hiddenNamed.set(named.form, host);
		}
	}
	for (const { host, block, named } of candidates) {
		const cls = host.docType;
		const json = stored[host.index] ?? {};
		const caseType = textOf(json.case_type);
		const listPlace = caseListPlaceOf(host);
		const refuseBlock = (claim: Readonly<Record<MenuClass, Claim<"refuse">>>) =>
			host.json.refuse("case_list_form", claim[cls], undefined, listPlace);
		if (named === undefined) {
			refuseBlock(REGISTRATION.missing);
			continue;
		}
		const formMenu = stored[named.module.index] ?? {};
		const form = rawForms(formMenu)[named.form.index] ?? {};
		const parentType = hostParentType(ctx, json);
		if (formChoosesCase(form)) {
			if (parentType !== undefined && textOf(formMenu.case_type) === parentType)
				refuseBlock(REGISTRATION.parentFollowUp);
			else refuseBlock(REGISTRATION.missing);
			continue;
		}
		const registrations = registrationsOf(
			form,
			textOf(formMenu.case_type),
			caseType,
		);
		if (registrations.length !== 1) {
			refuseBlock(REGISTRATION.missing);
			continue;
		}
		if (json.put_in_root === true) {
			const details = isJsonObject(json.case_details) ? json.case_details : {};
			const short = isJsonObject(details.short) ? details.short : {};
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
		if (cls === "AdvancedModule" || named.module.docType === "AdvancedModule") {
			if (cls === "AdvancedModule" && caseListModuleRulesBreak(json))
				host.json.refuse(
					"case_list_form",
					REGISTRATION.advancedRulesBroken,
					undefined,
					listPlace,
				);
			else refuseBlock(REGISTRATION.advanced);
			continue;
		}
		if (registrations[0] === "child") {
			refuseBlock(REGISTRATION.childCase);
			continue;
		}
		const hiddenHost = hiddenNamed.get(named.form);
		if (hiddenHost !== undefined && hiddenHost !== host) {
			refuseBlock(REGISTRATION.anotherList);
			continue;
		}
		if (hiddenHost === host) {
			if (block.post_form_workflow === "default") {
				refuseBlock(REGISTRATION.hiddenDefault);
				continue;
			}
			readHidden(ctx, host, named.module, named.form, form);
			blocks.push({
				host,
				kind: "after-empty-search",
				form: named.form,
				hidden: named.module,
				media: false,
			});
			continue;
		}
		if (block.post_form_workflow !== "case_list" && selectsSeveral(json)) {
			refuseBlock(REGISTRATION.multiSelectDefault);
			continue;
		}
		const media = readAlways(ctx, host, named.form, form, block);
		blocks.push({ host, kind: "always", form: named.form, media });
	}
}

/** The `after-empty-search` arm: the block read, the hidden menu folded. */
function readHidden(
	ctx: ReadContext,
	host: DraftModule,
	menu: DraftModule,
	form: DraftForm,
	stored: JsonObject,
): void {
	const cursor = host.json.object(
		"case_list_form",
		"CaseListForm",
		REGISTRATION.hidden[host.docType],
		caseListPlaceOf(host),
	);
	cursor.take("form_id", REGISTRATION.hiddenFormId, (value) => value).value;
	cursor.take("post_form_workflow", REGISTRATION.workflow, (value) => value)
		.value;
	cursor.drop("relevancy_expression", REGISTRATION.relevancyInert);
	const label = readLabel(ctx, cursor, host, stored.name);
	fold(ctx, host, menu, form);
	ctx.writeDraft(() => {
		Object.assign(host.module, {
			caseListRegistrationForm: {
				kind: "after-empty-search",
				formUuid: form.uuid,
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
): boolean {
	const cursor = host.json.object(
		"case_list_form",
		"CaseListForm",
		REGISTRATION.always[host.docType],
		caseListPlaceOf(host),
	);
	cursor.take("form_id", REGISTRATION.alwaysFormId, (value) => value).value;
	const afterSubmit =
		block.post_form_workflow === "case_list" ? "case-list" : "new-case";
	cursor.take("post_form_workflow", REGISTRATION.workflow, (value) => value)
		.value;
	if (!blank(block.relevancy_expression))
		cursor.refuse("relevancy_expression", REGISTRATION.relevancyHeld);
	else cursor.drop("relevancy_expression", REGISTRATION.relevancyInert);
	if (Array.isArray(block.custom_icons) && block.custom_icons.length > 0)
		cursor.refuse("custom_icons", REGISTRATION.customIcons);
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
 * Step 6, over the one expansion: the gate's registration rules hold over the
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
		const host = stored[block.host.index] ?? {};
		const ours = moduleOf(block.host.uniqueId) as JsonObject | undefined;
		const source = isJsonObject(host.case_list_form) ? host.case_list_form : {};
		const emitted = isJsonObject(ours?.case_list_form)
			? ours.case_list_form
			: {};
		const unrecognized = (name: string) =>
			ctx.accounting.circumstance("unrecognized", listPlace, { name });
		if (source.form_id !== emitted.form_id) {
			unrecognized("schema:CaseListForm.form_id");
			continue;
		}
		const builtSource = labelAsBuilt(
			labelMap(source.label),
			langs,
			CREATE_A_NEW_CASE,
		);
		const builtOurs = labelAsBuilt(
			withReadTranslations(
				ctx,
				caseListFormLabelUnit(doc, block.host.uuid, block.form.uuid),
				labelMap(emitted.label),
			),
			langs,
			CREATE_A_NEW_CASE,
		);
		if (!sameJson(builtSource, builtOurs)) {
			unrecognized("schema:CaseListForm.label");
			continue;
		}
		if (source.post_form_workflow !== emitted.post_form_workflow) {
			unrecognized("schema:CaseListForm.post_form_workflow");
			continue;
		}
		if (block.kind === "after-empty-search") {
			if (
				!sameValue(source.relevancy_expression, emitted.relevancy_expression)
			) {
				unrecognized("schema:CaseListForm.relevancy_expression");
				continue;
			}
		}
		if (block.media) {
			const differs = (["media_image", "media_audio"] as const).find(
				(key) => !sameJson(source[key] ?? {}, emitted[key] ?? {}),
			);
			if (differs !== undefined) {
				unrecognized(`schema:CaseListForm.${differs}`);
				continue;
			}
		}
		if (block.hidden !== undefined) {
			const menu = stored[block.hidden.index] ?? {};
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
	const formOrder: Record<string, Uuid[]> = { ...doc.formOrder };
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
