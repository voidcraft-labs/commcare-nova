/**
 * Each menu of an HQ app at the level of its own navigation: its case type,
 * nesting, the menu it shows its forms in, the parent case it chooses first,
 * its case list menu item and the settings HQ keeps beside them, and the
 * media of each menu and form. A menu's and a form's display condition is
 * text the expression stage binds, registered here and settled once bound.
 * Keys `readStructure` claims (a menu's name, id and forms) are read from the
 * drafts and claimed nothing again.
 */
import type { Draft } from "immer";
import {
	type BlueprintDoc,
	type Expression,
	formLinkEntries,
	type LanguageTag,
	type LocalizedValue,
	makeTranslationUnitId,
	menuScreenOf,
	otherwiseDestinationsOffered,
	type PostSubmitDestination,
	postSubmitDestinationsOffered,
	projectedModulePreorder,
	resolveFormLinkTarget,
	SlugsTaken,
	screenChoosesCaseFirst,
	type TranslationUnitId,
	type Uuid,
} from "@/lib/domain";
import { caseParentSelectionVerdict } from "@/lib/domain/caseParentSelection";
import { CASE_TYPE_PATTERN } from "@/lib/domain/expression/types";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import { menuWithInheritedCaseSettings } from "@/lib/domain/listedForms";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import type { HqPlace } from "@/lib/publish/hqFindings";
import {
	advancedLoadListMenus,
	formChoosesCase,
	parentStepRead,
} from "../../hq/entryFacts";
import { hiddenMenuEntryPoints } from "../../validator/rules/hiddenFromMenu";
import { applicationReading } from "../appShell";
import { withCandidate } from "../candidate";
import type { HeldTexts } from "../caseList/columns";
import { parentSelectionsExplained } from "../caseManagement/advancedActions";
import {
	account,
	type Claim,
	defineClaims,
	derived,
	drop,
	refuse,
	take,
} from "../claims";
import type { DraftApp, DraftForm, DraftModule, ReadContext } from "../context";
import {
	heldText,
	recordTextRewrite,
	refuseUnheldText,
	type UnheldText,
	unheldText,
} from "../heldText";
import type { JsonCursor } from "../jsonCursor";
import { isJsonObject, objectMembers } from "../jsonCursor";
import { readNavMedia } from "./navMedia";

const M = "menus-and-case-lists";
const F = "forms-and-case-writes";

type MenuClass = DraftModule["docType"];
type FormClass = "Form" | "AdvancedForm";
const MENU_CLASSES: readonly MenuClass[] = [
	"Module",
	"AdvancedModule",
	"ShadowModule",
];
const OWN_CASE_TYPE_CLASSES = ["Module", "AdvancedModule"] as const;
const FORM_CLASSES: readonly FormClass[] = ["Form", "AdvancedForm"];

/** One claim per class, its key the class's own spelling of the field. */
function perClass<C extends string, U extends Claim["use"]>(
	classes: readonly C[],
	make: (entry: string, key: string) => Claim<U>,
	entry: string,
	field: string,
): Readonly<Record<C, Claim<U>>> {
	return recordFromEntries(
		classes.map((cls) => [cls, make(entry, `schema:${cls}.${field}`)]),
	) as Record<C, Claim<U>>;
}

const MENU = {
	// A menu listing another menu's forms takes its case type from that menu
	// (`readCaseType`), so only the other two classes claim their own.
	caseType: perClass(
		OWN_CASE_TYPE_CLASSES,
		take,
		`${M}/modulebase-case-type`,
		"case_type",
	),
	survey: take(
		`${M}/module-with-case-type-survey-module`,
		"schema:Module.case_type",
	),
	caseTypeGrammar: perClass(
		OWN_CASE_TYPE_CLASSES,
		refuse,
		`${M}/case-type-outside-the-menu-page-s-grammar`,
		"case_type",
	),
	caseTypeReservedBasic: refuse(
		`${M}/case-type-commcare-user-or-user-owner-mapping-case-on-a-basic`,
		"schema:Module.case_type",
	),
	caseTypeWorkerAdvanced: refuse(
		`${M}/case-type-commcare-user-on-an-advancedmodule`,
		"schema:AdvancedModule.case_type",
	),
	training: perClass(
		MENU_CLASSES,
		refuse,
		`${M}/module-with-is-training-module-true-training-menu-root-training`,
		"is_training_module",
	),
	root: perClass(
		MENU_CLASSES,
		take,
		`${M}/child-menu-one-tier-root-module-id-a-parentless-module`,
		"root_module_id",
	),
	rootDeeper: perClass(
		MENU_CLASSES,
		refuse,
		`${M}/child-menu-deeper-than-one-tier-grandchild`,
		"root_module_id",
	),
	rootMissing: perClass(
		MENU_CLASSES,
		refuse,
		`${M}/root-module-id-naming-a-missing-module-or-a-cycle`,
		"root_module_id",
	),
	rootSharedChild: take(
		`${M}/shadowmodule-v2-under-a-v2-shadow-menu-mirroring-a-non-shadow`,
		"schema:ShadowModule.root_module_id",
	),
	rootUnderMirror: perClass(
		MENU_CLASSES,
		refuse,
		`${M}/any-other-module-under-a-shadow-menu`,
		"root_module_id",
	),
	rootUnderTraining: perClass(
		MENU_CLASSES,
		refuse,
		`${M}/any-module-under-a-training-menu`,
		"root_module_id",
	),
	rootCrossType: perClass(
		MENU_CLASSES,
		take,
		`${M}/child-menu-of-another-case-type-under-a-parent-with-no-forms`,
		"root_module_id",
	),
	order: refuse(
		`${M}/menu-order-that-separates-a-child-from-its-parent`,
		"schema:Application.modules",
	),
	putInRoot: perClass(
		MENU_CLASSES,
		take,
		`${M}/put-in-root-display-only-forms`,
		"put_in_root",
	),
	putInRootRefused: perClass(
		MENU_CLASSES,
		refuse,
		`${M}/put-in-root-session-endpoint-id-or-inline-search-or-an-end-of`,
		"put_in_root",
	),
	taskListHidden: perClass(
		["Module", "ShadowModule"] as const,
		drop,
		`${M}/module-task-list-show-false`,
		"task_list",
	),
	taskListShown: perClass(
		["Module", "ShadowModule"] as const,
		refuse,
		`${M}/module-task-list-show-true`,
		"task_list",
	),
	fixtureSelectInactive: perClass(
		MENU_CLASSES,
		drop,
		`${M}/fixture-select-active-false-stale-keys`,
		"fixture_select",
	),
	fixtureSelectActive: perClass(
		MENU_CLASSES,
		refuse,
		`${M}/fixture-select-active-true`,
		"fixture_select",
	),
	reportContextTile: perClass(
		MENU_CLASSES,
		refuse,
		`${M}/report-context-tile-true`,
		"report_context_tile",
	),
	lazyLoad: refuse(
		`${M}/module-lazy-load-case-list-fields-true`,
		"schema:Module.lazy_load_case_list_fields",
	),
	optimizations: perClass(
		MENU_CLASSES,
		refuse,
		`${M}/module-show-case-list-optimization-options`,
		"show_case_list_optimization_options",
	),
	customAssertions: perClass(
		MENU_CLASSES,
		refuse,
		`${M}/custom-assertions-module-non-empty`,
		"custom_assertions",
	),
	customIcons: perClass(
		MENU_CLASSES,
		take,
		`${M}/custom-icons-0-badge-localized-text-or-xpath`,
		"custom_icons",
	),
	caseListCustomIcons: drop(
		`${M}/case-list-item-badges`,
		"schema:CaseList.custom_icons",
	),
	displayStyle: refuse(
		`${M}/module-display-style-list-grid-read-when-grid-form-menus-some-on`,
		"schema:Module.display_style",
	),
	autoSelectRefused: refuse(
		`${M}/auto-select-case-true-on-a-basic-module-an-advanced-form-s-load`,
		"schema:Module.auto_select_case",
	),
	autoSelectInert: drop(
		`${M}/auto-select-case-true-on-any-other-basic-module`,
		"schema:Module.auto_select_case",
	),
	selectActive: perClass(
		["Module", "ShadowModule"] as const,
		take,
		`${M}/parent-select-active-true-relationship-parent-module-id-a-non`,
		"parent_select",
	),
	selectActiveFlag: take(
		`${M}/parent-select-active-true-relationship-parent-module-id-a-non`,
		"schema:ParentSelect.active",
	),
	selectModule: take(
		`${M}/parent-select-active-true-relationship-parent-module-id-a-non`,
		"schema:ParentSelect.module_id",
	),
	selectRelationship: take(
		`${M}/parent-select-active-true-relationship-parent-module-id-a-non`,
		"schema:ParentSelect.relationship",
	),
	selectRelationshipOther: refuse(
		`${M}/parent-select-relationship-null-other`,
		"schema:ParentSelect.relationship",
	),
	selectInactive: perClass(
		["Module", "ShadowModule"] as const,
		drop,
		`${M}/parent-select-active-false`,
		"parent_select",
	),
	selectInvalid: refuse(
		`${M}/parent-select-module-id-naming-a-multi-select-module-or-an`,
		"schema:ParentSelect.module_id",
	),
	selectInline: refuse(
		`${M}/parent-select-naming-a-module-that-searches-inline-under-the`,
		"schema:ParentSelect.module_id",
	),
	selectSurveyRead: refuse(
		`${M}/parent-select-naming-a-survey-module-on-a-child-that-shows-its`,
		"schema:ParentSelect.module_id",
	),
	selectSurveyUnread: drop(
		`${M}/parent-select-naming-a-survey-module-on-a-child-that-does-not`,
		"schema:ParentSelect.module_id",
	),
	selectOutsideType: take(
		`${M}/parent-select-naming-a-module-outside-the-declared-parent-type`,
		"schema:ParentSelect.module_id",
	),
	caseListFormless: take(
		`${M}/module-case-list-on-a-formless-basic-module-show-true`,
		"schema:Module.case_list",
	),
	caseListFormlessShow: take(
		`${M}/module-case-list-on-a-formless-basic-module-show-true`,
		"schema:CaseList.show",
	),
	caseListWithForms: take(
		`${M}/module-case-list-show-true-on-a-basic-module-with-forms`,
		"schema:Module.case_list",
	),
	caseListWithFormsShow: take(
		`${M}/module-case-list-show-true-on-a-basic-module-with-forms`,
		"schema:CaseList.show",
	),
	sharedListShown: refuse(
		`${M}/shadowmodule-case-list-show-true`,
		"schema:ShadowModule.case_list",
	),
	sharedListHidden: drop(
		`${M}/shadowmodule-case-list-show-false`,
		"schema:ShadowModule.case_list",
	),
	caseListAdvanced: take(
		`${M}/module-case-list-show-true-on-an-advancedmodule`,
		"schema:AdvancedModule.case_list",
	),
	caseListAdvancedShow: take(
		`${M}/module-case-list-show-true-on-an-advancedmodule`,
		"schema:CaseList.show",
	),
	caseListAdvancedHidden: drop(
		`${M}/module-case-list-show-false-on-an-advancedmodule`,
		"schema:AdvancedModule.case_list",
	),
	caseListBesideHidden: drop(
		`${M}/module-case-list-label-or-media-beside-show-false`,
		"schema:Module.case_list",
	),
	caseListLabel: take(
		`${M}/module-case-list-label-lang`,
		"schema:CaseList.label",
	),
	moduleFilterBlank: perClass(
		MENU_CLASSES,
		derived,
		`${M}/module-filter-value-lifts-into-predicate`,
		"module_filter",
	),
	moduleFilterFolded: perClass(
		MENU_CLASSES,
		derived,
		`${M}/module-filter-false-or-false-and-rest-menu-reached-only-by-links`,
		"module_filter",
	),
	moduleFilterOpened: perClass(
		MENU_CLASSES,
		refuse,
		`${M}/module-filter-false-on-a-menu-something-opens`,
		"module_filter",
	),
	formFilterBlank: perClass(
		FORM_CLASSES,
		derived,
		`${F}/form-filter-lifting-into-predicate-a-direct-own-case-property-in`,
		"form_filter",
	),
	formFilterOffCaseFirstScreen: refuse(
		`${M}/form-filter-reading-the-case-on-a-screen-that-chooses-no-case-first`,
		"schema:Form.form_filter",
	),
	formCustomAssertions: perClass(
		FORM_CLASSES,
		refuse,
		`${F}/custom-assertions-form-non-empty`,
		"custom_assertions",
	),
	formCustomIcons: perClass(
		FORM_CLASSES,
		take,
		`${F}/custom-icons-0`,
		"custom_icons",
	),
} as const;

defineClaims(
	"menus.modules",
	recordFromEntries(
		Object.entries(MENU).flatMap(([name, one]) =>
			"use" in one
				? [[name, one as Claim]]
				: Object.entries(one as Record<string, Claim>).map(([cls, claim]) => [
						`${name}@${cls}`,
						claim,
					]),
		),
	) as Record<string, Claim>,
);

type JsonObject = Readonly<Record<string, unknown>>;

// ── Shared reads of the stored app ──────────────────────────────────────

/** Every menu object of the stored app, in HQ's order. */
export function rawModules(ctx: ReadContext): readonly JsonObject[] {
	const modules = ctx.app.peek("modules");
	if (!Array.isArray(modules)) return [];
	let members = storedMembers.get(modules);
	if (members === undefined) {
		members = objectMembers(modules) ?? [];
		storedMembers.set(modules, members);
	}
	return members;
}

/** Each stored list of menus as `rawModules` reads it, judged once a reading. */
const storedMembers = new WeakMap<readonly unknown[], readonly JsonObject[]>();

/** The stored menu holding `uniqueId`, or undefined. */
export function rawModuleById(
	ctx: ReadContext,
	uniqueId: unknown,
): JsonObject | undefined {
	if (typeof uniqueId !== "string" || uniqueId === "") return undefined;
	const modules = rawModules(ctx);
	let byId = modulesById.get(modules);
	if (byId === undefined) {
		byId = new Map();
		for (const module of modules)
			if (!byId.has(module.unique_id)) byId.set(module.unique_id, module);
		modulesById.set(modules, byId);
	}
	return byId.get(uniqueId);
}

/** Each list of menus, the first menu of each id, made once a reading. */
const modulesById = new WeakMap<
	readonly JsonObject[],
	Map<unknown, JsonObject>
>();

/** The draft menu holding `uniqueId`, or undefined. */
export function draftModuleById(
	app: DraftApp,
	uniqueId: unknown,
): DraftModule | undefined {
	if (typeof uniqueId !== "string" || uniqueId === "") return undefined;
	return app.modules.find((module) => module.uniqueId === uniqueId);
}

/** The draft form a stored form id names: this read's id of a form, through
 *  `HqAppSourceForm.readUniqueId`. */
export function draftFormByReadId(
	ctx: ReadContext,
	readId: unknown,
): { readonly module: DraftModule; readonly form: DraftForm } | undefined {
	if (typeof readId !== "string" || readId === "") return undefined;
	for (const module of ctx.draft.modules)
		for (const form of module.forms) {
			const id =
				ctx.input.source.modules[form.menu]?.forms[form.index]?.readUniqueId;
			if (id === readId) return { module, form };
		}
	return undefined;
}

/** The app's language codes in HQ's order. */
export function appLanguageCodes(ctx: ReadContext): readonly string[] {
	return applicationReading(ctx)?.languages.codes ?? [];
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function compareCodePoints(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The text HQ's build writes for a translated label in each app language
 * (`xforms_extras.py::_trans` through `clean_trans`): for `lang`, the value
 * under the first of `[lang, ...langs]` that is a key of `label` with a
 * non-null value; where none is, the value of `label`'s first key in sorted
 * order, a `null` as "None"; `fallback` where that text is blank or `label`
 * is empty.
 */
export function labelAsBuilt(
	label: Readonly<Record<string, string | null>>,
	langs: readonly string[],
	fallback: string,
): Readonly<Record<string, string>> {
	const keys = Object.keys(label).sort(compareCodePoints);
	const built = recordFromEntries<string>([]);
	for (const lang of langs) {
		let text: string | undefined;
		for (const candidate of [lang, ...langs]) {
			const value = label[candidate];
			if (
				Object.hasOwn(label, candidate) &&
				value !== null &&
				value !== undefined
			) {
				text = value;
				break;
			}
		}
		if (text === undefined && keys.length > 0) {
			const value = label[keys[0] as string];
			text = value === null || value === undefined ? "None" : value;
		}
		built[lang] = text === undefined || text === "" ? fallback : text;
	}
	return built;
}

/** The text HQ's build writes for a case list menu item in each app language: for `lang`, the
 *  value under the first of `[lang, ...langs]` that is a key of `label` with a non-null value;
 *  where none is, the value of `label`'s first key in sorted order (by code point), as text, a
 *  `null` as "None"; "Case List" where that text is blank or `label` is empty. */
export function caseListLabelAsBuilt(
	label: Readonly<Record<string, string | null>>,
	langs: readonly string[],
): Readonly<Record<string, string>> {
	return labelAsBuilt(label, langs, "Case List");
}

/** A stored `{ lang: text }` map as `labelAsBuilt` reads it. */
export function labelMap(
	value: unknown,
): Readonly<Record<string, string | null>> {
	const map = recordFromEntries<string | null>([]);
	if (!isJsonObject(value)) return map;
	for (const [code, text] of Object.entries(value))
		if (typeof text === "string" || text === null) map[code] = text;
	return map;
}

/** Whether a stored label map holds Nova's spelling of `built`: every app
 *  language's text, as built, and no other language's. */
export function labelSpelledAsBuilt(
	stored: Readonly<Record<string, string | null>>,
	built: Readonly<Record<string, string>>,
	langs: readonly string[],
): boolean {
	return (
		langs.every((lang) => stored[lang] === built[lang]) &&
		Object.keys(stored).every((lang) => langs.includes(lang))
	);
}

/**
 * A label read as built (`labelAsBuilt`) as a reading holds it, by its role
 * (`heldText.ts::heldText`): no space at either end, and a language
 * blank-looking beside the source's text takes the source's text there.
 * Undefined where Nova's gate admits no spelling of a text, and `built` as it
 * is where the reading names no source language.
 */
export function heldLabel(
	ctx: ReadContext,
	built: Readonly<Record<string, string>>,
	role:
		| "case-list-menu-item-label"
		| "case-list-registration-label"
		| "menu-badge",
): HeldTexts | undefined {
	const languages = applicationReading(ctx)?.languages;
	const source = languages?.source;
	if (languages === undefined || source === undefined)
		return { texts: built, workersSeeAnother: false };
	const held = heldText(built, languages.codes, source, role);
	return held === undefined
		? undefined
		: { texts: held.printed, workersSeeAnother: held.workersSeeAnother };
}

/** The text of a label read as built that `heldLabel` holds no spelling of, and why
 *  (`heldText.ts::unheldText`); undefined where it holds every one. */
export function unheldLabel(
	ctx: ReadContext,
	built: Readonly<Record<string, string>>,
	role:
		| "case-list-menu-item-label"
		| "case-list-registration-label"
		| "menu-badge",
): UnheldText | undefined {
	const languages = applicationReading(ctx)?.languages;
	const source = languages?.source;
	return languages === undefined || source === undefined
		? undefined
		: unheldText(built, languages.codes, source, role);
}

/**
 * Writes a label read as built: the source language's text into the slot and
 * each other language whose text differs into the translation sink. Answers
 * the source language's text.
 */
export function writeBuiltLabel(
	ctx: ReadContext,
	unit: ReturnType<typeof makeTranslationUnitId>,
	built: Readonly<Record<string, string>>,
): string {
	const languages = applicationReading(ctx)?.languages;
	const sourceCode = languages?.source;
	const source = sourceCode === undefined ? "" : (built[sourceCode] ?? "");
	const translated = new Map<LanguageTag, LocalizedValue>();
	for (const [code, text] of Object.entries(built)) {
		if (code === sourceCode || text === source) continue;
		const tag = languages?.tagOf.get(code);
		if (tag !== undefined && !languages?.refused.has(code))
			translated.set(tag, text);
	}
	if (translated.size > 0) ctx.translations.set(unit, "text", translated);
	return source;
}

/**
 * A label map of the expansion as the document will print it once the text
 * stage has written this reading's translations: each language other than the
 * source takes the text read for `unit` in that language, where one was read.
 * `settleMenus` expands the app before the text stage runs, so the expansion
 * holds the source language's text in every language until then.
 */
export function withReadTranslations(
	ctx: ReadContext,
	unit: TranslationUnitId,
	map: Readonly<Record<string, string | null>>,
): Readonly<Record<string, string | null>> {
	const languages = applicationReading(ctx)?.languages;
	const read = ctx.translations.units().find((one) => one.unit === unit);
	if (languages === undefined || read === undefined) return map;
	const out = recordFromEntries(Object.entries(map));
	for (const code of languages.codes) {
		if (code === languages.source) continue;
		const tag = languages.tagOf.get(code);
		const text = tag === undefined ? undefined : read.byLanguage.get(tag);
		if (typeof text === "string") out[code] = text;
	}
	return out;
}

/** A menu's or form's name in each app language as Nova writes it: its own
 *  text, or the first language's where it holds none. */
export function effectiveNames(
	names: unknown,
	langs: readonly string[],
): Readonly<Record<string, string>> {
	const map = isJsonObject(names) ? names : NO_ENTRIES;
	const first = textOf(map[langs[0] ?? ""]);
	return recordFromEntries(
		langs.map((lang) => {
			const text = textOf(map[lang]);
			return [lang, text === "" ? first : text];
		}),
	);
}

/** Where a finding about a menu's case list stands: its case list menu item
 *  and the registration its list offers among them. */
export function caseListPlaceOf(module: DraftModule): HqPlace {
	return {
		kind: "case-list",
		menu: module.index,
		name: module.place.kind === "menu" ? module.place.name : "",
	};
}

/** HQ's `module_offers_search`: a search with a field or a default filter. */
export function offersSearch(module: JsonObject): boolean {
	const config = isJsonObject(module.search_config)
		? module.search_config
		: NO_ENTRIES;
	const nonEmpty = (value: unknown) => Array.isArray(value) && value.length > 0;
	return nonEmpty(config.properties) || nonEmpty(config.default_properties);
}

/** The results instance a menu's search loads into, whether or not it
 *  searches (`models/case_search.py::CaseSearch.get_instance_name`). */
function resultsInstanceOf(module: JsonObject): string {
	const config = isJsonObject(module.search_config)
		? module.search_config
		: NO_ENTRIES;
	const name = config.instance_name;
	return typeof name === "string" && name !== ""
		? `results:${name}`
		: "results:inline";
}

/** HQ's `module_uses_inline_search`: a search the menu's forms read. */
export function usesInlineSearch(module: JsonObject): boolean {
	const config = isJsonObject(module.search_config)
		? module.search_config
		: NO_ENTRIES;
	return (
		offersSearch(module) &&
		config.inline_search === true &&
		config.auto_launch === true
	);
}

/** Whether the stored menu's case list selects several cases. */
export function selectsSeveral(module: JsonObject): boolean {
	const details = isJsonObject(module.case_details)
		? module.case_details
		: NO_ENTRIES;
	const short = isJsonObject(details.short) ? details.short : NO_ENTRIES;
	return short.multi_select === true;
}

/** The stored forms of a menu. */
export function rawForms(module: JsonObject): readonly JsonObject[] {
	return objectMembers(module.forms) ?? [];
}

// ── The reading's state ─────────────────────────────────────────────────

interface ModulesReading {
	/** Each menu's `module_filter` registration. */
	readonly moduleFilters: Map<DraftModule, number>;
	/** Each form's `form_filter` registration. */
	readonly formFilters: Map<
		DraftForm,
		{ readonly menu: DraftModule; readonly index: number }
	>;
	/** Each parent selection `readModules` wrote, to be judged in `settleModules`. */
	readonly selections: Map<
		DraftModule,
		{ readonly named: DraftModule; readonly cursor: JsonCursor }
	>;
	/** The menus whose case list menu item `readModules` read. */
	readonly caseLists: Set<DraftModule>;
}

const READINGS = new WeakMap<ReadContext, ModulesReading>();

function readingOf(ctx: ReadContext): ModulesReading {
	let reading = READINGS.get(ctx);
	if (reading === undefined) {
		reading = {
			moduleFilters: new Map(),
			formFilters: new Map(),
			selections: new Map(),
			caseLists: new Set(),
		};
		READINGS.set(ctx, reading);
	}
	return reading;
}

// ── Pass 1 ──────────────────────────────────────────────────────────────

function menuClass(module: DraftModule): MenuClass {
	return module.docType;
}

/** The entries of a case type the reading refuses and keeps in the menu's draft. */
const KEPT_REFUSED_CASE_TYPES: ReadonlySet<string> = new Set([
	...Object.values(MENU.caseTypeGrammar).map((claim) => claim.entry),
	MENU.caseTypeReservedBasic.entry,
	MENU.caseTypeWorkerAdvanced.entry,
]);

/**
 * Whether a menu's case type stands refused and kept in its draft, so the
 * stages after this one read its forms as written: Nova's writer then cannot
 * write the document a reading's comparison emits, and that refusal is why.
 */
export function keepsRefusedCaseType(ctx: ReadContext): boolean {
	return ctx.accounting
		.findings()
		.some((finding) => KEPT_REFUSED_CASE_TYPES.has(finding.code));
}

function readCaseType(ctx: ReadContext, module: DraftModule): void {
	if (module.docType === "ShadowModule") return;
	const { json } = module;
	const caseType = json.peek("case_type");
	if (typeof caseType === "string" && caseType !== "") {
		// A name the menu page would not save, and the two case types HQ keeps
		// for itself, are each their entry; the menu keeps the name it stores, so
		// the stages after this one read its forms as written.
		const refused = !CASE_TYPE_PATTERN.test(caseType)
			? MENU.caseTypeGrammar[module.docType]
			: module.docType === "Module" &&
					(caseType === "commcare-user" ||
						caseType === "user-owner-mapping-case")
				? MENU.caseTypeReservedBasic
				: module.docType === "AdvancedModule" && caseType === "commcare-user"
					? MENU.caseTypeWorkerAdvanced
					: undefined;
		if (refused !== undefined) {
			json.refuse("case_type", refused);
			ctx.writeDraft(() => {
				Object.assign(module.module, { caseType });
			});
			return;
		}
		const value = json.take(
			"case_type",
			MENU.caseType[module.docType],
			textOf,
		).value;
		ctx.writeDraft(() => {
			Object.assign(module.module, { caseType: value });
		});
		return;
	}
	if (caseType === "" && module.docType === "Module")
		json.take("case_type", MENU.survey, textOf).value;
	else if (caseType === "")
		json.take("case_type", MENU.caseType[module.docType], textOf).value;
}

/** Whether following `root_module_id` from `start` returns to `start`: HQ's `root cycle`. */
function nestingCycles(ctx: ReadContext, start: string): boolean {
	const seen = new Set<string>();
	let current: unknown = start;
	while (typeof current === "string" && current !== "") {
		if (seen.has(current)) return current === start;
		seen.add(current);
		current = rawModuleById(ctx, current)?.root_module_id;
	}
	return false;
}

/** `root_module_id`: the parent, one tier deep, or the finding its row names. A cycle is
 *  tested before depth, since every menu of a cycle has a parent that has one. */
function readNesting(
	ctx: ReadContext,
	app: DraftApp,
	module: DraftModule,
): void {
	const { json } = module;
	const cls = menuClass(module);
	const rootId = json.peek("root_module_id");
	if (typeof rootId !== "string" || rootId === "") return;
	const target = rawModuleById(ctx, rootId);
	if (target === undefined || nestingCycles(ctx, module.uniqueId)) {
		json.refuse("root_module_id", MENU.rootMissing[cls]);
		return;
	}
	const parent = draftModuleById(app, rootId);
	if (target.doc_type === "ShadowModule") {
		const source = rawModuleById(ctx, json.peek("source_module_id"));
		if (
			cls !== "ShadowModule" ||
			target.shadow_module_version !== 2 ||
			source?.root_module_id !== target.source_module_id ||
			!parent?.module.formsFromMenu
		) {
			json.refuse("root_module_id", MENU.rootUnderMirror[cls]);
			return;
		}
		json.take("root_module_id", MENU.rootSharedChild, textOf).value;
		ctx.writeDraft(() => {
			module.module.parentModuleUuid = parent.uuid;
		});
		return;
	}
	if (target.is_training_module === true) {
		json.refuse("root_module_id", MENU.rootUnderTraining[cls]);
		return;
	}
	const grandparent = target.root_module_id;
	if (typeof grandparent === "string" && grandparent !== "") {
		json.refuse("root_module_id", MENU.rootDeeper[cls]);
		return;
	}
	const ownType = module.module.caseType ?? textOf(json.peek("case_type"));
	const parentType = textOf(target.case_type);
	const claim =
		rawForms(target).length === 0 && ownType !== parentType
			? MENU.rootCrossType[cls]
			: MENU.root[cls];
	json.take("root_module_id", claim, textOf).value;
	// A parent with no draft has its own finding; the child keeps no slot.
	if (parent !== undefined)
		ctx.writeDraft(() => {
			Object.assign(module.module, { parentModuleUuid: parent.uuid });
		});
}

/** Whether a stored form of any menu names `uniqueId` as a link target. */
function linkedAsMenu(ctx: ReadContext, uniqueId: string): boolean {
	return rawModules(ctx).some((menu) =>
		rawForms(menu).some(
			(form) =>
				form.post_form_workflow === "form" &&
				Array.isArray(form.form_links) &&
				form.form_links.some(
					(link) => isJsonObject(link) && link.module_unique_id === uniqueId,
				),
		),
	);
}

/** `put_in_root`: forms in the menu above, unless a row beside it takes it. */
function readFormsInMenuAbove(
	ctx: ReadContext,
	module: DraftModule,
	stored: JsonObject,
): void {
	const { json } = module;
	if (json.peek("put_in_root") !== true) return;
	const cls = menuClass(module);
	const endpoint = textOf(json.peek("session_endpoint_id")) !== "";
	// A form's end-of-form return to the menu (`post_form_workflow` `module`,
	// or `parent_module` from a child) is that form's refusal
	// (`afterSubmit.ts::refusedByBuild`), the word HQ's form validator names,
	// and the menu's own setting is read past it.
	if (
		endpoint ||
		usesInlineSearch(stored) ||
		linkedAsMenu(ctx, module.uniqueId)
	) {
		json.refuse("put_in_root", MENU.putInRootRefused[cls]);
		return;
	}
	json.take("put_in_root", MENU.putInRoot[cls], (value) => value).value;
	ctx.writeDraft(() => {
		Object.assign(module.module, { formsInMenuAbove: true });
	});
}

/** Whether a child menu reads the parent step of its selection: it shows its
 *  case list, a form of it requires a case, or a menu that does selects through it
 *  (`hq/entryFacts.ts::parentStepRead`, the rule the entry facts compare by). */
function childReadsParentStep(ctx: ReadContext, child: JsonObject): boolean {
	return parentStepRead(rawModules(ctx), child);
}

/** Whether following parent selections from `start` returns to `start`. */
function selectionCycles(ctx: ReadContext, start: string): boolean {
	const seen = new Set<string>();
	let current: unknown = start;
	while (typeof current === "string" && current !== "") {
		if (seen.has(current)) return current === start;
		seen.add(current);
		const menu = rawModuleById(ctx, current);
		const select = isJsonObject(menu?.parent_select)
			? menu.parent_select
			: NO_ENTRIES;
		current = select.active === true ? select.module_id : undefined;
	}
	return false;
}

/** `parent_select`: written now where it names a menu of this reading, judged in `settleModules`. */
function readParentSelection(
	ctx: ReadContext,
	app: DraftApp,
	module: DraftModule,
	stored: JsonObject,
): void {
	if (module.docType === "AdvancedModule") return;
	const { json } = module;
	const select = isJsonObject(stored.parent_select)
		? stored.parent_select
		: NO_ENTRIES;
	if (select.active !== true) {
		json.drop("parent_select", MENU.selectInactive[module.docType]);
		return;
	}
	const cursor = json.object(
		"parent_select",
		"ParentSelect",
		MENU.selectActive[module.docType],
	);
	cursor.take("active", MENU.selectActiveFlag, (value) => value).value;
	if (select.relationship !== "parent") {
		cursor.refuse("relationship", MENU.selectRelationshipOther);
		cursor.take("module_id", MENU.selectModule, (value) => value).value;
		return;
	}
	cursor.take("relationship", MENU.selectRelationship, (value) => value).value;
	const named = rawModuleById(ctx, select.module_id);
	const draft = draftModuleById(app, select.module_id);
	if (
		named === undefined ||
		draft === undefined ||
		select.module_id === module.uniqueId ||
		selectsSeveral(named) ||
		selectionCycles(ctx, module.uniqueId)
	) {
		cursor.refuse("module_id", MENU.selectInvalid);
		return;
	}
	// HQ's `validate_parent_select` refuses a menu searching inline only under
	// the child's own results instance name, whether or not the child searches.
	if (
		usesInlineSearch(named) &&
		resultsInstanceOf(stored) === resultsInstanceOf(named)
	) {
		cursor.refuse("module_id", MENU.selectInline);
		return;
	}
	if (textOf(named.case_type) === "") {
		if (childReadsParentStep(ctx, stored))
			cursor.refuse("module_id", MENU.selectSurveyRead);
		else cursor.drop("module_id", MENU.selectSurveyUnread);
		return;
	}
	cursor.take("module_id", MENU.selectModule, (value) => value).value;
	readingOf(ctx).selections.set(module, { named: draft, cursor });
	ctx.writeDraft(() => {
		Object.assign(module.module, { parentCaseModuleUuid: draft.uuid });
	});
}

/** `case_list`: the case list menu item, its label as HQ's build writes it, and its media. */
function readCaseListMenuItem(
	ctx: ReadContext,
	module: DraftModule,
	stored: JsonObject,
): void {
	const { json } = module;
	const caseList = isJsonObject(stored.case_list)
		? stored.case_list
		: NO_ENTRIES;
	if (module.docType === "ShadowModule") {
		if (caseList.show === true) json.refuse("case_list", MENU.sharedListShown);
		else json.drop("case_list", MENU.sharedListHidden);
		return;
	}
	if (caseList.show !== true) {
		if (!json.used("case_list")) return;
		json.drop(
			"case_list",
			module.docType === "AdvancedModule"
				? MENU.caseListAdvancedHidden
				: MENU.caseListBesideHidden,
		);
		return;
	}
	const formless = rawForms(stored).length === 0;
	const [container, show] =
		module.docType === "AdvancedModule"
			? [MENU.caseListAdvanced, MENU.caseListAdvancedShow]
			: formless
				? [MENU.caseListFormless, MENU.caseListFormlessShow]
				: [MENU.caseListWithForms, MENU.caseListWithFormsShow];
	const cursor = json.object(
		"case_list",
		"CaseList",
		container,
		caseListPlaceOf(module),
	);
	cursor.take("show", show, (value) => value).value;
	const langs = appLanguageCodes(ctx);
	const stored_ = labelMap(caseList.label);
	cursor.take("label", MENU.caseListLabel, (value) => value).value;
	const held = heldLabel(
		ctx,
		caseListLabelAsBuilt(stored_, langs),
		"case-list-menu-item-label",
	);
	// A label Nova's gate admits no spelling of is one finding at the case list, and the rest of
	// the item is still read.
	if (held === undefined)
		refuseUnheldText(
			ctx,
			caseListPlaceOf(module),
			"schema:CaseList.label",
			unheldLabel(
				ctx,
				caseListLabelAsBuilt(stored_, langs),
				"case-list-menu-item-label",
			),
		);
	else if (
		held.workersSeeAnother ||
		!labelSpelledAsBuilt(stored_, held.texts, langs)
	)
		recordTextRewrite(
			ctx,
			{ entry: MENU.caseListLabel.entry, path: `${cursor.pointer}/label` },
			"list-settings-respelled",
			held.workersSeeAnother,
		);
	const built = held?.texts;
	const names = effectiveNames(stored.name, langs);
	const label =
		built === undefined || langs.every((lang) => built[lang] === names[lang])
			? undefined
			: writeBuiltLabel(
					ctx,
					makeTranslationUnitId(
						"module",
						module.uuid,
						"case-list-menu-item-label",
					),
					built,
				);
	if (Array.isArray(caseList.custom_icons) && caseList.custom_icons.length > 0)
		cursor.drop("custom_icons", MENU.caseListCustomIcons);
	const media = readNavMedia(
		ctx,
		cursor,
		{ image: "case_list_icon", audio: "case_list_audio_label" },
		cursor.place,
	);
	readingOf(ctx).caseLists.add(module);
	ctx.writeDraft(() => {
		Object.assign(module.module, {
			caseListMenuItem: {
				...(label === undefined ? {} : { label }),
				...(media.icon === undefined ? {} : { icon: media.icon }),
				...(media.audioLabel === undefined
					? {}
					: { audioLabel: media.audioLabel }),
			},
		});
	});
}

const MENU_BADGE = `${M}/custom-icons-0-badge-localized-text-or-xpath`;
const FORM_BADGE = `${F}/custom-icons-0`;
const BADGE = defineClaims("menus.badges", {
	menuText: take(MENU_BADGE, "schema:CustomIcon.text"),
	formText: take(FORM_BADGE, "schema:CustomIcon.text"),
	menuForm: take(MENU_BADGE, "schema:CustomIcon.form"),
	formForm: take(FORM_BADGE, "schema:CustomIcon.form"),
	/** An empty calculation, which HQ's build reads as none (`menus.py`,
	 *  `entries.py`: `not custom_icon.xpath`) and Nova writes as `null`. */
	menuNoCalculation: take(MENU_BADGE, "schema:CustomIcon.xpath"),
	formNoCalculation: take(FORM_BADGE, "schema:CustomIcon.xpath"),
	later: account(`${M}/custom-icons-1`, "schema:CustomIcon"),
	unsupportedForm: refuse(
		`${M}/custom-icon-form-other-than-badge`,
		"schema:CustomIcon.form",
	),
	missingLabel: refuse(
		`${M}/badge-missing-localized-text`,
		"schema:CustomIcon.text",
	),
});

/** The navigation item reads the first icon. Missing language entries fall back to
 * the app's first language; unlike a menu name, they never take an arbitrary language. */
function readBadge(ctx: ReadContext, owner: DraftModule | DraftForm): void {
	const { json } = owner;
	if (!nonEmptyList(json.peek("custom_icons"))) return;
	const isForm = "form" in owner;
	const [first, ...rest] = json.list(
		"custom_icons",
		"CustomIcon",
		isForm
			? MENU.formCustomIcons[owner.docType]
			: MENU.customIcons[owner.docType],
	);
	for (const later of rest) later.refuseWhole(BADGE.later);
	if (first === undefined) return;
	if (first.used("form")) {
		first.refuseWhole(BADGE.unsupportedForm);
		return;
	}
	// The icon's class is the list's declared one, which HQ's wrap takes
	// without its doc_type choosing it, so no use of the class is read here:
	// its keys are claimed one by one below.
	first.takeDefault("form", isForm ? BADGE.formForm : BADGE.menuForm);
	const xpath = first.peek("xpath");
	const entry = isForm ? FORM_BADGE : MENU_BADGE;
	const rewrite = (path: string) =>
		ctx.facts.sameStateRewrites.push({
			entry,
			path,
			register: "badge-respelled",
		});
	if (rest.length) rewrite(`${json.pointer}/custom_icons`);
	const asText = isForm ? BADGE.formText : BADGE.menuText;
	const stored = labelMap(first.peek("text"));
	if (typeof xpath === "string" && xpath !== "") {
		if (Object.keys(stored).length) rewrite(`${first.pointer}/text`);
		first.take("text", asText, labelMap).value;
		// The expression stage writes its outcome through the registered slot.
		ctx.writeDraft(() => {
			const target = isForm ? owner.form : owner.module;
			target.badge = {
				kind: "calculation",
				expression: { kind: "term", term: { kind: "literal", value: "" } },
			};
		});
		ctx.pending.register(
			{
				ref: isForm
					? { entity: "form", uuid: owner.uuid, slot: "form_badge" }
					: { entity: "module", uuid: owner.uuid, slot: "module_badge" },
				text: xpath,
				mode: { target: "hq-json", interpolation: "none" },
				key: "schema:CustomIcon.xpath",
				place: owner.place,
			},
			{ json: first, key: "xpath" },
		);
		return;
	}
	const langs = appLanguageCodes(ctx);
	if (xpath === "") {
		first.take(
			"xpath",
			isForm ? BADGE.formNoCalculation : BADGE.menuNoCalculation,
			() => null,
		).value;
		rewrite(`${first.pointer}/xpath`);
	}
	const emitted = recordFromEntries(
		langs.map((lang) => [
			lang,
			(Object.hasOwn(stored, lang) ? stored[lang] : stored[langs[0] ?? "en"]) ??
				"",
		]),
	);
	// HQ overlays the build languages in reverse order into its default
	// catalog; Core loads that catalog before the worker's selected language.
	const fallback = langs.map((lang) => emitted[lang]).find(Boolean);
	if (!fallback) {
		// Refused whole: an empty text map sits at its default, where a
		// refusal of the key alone would record nothing.
		first.refuseWhole(BADGE.missingLabel);
		return;
	}
	const built = recordFromEntries(
		langs.map((lang) => [lang, emitted[lang] || fallback]),
	);
	first.take("text", asText, labelMap).value;
	const held = heldLabel(ctx, built, "menu-badge");
	if (!held) {
		refuseUnheldText(
			ctx,
			owner.place,
			"schema:CustomIcon.text",
			unheldLabel(ctx, built, "menu-badge"),
		);
		return;
	}
	if (held.workersSeeAnother || !labelSpelledAsBuilt(stored, held.texts, langs))
		recordTextRewrite(
			ctx,
			{ entry: asText.entry, path: `${first.pointer}/text` },
			"badge-respelled",
			held.workersSeeAnother,
		);
	const value = writeBuiltLabel(
		ctx,
		makeTranslationUnitId(isForm ? "form" : "module", owner.uuid, "badge"),
		held.texts,
	);
	if (value)
		ctx.writeDraft(() => {
			const target = isForm ? owner.form : owner.module;
			target.badge = { kind: "text", text: value };
		});
}

function nonEmptyList(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0;
}

/** Whether an advanced form's chosen load lists its cases from `uniqueId`'s list, the one
 *  place HQ's build reads a menu's `auto_select_case` (`hq/entryFacts.ts::advancedLoadListMenus`). */
function loadListsFrom(ctx: ReadContext, uniqueId: string): boolean {
	return advancedLoadListMenus(rawModules(ctx)).has(uniqueId);
}

/** The settings HQ keeps beside a menu that Nova holds no slot for. */
function readMenuSettings(
	ctx: ReadContext,
	module: DraftModule,
	stored: JsonObject,
): void {
	const { json } = module;
	const cls = menuClass(module);
	if (stored.is_training_module === true)
		json.refuse("is_training_module", MENU.training[cls]);
	if (module.docType === "Module" || module.docType === "ShadowModule") {
		const taskList = isJsonObject(stored.task_list)
			? stored.task_list
			: NO_ENTRIES;
		if (json.used("task_list"))
			if (taskList.show === true)
				json.refuse("task_list", MENU.taskListShown[module.docType]);
			else json.drop("task_list", MENU.taskListHidden[module.docType]);
	}
	if (module.docType === "Module") {
		if (stored.lazy_load_case_list_fields === true)
			json.refuse("lazy_load_case_list_fields", MENU.lazyLoad);
		if (json.used("display_style"))
			json.refuse("display_style", MENU.displayStyle);
		if (stored.auto_select_case === true)
			if (loadListsFrom(ctx, module.uniqueId))
				json.refuse("auto_select_case", MENU.autoSelectRefused);
			else json.drop("auto_select_case", MENU.autoSelectInert);
	}
	const fixtureSelect = isJsonObject(stored.fixture_select)
		? stored.fixture_select
		: NO_ENTRIES;
	if (json.used("fixture_select"))
		if (fixtureSelect.active === true)
			json.refuse("fixture_select", MENU.fixtureSelectActive[cls]);
		else json.drop("fixture_select", MENU.fixtureSelectInactive[cls]);
	if (stored.report_context_tile === true)
		json.refuse("report_context_tile", MENU.reportContextTile[cls]);
	if (stored.show_case_list_optimization_options === true)
		json.refuse("show_case_list_optimization_options", MENU.optimizations[cls]);
	if (nonEmptyList(stored.custom_assertions))
		json.refuse("custom_assertions", MENU.customAssertions[cls]);
	readBadge(ctx, module);
}

/** A display condition's text, registered whole for the expression stage. */
function registerModuleFilter(ctx: ReadContext, module: DraftModule): void {
	const { json } = module;
	const cls = menuClass(module);
	const text = json.peek("module_filter");
	if (typeof text !== "string") return;
	if (text.trim() === "") {
		json.derived("module_filter", MENU.moduleFilterBlank[cls]);
		return;
	}
	const index = ctx.pending.register(
		{
			ref: {
				entity: "module",
				uuid: module.uuid,
				slot: "module_display_condition",
			},
			text,
			mode: { target: "hq-json", interpolation: "no-case" },
			place: module.place,
			key: `schema:${cls}.module_filter`,
		},
		{ json, key: "module_filter" },
	);
	readingOf(ctx).moduleFilters.set(module, index);
}

/** Whether a menu's lookup table selection is active, where HQ's build names a fixture as it
 *  interpolates each of its forms' display conditions (`menus.py`, `fixture_xpath` where
 *  `module.fixture_select.active`). */
function fixtureSelectActive(module: DraftModule): boolean {
	const selection = module.json.peek("fixture_select");
	return isJsonObject(selection) && Boolean(selection.active);
}

function registerFormFilter(
	ctx: ReadContext,
	module: DraftModule,
	form: DraftForm,
): void {
	const { json } = form;
	const text = json.peek("form_filter");
	if (typeof text !== "string") return;
	if (text.trim() === "") {
		json.derived("form_filter", MENU.formFilterBlank[form.docType]);
		return;
	}
	const choosesCase = formChoosesCase({
		doc_type: form.docType,
		requires: json.peek("requires"),
		actions: json.peek("actions"),
	});
	const index = ctx.pending.register(
		{
			ref: { entity: "form", uuid: form.uuid, slot: "form_display_condition" },
			text,
			mode: {
				target: "hq-json",
				interpolation: choosesCase ? "case" : "no-case",
			},
			place: form.place,
			key: `schema:${form.docType}.form_filter`,
			...(fixtureSelectActive(module) ? { fixtureValue: true } : {}),
		},
		{ json, key: "form_filter" },
	);
	readingOf(ctx).formFilters.set(form, { menu: module, index });
}

/** A form's own navigation settings: its media, badges and assertions. */
function readFormSettings(ctx: ReadContext, form: DraftForm): void {
	const { json } = form;
	if (nonEmptyList(json.peek("custom_assertions")))
		json.refuse("custom_assertions", MENU.formCustomAssertions[form.docType]);
	readBadge(ctx, form);
	const media = readNavMedia(
		ctx,
		json,
		{ image: "form_icon", audio: "form_audio_label" },
		form.place,
	);
	if (media.icon !== undefined || media.audioLabel !== undefined)
		ctx.writeDraft(() => {
			Object.assign(form.form, media);
		});
}

/**
 * Every menu's own navigation, in HQ's order. A hidden registration
 * menu `readCaseListRegistration` folded into its host (`app.foldedMenus`)
 * reads no nesting, display condition, case list item or slot of its own:
 * the one expansion of `settleMenus` holds its keys to Nova's shell.
 */
export function readModules(ctx: ReadContext, app: DraftApp): void {
	const folded = new Set(app.foldedMenus.map((one) => one.menu));
	const stored = rawModules(ctx);
	for (const module of app.modules) {
		const menu = stored[module.index] ?? NO_ENTRIES;
		readCaseType(ctx, module);
		readMenuSettings(ctx, module, menu);
		const media = readNavMedia(
			ctx,
			module.json,
			{ image: "module_icon", audio: "module_audio_label" },
			module.place,
		);
		if (folded.has(module)) {
			// The hidden-menu shape holds no parent selection and no case list
			// item; each is read as on any menu, into a draft no document holds.
			readParentSelection(ctx, app, module, menu);
			readCaseListMenuItem(ctx, module, menu);
			module.json.derived(
				"module_filter",
				MENU.moduleFilterFolded[menuClass(module)],
			);
			continue;
		}
		readNesting(ctx, app, module);
		readFormsInMenuAbove(ctx, module, menu);
		readParentSelection(ctx, app, module, menu);
		readCaseListMenuItem(ctx, module, menu);
		registerModuleFilter(ctx, module);
		if (media.icon !== undefined || media.audioLabel !== undefined)
			ctx.writeDraft(() => {
				Object.assign(module.module, media);
			});
	}
	for (const module of app.modules)
		for (const form of module.forms) {
			readFormSettings(ctx, form);
			registerFormFilter(ctx, module, form);
		}
	writeMenuIds(ctx, app, folded);
	checkMenuOrder(ctx, app, folded);
}

/** `Module.id`: a slug of the source language's name among the menus read, else the first
 *  language's that holds one. */
function writeMenuIds(
	ctx: ReadContext,
	app: DraftApp,
	folded: ReadonlySet<DraftModule>,
): void {
	const langs = appLanguageCodes(ctx);
	const sourceCode = applicationReading(ctx)?.languages.source ?? langs[0];
	const stored = rawModules(ctx);
	const taken = new SlugsTaken();
	for (const module of app.modules) {
		if (folded.has(module)) continue;
		const names = isJsonObject(stored[module.index]?.name)
			? (stored[module.index]?.name as JsonObject)
			: NO_ENTRIES;
		const source = textOf(names[sourceCode ?? ""]);
		const name =
			source !== ""
				? source
				: (langs
						.map((lang) => textOf(names[lang]))
						.find((text) => text !== "") ?? "");
		const id = taken.take(name, "menu");
		ctx.writeDraft(() => {
			Object.assign(module.module, { id });
		});
	}
}

/** HQ's menu order must be Nova's: each child right after its parent's block. */
function checkMenuOrder(
	ctx: ReadContext,
	app: DraftApp,
	folded: ReadonlySet<DraftModule>,
): void {
	const menus = app.modules.filter((module) => !folded.has(module));
	const modules: Record<string, { parentModuleUuid?: Uuid }> =
		recordFromEntries([]);
	for (const module of menus)
		modules[module.uuid] = {
			...(module.module.parentModuleUuid === undefined
				? {}
				: { parentModuleUuid: module.module.parentModuleUuid }),
		};
	const moduleOrder = menus.map((module) => module.uuid);
	const preorder = projectedModulePreorder({
		modules: modules as BlueprintDoc["modules"],
		moduleOrder,
	});
	const index = preorder.findIndex((uuid, at) => uuid !== moduleOrder[at]);
	if (index === -1) return;
	const child =
		menus.find((module) => module.uuid === preorder[index]) ?? menus[index];
	// The order is the app's list of menus, which the refusal stands at too.
	if (child !== undefined)
		ctx.accounting.findingAt(MENU.order, child.place, "/modules");
}

// ── Pass 2 ──────────────────────────────────────────────────────────────

/** A bound filter as Nova's two slots: off the menu, and the rest. */
function displaySlots(expression: Expression): {
	readonly hidden: boolean;
	readonly condition?: Expression;
} {
	if (expression.kind === "match-none") return { hidden: true };
	if (
		expression.kind === "and" &&
		expression.clauses[0]?.kind === "match-none"
	) {
		const rest = expression.clauses.slice(1);
		if (rest.length === 0) return { hidden: true };
		return {
			hidden: true,
			condition:
				rest.length === 1
					? (rest[0] as Expression)
					: { kind: "and", clauses: rest as [Expression, ...Expression[]] },
		};
	}
	return { hidden: false, condition: expression };
}

/** The two slots written over the whole filter the expression stage bound
 *  into the condition slot: a filter that is `false()` alone holds no
 *  condition of its own. */
function applyDisplay(
	target: Draft<{ hiddenFromMenu?: true; displayCondition?: Expression }>,
	expression: Expression,
): void {
	const slots = displaySlots(expression);
	if (slots.hidden) target.hiddenFromMenu = true;
	if (slots.condition !== undefined)
		target.displayCondition = slots.condition as Draft<Expression>;
	else delete target.displayCondition;
}

/**
 * In the menus' settle, before the one expansion: each bound display condition written
 * into its slots, each parent selection judged against the final catalog,
 * and each form condition that reads its case on a screen that chooses none
 * first refused.
 */
export function settleModules(
	ctx: ReadContext,
	returns: ReadonlyMap<Uuid, PostSubmitDestination> = new Map(),
): void {
	const doc = ctx.doc;
	if (doc === undefined) return;
	const reading = readingOf(ctx);
	ctx.doc = withCandidate(doc, (draft) => {
		for (const [module, index] of reading.moduleFilters) {
			const expression = ctx.pending.outcome(index).expression;
			const target = draft.modules[module.uuid];
			if (expression !== undefined && target !== undefined)
				applyDisplay(target, expression);
		}
		for (const [form, { index }] of reading.formFilters) {
			const expression = ctx.pending.outcome(index).expression;
			const target = draft.forms[form.uuid];
			if (expression !== undefined && target !== undefined)
				applyDisplay(target, expression);
		}
	});
	refuseOpenedOffTheMenu(ctx, reading, returns);
	settleFormFilters(ctx, reading);
	settleParentSelections(ctx, reading);
}

/**
 * Whether something opens `moduleUuid`, a menu off the menu: an entry point of its own or of its
 * case list, an after-submit link whose target is the menu, or a form's return (its after-submit,
 * as the document holds it or, before the settle writes it, as `returns` gives its stored word, or
 * its otherwise) that the menu's being off the menu leaves unoffered, which is the return to the
 * menu, or from a child menu to its parent. Android opens such a menu as a screen that lists
 * nothing and Web Apps lands on the app's first screen (`validator/rules/hiddenFromMenu.ts`).
 */
function opensOffTheMenu(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	returns: ReadonlyMap<Uuid, PostSubmitDestination>,
): boolean {
	const mod = doc.modules[moduleUuid];
	if (mod?.hiddenFromMenu !== true) return false;
	if (hiddenMenuEntryPoints(mod, moduleUuid).length > 0) return true;
	const shown = withCandidate(doc, (draft) => {
		const target = draft.modules[moduleUuid];
		if (target !== undefined) delete target.hiddenFromMenu;
	});
	return Object.entries(doc.forms).some(([formUuid, form]) => {
		const uuid = formUuid as Uuid;
		for (const { link } of formLinkEntries(form)) {
			const target = resolveFormLinkTarget(doc, uuid, link.target);
			if (target?.type === "module" && target.moduleUuid === moduleUuid)
				return true;
		}
		const goes = form.postSubmit ?? returns.get(uuid);
		if (
			goes !== undefined &&
			form.formLinks === undefined &&
			!postSubmitDestinationsOffered(doc, uuid).includes(goes) &&
			postSubmitDestinationsOffered(shown, uuid).includes(goes)
		)
			return true;
		const otherwise = form.otherwise;
		return (
			otherwise?.kind === "destination" &&
			!otherwiseDestinationsOffered(doc, uuid).includes(
				otherwise.destination,
			) &&
			otherwiseDestinationsOffered(shown, uuid).includes(otherwise.destination)
		);
	});
}

/**
 * A menu the bound display condition puts off the menu while something opens it: one finding at
 * the menu, and the menu read as shown, so what opens it stands under that one cause.
 */
function refuseOpenedOffTheMenu(
	ctx: ReadContext,
	reading: ModulesReading,
	returns: ReadonlyMap<Uuid, PostSubmitDestination>,
): void {
	for (const module of reading.moduleFilters.keys()) {
		const doc = ctx.doc;
		if (doc === undefined || !opensOffTheMenu(doc, module.uuid, returns))
			continue;
		if (!ctx.accounting.hasFindingAt(module.place))
			ctx.accounting.findingAt(
				MENU.moduleFilterOpened[menuClass(module)],
				module.place,
				`${module.json.pointer}/module_filter`,
			);
		ctx.doc = withCandidate(doc, (draft) => {
			const target = draft.modules[module.uuid];
			if (target !== undefined) delete target.hiddenFromMenu;
		});
	}
}

/**
 * Whether a form's display condition reads the case its menu chooses: the
 * form's own case or one above it (`form-case`), or a value an earlier
 * selection supplies (`session-datum`). A query over the case database that
 * names no chosen case reads nothing a screen has to choose first.
 */
function readsChosenCase(expression: Expression): boolean {
	let found = false;
	walkExpressionTerms(expression, (term) => {
		if (term.kind === "form-case" || term.kind === "session-datum")
			found = true;
	});
	return found;
}

function settleFormFilters(ctx: ReadContext, reading: ModulesReading): void {
	const doc = ctx.doc;
	if (doc === undefined) return;
	for (const [form, { menu }] of reading.formFilters) {
		const condition = doc.forms[form.uuid]?.displayCondition;
		if (condition === undefined || !readsChosenCase(condition)) continue;
		if (doc.modules[menu.uuid] === undefined) continue;
		if (!screenChoosesCaseFirst(doc, menuScreenOf(doc, menu.uuid)))
			ctx.accounting.finding(MENU.formFilterOffCaseFirstScreen, form.place);
	}
}

/** Each parent selection `readModules` wrote, judged now that the catalog is final;
 *  one the gate refuses is taken out of the draft. */
function settleParentSelections(
	ctx: ReadContext,
	reading: ModulesReading,
): void {
	for (const [module, { named, cursor }] of reading.selections) {
		const doc = ctx.doc;
		if (doc === undefined || doc.modules[module.uuid] === undefined) continue;
		const verdict = caseParentSelectionVerdict(doc, module.uuid, named.uuid);
		if (verdict.ok) {
			const catalogType = doc.caseTypes?.find(
				(type) =>
					type.name ===
					menuWithInheritedCaseSettings(doc, module.uuid)?.caseType,
			);
			if (
				catalogType?.parent_type !==
					menuWithInheritedCaseSettings(doc, named.uuid)?.caseType ||
				catalogType?.relationship === "extension"
			)
				ctx.accounting.claimEntryClass(
					{ json: cursor, key: "module_id" },
					MENU.selectOutsideType.entry,
					"schema:ParentSelect.module_id",
					module.place,
				);
			continue;
		}
		// A finding at the named menu or its case list left out of the document
		// what the selection would choose through: that finding is the cause.
		// So did a refused `parent` index that leaves the catalog with no parent for the type.
		const namedRefused =
			ctx.accounting.hasFindingAt(named.place) ||
			ctx.accounting.hasFindingAt(caseListPlaceOf(named)) ||
			parentSelectionsExplained(ctx).has(module.uuid);
		if (!namedRefused) ctx.accounting.finding(MENU.selectInvalid, module.place);
		ctx.doc = withCandidate(doc, (draft) => {
			const target = draft.modules[module.uuid];
			if (target !== undefined) delete target.parentCaseModuleUuid;
		});
	}
}

/** The menus whose case list menu item was read, for the label's acceptance. */
export function caseListMenus(ctx: ReadContext): ReadonlySet<DraftModule> {
	return readingOf(ctx).caseLists;
}
