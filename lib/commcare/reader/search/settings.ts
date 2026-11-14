/**
 * A search's own settings (`search_config`: its title, subtitle, button,
 * owner exclusion, supporting cases and the keys Nova holds nothing for),
 * and the acceptance of the whole menu's search: one call of
 * `hqJson/caseList.ts::projectCaseListForHq` per menu, whose
 * `search_config` must equal the stored one key by key after the inert
 * claims and the same-state rows.
 */
import type { BlueprintDoc, Expression, Module } from "@/lib/domain";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import {
	DEFAULT_CASE_SEARCH_TITLE,
	NO_SEARCH_SCREEN_TITLE,
	type OrdinaryCaseSearchConfig,
} from "@/lib/domain/modules";
import { projectCaseListForHq } from "../../hqJson/caseList";
import { HqXPath, hqXPathText } from "../../hqJson/xpath";
import { normalizeSpace } from "../../suite/wire";
import { type FormSyntax, formSyntaxKey } from "../../xpath/formSyntax";
import { w } from "../../xpath/wire/builders";
import { applicationReading } from "../appShell";
import { withCandidate } from "../candidate";
import { appCodes, firstText, languageMap } from "../caseList/columns";
import { sameState } from "../caseList/details";
import { defineClaims, derived, drop, refuse, take } from "../claims";
import type { DraftModule, ReadContext } from "../context";
import { readerDefect } from "../defects";
import { isJsonObject, type JsonCursor, sameJson } from "../jsonCursor";
import { pendingPlaceholder } from "../pendingExpressions";
import { readProjectionInputs } from "../projectionInputs";
import { sameXPathText } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import type { PromptReading } from "./prompts";
import { searchPlace } from "./workflow";

const S = "case-search/";

export const SETTING_CLAIMS = defineClaims("search.settings", {
	title: take(
		`${S}title-label-lang-non-empty`,
		"schema:CaseSearch.title_label",
	),
	titleBlank: take(
		`${S}title-label-or-blank-hq-s-default`,
		"schema:CaseSearch.title_label",
	),
	titleSome: refuse(
		`${S}title-label-blank-in-some-languages`,
		"schema:CaseSearch.title_label",
	),
	description: take(
		`${S}description-lang-markdown`,
		"schema:CaseSearch.description",
	),
	buttonDefault: take(
		`${S}search-button-label-hq-default-en-search-all-cases`,
		"schema:CaseSearch.search_button_label",
	),
	buttonOther: refuse(
		`${S}search-button-label-any-other-value`,
		"schema:CaseSearch.search_button_label",
	),
	ownerWithoutClause: refuse(
		`${S}blacklisted-owner-ids-expression-without-that-clause`,
		"schema:CaseSearch.blacklisted_owner_ids_expression",
	),
	includeDerived: derived(
		`${S}include-all-related-cases-implied-by-nova-relation-reads`,
		"schema:CaseSearch.include_all_related_cases",
	),
	includeFalse: refuse(
		`${S}include-all-related-cases-false-where-nova-s-relation-reads`,
		"schema:CaseSearch.include_all_related_cases",
	),
	includeAuthored: refuse(
		`${S}include-all-related-cases-authored-without-relation-reads`,
		"schema:CaseSearch.include_all_related_cases",
	),
	instanceUnreserved: refuse(
		`${S}instance-name-without-casedb-ledgerdb-fixture-or-session-in-it`,
		"schema:CaseSearch.instance_name",
	),
	instanceReserved: refuse(
		`${S}instance-name-containing-casedb-ledgerdb-fixture-or-session`,
		"schema:CaseSearch.instance_name",
	),
	instanceClash: refuse(
		`${S}a-module-whose-effective-results-instance-results-instance-name`,
		"schema:CaseSearch.instance_name",
	),
	instanceClashInert: drop(
		`${S}an-effective-results-instance-equal-to-a-module-s-that-does-not`,
		"schema:CaseSearch.instance_name",
	),
	additionalTypes: refuse(
		`${S}additional-case-types`,
		"schema:CaseSearch.additional_case_types",
	),
	relatedProperty: refuse(
		`${S}custom-related-case-property`,
		"schema:CaseSearch.custom_related_case_property",
	),
	customSort: refuse(
		`${S}custom-sort-properties-property-name-sort-type-exact-date`,
		"schema:CaseSearch.custom_sort_properties",
	),
	searchOnClear: refuse(
		`${S}search-on-clear`,
		"schema:CaseSearch.search_on_clear",
	),
	searchOnClearAuto: refuse(
		`${S}search-on-clear-with-the-case-list-s-auto-select-checked-whether`,
		"schema:CaseSearch.search_on_clear",
	),
	endpoint: refuse(
		`${S}case-search-endpoint-id`,
		"schema:CaseSearch.case_search_endpoint_id",
	),
	registry: refuse(
		`${S}data-registry-data-registry-workflow-additional-registry-cases`,
		"schema:CaseSearch.data_registry",
	),
	registryWorkflow: refuse(
		`${S}data-registry-data-registry-workflow-additional-registry-cases`,
		"schema:CaseSearch.data_registry_workflow",
	),
	registryCases: refuse(
		`${S}data-registry-data-registry-workflow-additional-registry-cases`,
		"schema:CaseSearch.additional_registry_cases",
	),
	removed: drop(
		`${S}removed-keys-dynamic-search-additional-relevant-search-filter`,
		"schema:CaseSearch",
	),
	unknown: drop(`${S}any-other-unknown-casesearch-key`, "schema:CaseSearch"),
});

const T = SETTING_CLAIMS;

/** The keys HQ's model removed (`models/case_search.py::CaseSearch`). */
const REMOVED_KEYS = new Set([
	"dynamic_search",
	"additional_relevant",
	"search_filter",
]);

/** The words Core routes an instance source by before the search's own prefixes
 *  (`CommCareInstanceInitializer.generateRoot`). */
const RESERVED_INSTANCE_WORDS = ["casedb", "ledgerdb", "fixture", "session"];

/** The results instance a menu's search loads into (`models/case_search.py::CaseSearch.get_instance_name`). */
function resultsInstance(config: unknown): string {
	const name = isJsonObject(config) ? config.instance_name : undefined;
	return typeof name === "string" && name !== ""
		? `results:${name}`
		: "results:inline";
}

/** Whether a menu's search is inline (`util.py::module_uses_inline_search`). */
function usesInlineSearch(config: unknown): boolean {
	if (!isJsonObject(config)) return false;
	const offers =
		(Array.isArray(config.properties) && config.properties.length > 0) ||
		(Array.isArray(config.default_properties) &&
			config.default_properties.length > 0);
	return offers && config.inline_search === true && config.auto_launch === true;
}

/**
 * Whether the menu's results instance is the one of the menu HQ compares it with, its root menu or
 * the menu its parent selection names (`helpers/validators.py`, `validate_search_config` and
 * `validate_parent_select`, which compare whether or not the menu searches): `"inline"` where that
 * menu's search is inline, which HQ's build refuses, `"other"` where it is not, which no runtime
 * reads.
 */
function instanceClash(
	ctx: ReadContext,
	module: DraftModule,
): "inline" | "other" | undefined {
	const own = resultsInstance(module.json.peek("search_config"));
	const root = module.json.peek("root_module_id");
	const parent = module.json.peek("parent_select");
	const ids = [
		...(typeof root === "string" && root !== "" ? [root] : []),
		...(isJsonObject(parent) &&
		parent.active === true &&
		typeof parent.module_id === "string"
			? [parent.module_id]
			: []),
	];
	let clash: "inline" | "other" | undefined;
	for (const id of ids) {
		const other = ctx.draft.modules.find((one) => one.uniqueId === id);
		if (other === undefined || other === module) continue;
		const config = other.json.peek("search_config");
		if (resultsInstance(config) !== own) continue;
		if (usesInlineSearch(config)) return "inline";
		clash = "other";
	}
	return clash;
}

/** HQ's model default for the search button's text. */
const BUTTON_DEFAULT = "Search All Cases";

/** A candidate whose projection threw, which no difference names. */
const EMITTER_THREW = "emitter-threw";

function parse(text: string): FormSyntax | undefined {
	const read = readFormSyntax(text);
	return read.ok ? read.node : undefined;
}

function unwrap(node: FormSyntax | undefined): FormSyntax | undefined {
	return node?.kind === "group" ? unwrap(node.value) : node;
}

/** Whether `node` is the owner clause `emitExcludedOwnerFilterExpression` writes:
 *  `X = '' or not(selected(X, @owner_id))`, the two `X` one tree. */
function isOwnerClause(node: FormSyntax | undefined): boolean {
	const clause = unwrap(node);
	if (clause?.kind !== "binary" || clause.op !== "or") return false;
	const blank = unwrap(clause.left);
	const not = unwrap(clause.right);
	if (
		blank?.kind !== "binary" ||
		blank.op !== "=" ||
		unwrap(blank.right)?.kind !== "string"
	)
		return false;
	if (not?.kind !== "call" || not.name !== "not" || not.args.length !== 1)
		return false;
	const selected = unwrap(not.args[0]);
	if (
		selected?.kind !== "call" ||
		selected.name !== "selected" ||
		selected.args.length !== 2
	)
		return false;
	const [list, owner] = selected.args;
	const ownerAttr = unwrap(owner);
	return (
		list !== undefined &&
		formSyntaxKey(list) === formSyntaxKey(blank.left) &&
		ownerAttr?.kind === "axis" &&
		ownerAttr.axis === "attribute" &&
		ownerAttr.value.kind === "name" &&
		ownerAttr.value.name === "owner_id"
	);
}

/**
 * The case list filter's text less the owner clause, where the menu's search holds an owner
 * exclusion and the filter's last top-level conjunct is the clause Nova writes for it. The rest
 * is the authored filter, registered on its own; the projection of the whole menu then holds the
 * two together.
 */
export function listFilterWithoutOwnerClause(
	module: DraftModule,
	text: string,
): string {
	const config = module.json.peek("search_config");
	const owners = isJsonObject(config)
		? config.blacklisted_owner_ids_expression
		: undefined;
	if (typeof owners !== "string" || owners.trim() === "") return text;
	const node = parse(text);
	if (node === undefined) return text;
	if (isOwnerClause(node)) return "";
	if (node.kind === "binary" && node.op === "and" && isOwnerClause(node.right))
		return text.slice(node.left.from, node.left.to);
	return text;
}

/** The two `replace` calls `suite/wire.ts::normalizeSpace` writes, re-emitted around a blank list. */
const NORMALIZE_SPACE_WRAPPER = unwrap(
	parse(hqXPathText(new HqXPath(normalizeSpace(w.str("")), "none"))),
);

/** Whether `node` is `replace(<list>, …)` with the wrapper call `wrapper`'s other two arguments. */
function wrapperCall(
	node: FormSyntax | undefined,
	wrapper: FormSyntax | undefined,
): FormSyntax | undefined {
	const call = unwrap(node);
	if (
		call?.kind !== "call" ||
		wrapper?.kind !== "call" ||
		call.name !== wrapper.name
	)
		return undefined;
	if (call.args.length !== 3 || wrapper.args.length !== 3) return undefined;
	const same = (at: number) =>
		formSyntaxKey(call.args[at] as FormSyntax) ===
		formSyntaxKey(wrapper.args[at] as FormSyntax);
	return same(1) && same(2) ? (call.args[0] as FormSyntax) : undefined;
}

/** The list inside the wrapper `suite/wire.ts::normalizeSpace` writes (found by re-emitting the
 *  wrapper and comparing syntax), or inside a whole-text `normalize-space(...)`; else the text. */
function withoutNormalizeSpace(text: string): string {
	const node = unwrap(parse(text));
	const innerWrapper =
		NORMALIZE_SPACE_WRAPPER?.kind === "call"
			? NORMALIZE_SPACE_WRAPPER.args[0]
			: undefined;
	const lowered = wrapperCall(
		wrapperCall(node, NORMALIZE_SPACE_WRAPPER),
		innerWrapper,
	);
	if (lowered !== undefined) return text.slice(lowered.from, lowered.to);
	if (
		node?.kind !== "call" ||
		node.name !== "normalize-space" ||
		node.args.length !== 1
	)
		return text;
	const inner = node.args[0] as FormSyntax;
	return text.slice(inner.from, inner.to);
}

/** Whether the stored list filter holds the owner clause. */
function filterHoldsOwnerClause(module: DraftModule): boolean {
	const details = module.json.peek("case_details");
	const short = isJsonObject(details) ? details.short : undefined;
	const filter = isJsonObject(short) ? short.filter : undefined;
	if (typeof filter !== "string" || filter.trim() === "") return false;
	const node = parse(filter);
	return (
		isOwnerClause(node) ||
		(node?.kind === "binary" && node.op === "and" && isOwnerClause(node.right))
	);
}

/** What the settings pass keeps for the settle. */
export interface SettingsReading {
	readonly ok: boolean;
	readonly owners?: number;
	readonly button?: number;
}

function byLanguage(ctx: ReadContext, map: Readonly<Record<string, string>>) {
	const tags = applicationReading(ctx)?.languages.tagOf;
	const first = appCodes(ctx)[0];
	return new Map(
		Object.entries(map).flatMap(([code, text]) => {
			const tag = tags?.get(code);
			return tag === undefined || code === first ? [] : [[tag, text] as const];
		}),
	);
}

/**
 * Reads the search's settings into `config`, the menu's search config being built. On a menu
 * that offers no search only the owner exclusion is read.
 */
export function readSearchSettings(
	ctx: ReadContext,
	module: DraftModule,
	cursor: JsonCursor,
	offers: boolean,
	config: Partial<OrdinaryCaseSearchConfig>,
): SettingsReading {
	const place = searchPlace(module);
	let ok = true;
	const register = (
		slot: "excluded_owner_ids" | "search_button_display_condition",
		key: string,
	) => {
		const stored = cursor.peek(key);
		if (typeof stored !== "string" || stored.trim() === "") return undefined;
		// The owner list is written inside `normalize-space(...)` (`suite/wire.ts::normalizeSpace`),
		// which the projection writes again around the list it holds.
		const text =
			slot === "excluded_owner_ids" ? withoutNormalizeSpace(stored) : stored;
		return ctx.pending.register(
			{
				ref: { entity: "module", uuid: module.uuid, slot },
				text,
				mode: { target: "hq-json", interpolation: "none" },
				place,
				key: `schema:CaseSearch.${key}`,
			},
			{ json: cursor, key },
		);
	};
	const clash = instanceClash(ctx, module);
	let owners: number | undefined;
	if (cursor.used("blacklisted_owner_ids_expression")) {
		if (!filterHoldsOwnerClause(module)) {
			cursor.refuse("blacklisted_owner_ids_expression", T.ownerWithoutClause);
			ok = false;
		} else {
			owners = register(
				"excluded_owner_ids",
				"blacklisted_owner_ids_expression",
			);
			if (owners !== undefined)
				config.excludedOwnerIds = pendingPlaceholder("value");
		}
	}
	if (!offers) {
		// A menu that offers no search still loads its results instance by name.
		if (clash === "inline") {
			ctx.accounting.finding(T.instanceClash, place);
			ok = false;
		}
		return { ok, ...(owners !== undefined && { owners }) };
	}

	const codes = appCodes(ctx);
	const title = languageMap(cursor.peek("title_label"));
	const blank = codes.filter((code) => (title[code] ?? "").trim() === "");
	if (blank.length === codes.length) {
		cursor.take("title_label", T.titleBlank, languageMap).value;
		config.searchScreenTitle = NO_SEARCH_SCREEN_TITLE;
		if (codes.some((code) => !(code in title)))
			sameState(
				ctx,
				T.titleBlank.entry,
				`${cursor.pointer}/title_label`,
				"list-settings-respelled",
			);
	} else if (blank.length > 0) {
		cursor.refuse("title_label", T.titleSome);
		ok = false;
	} else {
		cursor.take("title_label", T.title, languageMap).value;
		const text = firstText(ctx, title);
		const translated = codes.slice(1).some((code) => title[code] !== text);
		if (text !== DEFAULT_CASE_SEARCH_TITLE || translated) {
			config.searchScreenTitle = text;
			ctx.translations.set(
				makeTranslationUnitId("module", module.uuid, "search-title"),
				"text",
				byLanguage(ctx, title),
			);
		}
	}
	const description = languageMap(cursor.peek("description"));
	if (codes.some((code) => (description[code] ?? "") !== "")) {
		cursor.take("description", T.description, languageMap).value;
		config.searchScreenSubtitle = firstText(ctx, description);
		ctx.translations.set(
			makeTranslationUnitId("module", module.uuid, "search-subtitle"),
			"text",
			byLanguage(ctx, description),
		);
	} else if (cursor.used("description")) {
		// Blank in every language is no subtitle, as an absent map is.
		cursor.take("description", T.description, languageMap).value;
		if (codes.some((code) => !(code in description)))
			sameState(
				ctx,
				T.description.entry,
				`${cursor.pointer}/description`,
				"list-settings-respelled",
			);
	}
	const button = languageMap(cursor.peek("search_button_label"));
	if (sameJson(button, { en: BUTTON_DEFAULT }))
		cursor.take("search_button_label", T.buttonDefault, languageMap).value;
	else if (cursor.used("search_button_label")) {
		cursor.refuse("search_button_label", T.buttonOther);
		ok = false;
	}
	const buttonIndex = register(
		"search_button_display_condition",
		"search_button_display_condition",
	);
	if (buttonIndex !== undefined)
		config.searchButtonDisplayCondition = pendingPlaceholder("condition");

	const instance = cursor.peek("instance_name");
	const named = typeof instance === "string" && instance !== "";
	if (
		named &&
		RESERVED_INSTANCE_WORDS.some((word) => instance.includes(word))
	) {
		cursor.refuse("instance_name", T.instanceReserved);
		ok = false;
	} else if (clash === "inline") {
		if (named) cursor.refuse("instance_name", T.instanceClash);
		else ctx.accounting.finding(T.instanceClash, place);
		ok = false;
	} else if (named && clash === "other") {
		cursor.drop("instance_name", T.instanceClashInert);
	} else if (named) {
		cursor.refuse("instance_name", T.instanceUnreserved);
		ok = false;
	}
	const findings: [string, typeof T.additionalTypes][] = [
		["additional_case_types", T.additionalTypes],
		["custom_related_case_property", T.relatedProperty],
		["custom_sort_properties", T.customSort],
		["case_search_endpoint_id", T.endpoint],
		["data_registry", T.registry],
		["data_registry_workflow", T.registryWorkflow],
		["additional_registry_cases", T.registryCases],
	];
	for (const [key, claim] of findings)
		if (cursor.used(key)) {
			cursor.refuse(key, claim);
			ok = false;
		}
	if (cursor.used("search_on_clear")) {
		const details = module.json.peek("case_details");
		const short = isJsonObject(details) ? details.short : undefined;
		cursor.refuse(
			"search_on_clear",
			isJsonObject(short) && short.auto_select === true
				? T.searchOnClearAuto
				: T.searchOnClear,
		);
		ok = false;
	}
	cursor.derived("include_all_related_cases", T.includeDerived);
	for (const key of cursor.undeclared())
		cursor.drop(key, REMOVED_KEYS.has(key) ? T.removed : T.unknown);
	return {
		ok,
		...(owners !== undefined && { owners }),
		...(buttonIndex !== undefined && { button: buttonIndex }),
	};
}

// ── The whole menu's (R2) ───────────────────────────────────────────────

type JsonObject = Readonly<Record<string, unknown>>;

function printed(value: unknown): unknown {
	if (value instanceof HqXPath) return hqXPathText(value);
	if (Array.isArray(value)) return value.map(printed);
	if (isJsonObject(value))
		return Object.fromEntries(
			Object.entries(value).map(([key, one]) => [key, printed(one)]),
		);
	return value;
}

const BLANK = (value: unknown) =>
	value === undefined || value === null || value === "" || value === false;

function sameXPathValue(a: unknown, b: unknown): boolean {
	if (BLANK(a) || BLANK(b)) return BLANK(a) && BLANK(b);
	return typeof a === "string" && typeof b === "string" && sameXPathText(a, b);
}

function sameTexts(codes: readonly string[], a: unknown, b: unknown): boolean {
	const left = languageMap(a);
	const right = languageMap(b);
	return codes.every((code) => (left[code] ?? "") === (right[code] ?? ""));
}

const PROMPT_TEXT_KEYS = ["label", "hint"] as const;
const PROMPT_PLAIN_KEYS = ["name", "input_", "hidden", "exclude"] as const;

/** The surface key of the first difference between a stored prompt and the projection's. */
function promptDifference(
	codes: readonly string[],
	stored: JsonObject,
	ours: JsonObject,
): string | undefined {
	for (const key of PROMPT_PLAIN_KEYS)
		if (!(BLANK(stored[key]) && BLANK(ours[key])) && stored[key] !== ours[key])
			return `schema:CaseSearchProperty.${key}`;
	if (
		(stored.appearance === "barcode_scan") !==
		(ours.appearance === "barcode_scan")
	)
		return "schema:CaseSearchProperty.appearance";
	for (const key of PROMPT_TEXT_KEYS)
		if (!sameTexts(codes, stored[key], ours[key]))
			return `schema:CaseSearchProperty.${key}`;
	if (!sameXPathValue(stored.default_value, ours.default_value))
		return "schema:CaseSearchProperty.default_value";
	const itemA = isJsonObject(stored.itemset) ? stored.itemset : {};
	const itemB = isJsonObject(ours.itemset) ? ours.itemset : {};
	if ((itemA.instance_id ?? null) !== (itemB.instance_id ?? null))
		return "schema:Itemset.instance_id";
	for (const key of ["nodeset", "label", "value", "sort"] as const)
		if (!sameXPathValue(itemA[key], itemB[key])) return `schema:Itemset.${key}`;
	const reqA = isJsonObject(stored.required) ? stored.required : undefined;
	const reqB = isJsonObject(ours.required) ? ours.required : undefined;
	if ((reqA === undefined) !== (reqB === undefined))
		return "schema:CaseSearchProperty.required";
	if (reqA !== undefined && reqB !== undefined) {
		const testA = BLANK(reqA.test) ? "true()" : reqA.test;
		if (!sameXPathValue(testA, reqB.test)) return "schema:Assertion.test";
		if (!sameTexts(codes, reqA.text, reqB.text)) return "schema:Assertion.text";
	}
	const valA = Array.isArray(stored.validations)
		? stored.validations.filter(isJsonObject)
		: [];
	const valB = Array.isArray(ours.validations)
		? ours.validations.filter(isJsonObject)
		: [];
	if (valA.length !== valB.length)
		return "schema:CaseSearchProperty.validations";
	for (const [index, one] of valA.entries()) {
		const other = valB[index] as JsonObject;
		if (!sameXPathValue(one.test, other.test)) return "schema:Assertion.test";
		if (!sameTexts(codes, one.text, other.text)) return "schema:Assertion.text";
	}
	return undefined;
}

/** The surface key of the first difference between the stored search and the projection's,
 *  `default_properties` aside (the rows are held by `rows.ts`). */
function searchDifference(
	ctx: ReadContext,
	doc: BlueprintDoc,
	mod: Module,
	stored: JsonCursor,
): string | undefined {
	const inputs = readProjectionInputs(ctx);
	const ours = printed(
		projectCaseListForHq(mod, doc, inputs.assets, inputs.lookupNaming)
			.searchConfig,
	) as JsonObject;
	const codes = appCodes(ctx);
	for (const key of ["auto_launch", "default_search", "inline_search"] as const)
		if ((stored.peek(key) === true) !== (ours[key] === true))
			return `schema:CaseSearch.${key}`;
	for (const key of ["title_label", "description"] as const)
		if (!sameTexts(codes, stored.peek(key), ours[key]))
			return `schema:CaseSearch.${key}`;
	for (const key of [
		"search_button_display_condition",
		"blacklisted_owner_ids_expression",
	] as const)
		if (!sameXPathValue(stored.peek(key), ours[key]))
			return `schema:CaseSearch.${key}`;
	const promptsA = Array.isArray(stored.peek("properties"))
		? (stored.peek("properties") as unknown[]).filter(isJsonObject)
		: [];
	const promptsB = Array.isArray(ours.properties)
		? ours.properties.filter(isJsonObject)
		: [];
	if (promptsA.length !== promptsB.length)
		return "schema:CaseSearch.properties";
	for (const [index, prompt] of promptsA.entries()) {
		const key = promptDifference(codes, prompt, promptsB[index] as JsonObject);
		if (key !== undefined) return key;
	}
	if (
		(stored.peek("include_all_related_cases") === true) !==
		(ours.include_all_related_cases === true)
	)
		return "schema:CaseSearch.include_all_related_cases";
	return undefined;
}

function topLevel(expression: Expression): Expression[] {
	return expression.kind === "and" ? [...expression.clauses] : [expression];
}

/** The candidates of one validation rule: as read, then without the runtime guard Nova conjoins
 *  (its first or last top-level conjunct). */
function ruleCandidates(rule: Expression): Expression[] {
	const clauses = topLevel(rule);
	if (clauses.length < 2) return [rule];
	const without = (drop: number): Expression => {
		const rest = clauses.filter((_, index) => index !== drop);
		return rest.length === 1
			? (rest[0] as Expression)
			: { kind: "and", clauses: rest as [Expression, ...Expression[]] };
	};
	return [rule, without(clauses.length - 1), without(0)];
}

/**
 * The whole menu's search accepted: the projection's `search_config` equal to the stored one,
 * each validation rule tried as read and then without Nova's runtime guard. The settled
 * document is kept in `ctx.doc`.
 */
export function settleSearchSettings(
	ctx: ReadContext,
	module: DraftModule,
	cursor: JsonCursor,
	prompts: readonly PromptReading[],
): void {
	const place = searchPlace(module);
	const start = ctx.doc;
	if (start === undefined || start.modules[module.uuid] === undefined) return;
	const guarded = prompts.filter(
		(prompt) => prompt.validationRule !== undefined,
	);
	let candidates: BlueprintDoc[] = [start];
	for (const prompt of guarded)
		candidates = candidates.flatMap((doc) => {
			const entry = doc.modules[module.uuid]?.caseListConfig?.searchInputs.find(
				(one) => one.uuid === prompt.uuid,
			);
			if (
				entry === undefined ||
				entry.kind === "hidden" ||
				entry.validation === undefined
			)
				return [doc];
			const validation = entry.validation;
			const edited = (rule: Expression | undefined) =>
				withCandidate(doc, (draft) => {
					const one = draft.modules[
						module.uuid
					]?.caseListConfig?.searchInputs.find(
						(input) => input.uuid === prompt.uuid,
					);
					if (
						one === undefined ||
						one.kind === "hidden" ||
						one.validation === undefined
					)
						return;
					if (rule === undefined) delete one.validation;
					else one.validation.rule = rule as never;
				});
			// The rule as read; without the guard Nova conjoins; and, where the stored check is
			// Nova's guard alone, no authored rule at all.
			return [
				doc,
				...ruleCandidates(validation.rule)
					.slice(1)
					.map((rule) => edited(rule)),
				edited(undefined),
			];
		});
	let first: string | undefined;
	for (const doc of candidates) {
		const mod = doc.modules[module.uuid] as Module;
		let difference: string | undefined;
		try {
			difference = searchDifference(ctx, doc, mod, cursor);
		} catch {
			difference = EMITTER_THREW;
		}
		if (difference === undefined) {
			ctx.doc = doc;
			return;
		}
		first ??= difference;
	}
	if (first === "schema:CaseSearch.include_all_related_cases") {
		ctx.accounting.finding(
			cursor.peek("include_all_related_cases") === true
				? T.includeAuthored
				: T.includeFalse,
			place,
		);
		return;
	}
	if (first === EMITTER_THREW)
		ctx.accounting.defect(
			place,
			"schema:Module.search_config",
			readerDefect.emissionThrew(place, "projectCaseListForHq"),
		);
	else if (first !== undefined && !ctx.accounting.hasFindingAt(place))
		ctx.accounting.circumstance("unrecognized", place, { name: first });
}
