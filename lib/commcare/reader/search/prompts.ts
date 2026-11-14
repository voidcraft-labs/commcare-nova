/**
 * A search's prompts read into its Search fields: each entry of
 * `search_config.properties`, in order, one `searchInputs` entry, its keys
 * claimed by their rows and its expressions registered. Which arm a visible
 * field takes is decided with the rows of `_xpath_query` (`rows.ts`), so
 * this pass writes each field at a proposal that keeps the document whole:
 * simple over its name without `exclude`, advanced with a condition to come
 * with it.
 */
import type {
	BlueprintDoc,
	LookupColumnId,
	LookupTableId,
	SearchInputDef,
	Uuid,
} from "@/lib/domain";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import {
	DEFAULT_SEARCH_MODE_KIND,
	SEARCH_INPUT_NAME_PATTERN,
	SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
	type SearchInputLookupOptions,
} from "@/lib/domain/modules";
import type { SearchRuntimeValidationMessage } from "@/lib/domain/searchRuntimeValidationMessages";
import type { HqPlace } from "@/lib/publish/hqFindings";
import type { FormSyntax } from "../../xpath/formSyntax";
import { withCandidate } from "../candidate";
import {
	appCodes,
	languageMap,
	sourceCode,
	sourceText,
	translatedTexts,
} from "../caseList/columns";
import {
	type Claim,
	defineClaims,
	derived,
	drop,
	refuse,
	take,
} from "../claims";
import type { DraftModule, ReadContext } from "../context";
import { externalKey } from "../identity";
import { isJsonObject, type JsonCursor } from "../jsonCursor";
import { pendingPlaceholder } from "../pendingExpressions";
import { readFormSyntax } from "../syntaxRead";
import { readGuardText } from "./guardSplit";
import { storedPrompts, withoutRuntimeGuard } from "./systemSentences";
import { searchPlace } from "./workflow";

const S = "case-search/";

export const PROMPT_CLAIMS = defineClaims("search.prompts", {
	order: take(`${S}prompt-order`, "schema:CaseSearch.properties"),
	name: take(
		`${S}name-prompt-key-case-property`,
		"schema:CaseSearchProperty.name",
	),
	nameOutside: refuse(
		`${S}prompt-key-outside-nova-s-name-grammar`,
		"schema:CaseSearchProperty.name",
	),
	nameReserved: refuse(
		`${S}a-prompt-that-reaches-hq-as-its-own-key-named-as-a-config-keys`,
		"schema:CaseSearchProperty.name",
	),
	nameShared: refuse(
		`${S}a-default-filter-and-a-search-property-sharing-one-name`,
		"schema:CaseSearchProperty.name",
	),
	nameAttribute: refuse(
		`${S}prompt-named-for-a-case-attribute-hq-matches-itself`,
		"schema:CaseSearchProperty.name",
	),
	ownerKey: take(`${S}a-search-key-named-owner-id`, "csql-key:owner_id"),
	label: take(`${S}label-lang`, "schema:CaseSearchProperty.label"),
	hint: take(`${S}hint-lang`, "schema:CaseSearchProperty.hint"),
	barcode: take(
		`${S}appearance-barcode-scan`,
		"schema:CaseSearchProperty.appearance",
	),
	address: refuse(
		`${S}appearance-address-geocoder-broadcast-emitted-input-address`,
		"schema:CaseSearchProperty.appearance",
	),
	addressRequired: refuse(
		`${S}appearance-address-with-required-or-validations`,
		"schema:CaseSearchProperty.appearance",
	),
	appearanceOther: drop(
		`${S}appearance-any-other-value`,
		"schema:CaseSearchProperty.appearance",
	),
	date: take(`${S}input-date`, "schema:CaseSearchProperty.input_"),
	dateBare: refuse(
		`${S}date-prompt-matched-by-hq-s-own-rule`,
		"schema:CaseSearchProperty.input_",
	),
	dateRange: take(`${S}input-daterange`, "schema:CaseSearchProperty.input_"),
	select1: take(
		`${S}input-select1-lookup-itemset`,
		"schema:CaseSearchProperty.input_",
	),
	select: take(
		`${S}input-select-multi-lookup-itemset`,
		"schema:CaseSearchProperty.input_",
	),
	itemset: take(
		`${S}input-select1-lookup-itemset`,
		"schema:CaseSearchProperty.itemset",
	),
	itemsetMulti: take(
		`${S}input-select-multi-lookup-itemset`,
		"schema:CaseSearchProperty.itemset",
	),
	reports: refuse(
		`${S}input-select1-select-commcare-reports-itemset-mobile-ucr`,
		"schema:CaseSearchProperty.input_",
	),
	checkbox: refuse(
		`${S}input-checkbox-itemset`,
		"schema:CaseSearchProperty.input_",
	),
	itemsetInstance: take(
		`${S}itemset-instance-id-item-list-tag-nodeset-label-value-over`,
		"schema:Itemset.instance_id",
	),
	itemsetNodeset: take(
		`${S}itemset-instance-id-item-list-tag-nodeset-label-value-over`,
		"schema:Itemset.nodeset",
	),
	itemsetLabel: take(
		`${S}itemset-instance-id-item-list-tag-nodeset-label-value-over`,
		"schema:Itemset.label",
	),
	itemsetValue: take(
		`${S}itemset-instance-id-item-list-tag-nodeset-label-value-over`,
		"schema:Itemset.value",
	),
	itemsetSort: take(
		`${S}itemset-sort-over-a-lookup-field`,
		"schema:Itemset.sort",
	),
	itemsetScheme: refuse(
		`${S}itemset-scheme-other-than-item-list-commcare-reports`,
		"schema:Itemset.instance_id",
	),
	itemsetRefs: refuse(
		`${S}itemset-refs-to-item-attributes-attr-or-property-qualified`,
		"schema:Itemset.label",
	),
	defaultOnRange: refuse(
		`${S}default-value-on-a-date-range-input`,
		"schema:CaseSearchProperty.default_value",
	),
	required: take(
		`${S}required-test-text`,
		"schema:CaseSearchProperty.required",
	),
	requiredText: take(`${S}required-test-text`, "schema:Assertion.text"),
	requiredAlways: take(`${S}required-test-text`, "schema:Assertion.test"),
	validation: take(
		`${S}validations-0-test-text`,
		"schema:CaseSearchProperty.validations",
	),
	validationText: take(`${S}validations-0-test-text`, "schema:Assertion.text"),
	validationGuard: derived(
		`${S}validations-0-test-text`,
		"schema:Assertion.test",
	),
	validationsLater: refuse(
		`${S}validations-1`,
		"schema:CaseSearchProperty.validations",
	),
	hiddenValue: take(
		`${S}hidden-exclude-with-a-default-value-on-a-prompt-with-no-itemset`,
		"schema:CaseSearchProperty.hidden",
	),
	hiddenExclude: take(
		`${S}hidden-exclude-with-a-default-value-on-a-prompt-with-no-itemset`,
		"schema:CaseSearchProperty.exclude",
	),
	hiddenNoDefault: refuse(
		`${S}hidden-exclude-without-a-default-value-on-a-prompt-with-no`,
		"schema:CaseSearchProperty.hidden",
	),
	hiddenNoExclude: refuse(
		`${S}hidden-without-exclude-on-a-prompt-with-no-itemset-input-type-or`,
		"schema:CaseSearchProperty.hidden",
	),
	hiddenWidget: refuse(
		`${S}hidden-on-a-prompt-that-carries-an-itemset-input-type-or`,
		"schema:CaseSearchProperty.hidden",
	),
	hiddenChecked: refuse(
		`${S}hidden-together-with-required-or-validations`,
		"schema:CaseSearchProperty.hidden",
	),
	exclude: take(`${S}exclude`, "schema:CaseSearchProperty.exclude"),
	allowBlank: refuse(
		`${S}allow-blank-value`,
		"schema:CaseSearchProperty.allow_blank_value",
	),
	receiver: refuse(
		`${S}receiver-expression`,
		"schema:CaseSearchProperty.receiver_expression",
	),
	receiverOther: refuse(
		`${S}receiver-expression-on-a-prompt-whose-editor-appearance-is`,
		"schema:CaseSearchProperty.receiver_expression",
	),
	group: refuse(`${S}is-group-group-key`, "schema:CaseSearchProperty.is_group"),
	groupMissing: refuse(
		`${S}groups-present-and-an-input-without-group-key`,
		"schema:CaseSearchProperty.group_key",
	),
});

const P = PROMPT_CLAIMS;

/** The keys a prompt reaches CommCare HQ under as a request setting of its own
 *  (`case_search/models.py`: `CONFIG_KEYS_MAPPING`, the tag key, the owner exclusion key and
 *  the query key). */
const RESERVED_REQUEST_KEYS = new Set([
	"case_type",
	"x_commcare_data_registry",
	"x_commcare_custom_related_case_property",
	"x_commcare_include_all_related_cases",
	"commcare_sort",
	"x_commcare_endpoint_id",
	"x_commcare_tag_module_name",
	"commcare_blacklisted_owner_ids",
	"_xpath_query",
]);

/** The case attributes a prompt can be named for, which HQ's search reads by its own rule. */
export const ATTRIBUTE_PROMPT_NAMES = new Set([
	"case_id",
	"owner_id",
	"status",
]);

/** One prompt as the pass read it, for the arms the settle decides. */
export interface PromptReading {
	readonly cursor: JsonCursor;
	readonly uuid: Uuid;
	readonly name: string;
	readonly type: Exclude<SearchInputDef, { kind: "hidden" }>["type"] | "hidden";
	readonly exclude: boolean;
	/** The registrations of the prompt's expressions. */
	readonly default?: number;
	readonly hiddenValue?: number;
	readonly requiredWhen?: number;
	readonly validationRule?: number;
	readonly optionsFilter?: number;
	/** The provisional entry written into the draft. */
	readonly input: SearchInputDef;
}

function parse(text: unknown): FormSyntax | undefined {
	if (typeof text !== "string") return undefined;
	const read = readFormSyntax(text);
	return read.ok ? read.node : undefined;
}

/** The one child name a label, value or sort ref reads: `name` or `./name`. */
function fieldName(text: unknown): string | undefined {
	const node = parse(text);
	if (node?.kind === "name" && !node.wildcard) return node.name;
	if (
		node?.kind === "child" &&
		node.left?.kind === "self" &&
		node.step.kind === "name" &&
		!node.step.wildcard
	)
		return node.step.name;
	return undefined;
}

/** An itemset's nodeset as `instance('item-list:<tag>')/<tag>_list/<tag>[filter]`: the tag and the
 *  filter's text, where it is that shape. */
function itemsetSource(
	text: unknown,
): { tag: string; filter?: string } | undefined {
	if (typeof text !== "string") return undefined;
	let node = parse(text);
	let filter: string | undefined;
	if (node?.kind === "filter") {
		filter = text.slice(node.where.from, node.where.to);
		node = node.base;
	}
	if (node?.kind !== "child" || node.step.kind !== "name") return undefined;
	const item = node.step.name;
	const list = node.left;
	if (
		list?.kind !== "child" ||
		list.step.kind !== "name" ||
		list.step.name !== `${item}_list`
	)
		return undefined;
	const root = list.left;
	if (
		root?.kind !== "call" ||
		root.name !== "instance" ||
		root.args.length !== 1
	)
		return undefined;
	const id = root.args[0];
	if (id?.kind !== "string" || id.value !== `item-list:${item}`)
		return undefined;
	return filter === undefined ? { tag: item } : { tag: item, filter };
}

/** Whether a prompt carries a widget: an itemset, an input type or an appearance. */
function carriesWidget(prompt: JsonCursor): boolean {
	return (
		prompt.used("itemset") || prompt.used("input_") || prompt.used("appearance")
	);
}

/**
 * Reads each prompt of a searching menu into a Search field at its provisional arm, and keeps
 * what the settle needs. A prompt that raised a finding has no reading.
 */
export function readSearchPrompts(
	ctx: ReadContext,
	module: DraftModule,
	config: JsonCursor,
	defaultFilterNames: ReadonlySet<string>,
): readonly PromptReading[] {
	const place = searchPlace(module);
	const prompts = config.list(
		"properties",
		"CaseSearchProperty",
		P.order,
		() => place,
	);
	const grouped = prompts.some(
		(prompt) => prompt.peek("is_group") === true || prompt.used("group_key"),
	);
	const out: PromptReading[] = [];
	for (const prompt of prompts) {
		const reading = readPrompt(
			ctx,
			module,
			prompt,
			place,
			defaultFilterNames,
			grouped,
		);
		if (reading !== undefined) out.push(reading);
	}
	return out;
}

function readPrompt(
	ctx: ReadContext,
	module: DraftModule,
	prompt: JsonCursor,
	place: HqPlace,
	defaultFilterNames: ReadonlySet<string>,
	grouped: boolean,
): PromptReading | undefined {
	const stored = prompt.peek("name");
	const name = typeof stored === "string" ? stored : "";
	const named = { name: name.slice(0, 200) };
	const refuseWith = (key: string, claim: Claim<"refuse">) => {
		prompt.refuse(key, claim, named);
		return undefined;
	};
	if (RESERVED_REQUEST_KEYS.has(name))
		return refuseWith("name", P.nameReserved);
	if (!SEARCH_INPUT_NAME_PATTERN.test(name))
		return refuseWith("name", P.nameOutside);
	if (defaultFilterNames.has(name)) return refuseWith("name", P.nameShared);
	if (prompt.peek("is_group") === true) return refuseWith("is_group", P.group);
	if (grouped && !prompt.used("group_key"))
		return refuseWith("group_key", P.groupMissing);
	if (prompt.used("allow_blank_value"))
		return refuseWith("allow_blank_value", P.allowBlank);
	if (prompt.used("receiver_expression"))
		return refuseWith(
			"receiver_expression",
			prompt.used("appearance") && prompt.peek("appearance") !== "barcode_scan"
				? P.receiverOther
				: P.receiver,
		);
	const hidden = prompt.peek("hidden") === true;
	const exclude = prompt.peek("exclude") === true;
	const checked = prompt.used("required") || prompt.used("validations");
	const appearance = prompt.peek("appearance");
	const input = prompt.peek("input_");
	if (appearance === "address")
		return refuseWith("appearance", checked ? P.addressRequired : P.address);
	if (hidden) {
		if (checked) return refuseWith("hidden", P.hiddenChecked);
		if (carriesWidget(prompt)) return refuseWith("hidden", P.hiddenWidget);
		if (!exclude) return refuseWith("hidden", P.hiddenNoExclude);
		if (!prompt.used("default_value"))
			return refuseWith("hidden", P.hiddenNoDefault);
	}
	const validations = prompt.peek("validations");
	if (Array.isArray(validations) && validations.length > 1)
		return refuseWith("validations", P.validationsLater);

	let type: PromptReading["type"] = hidden ? "hidden" : "text";
	let options: SearchInputLookupOptions | undefined;
	let optionsFilterText: string | undefined;
	let itemsetCursor: JsonCursor | undefined;
	if (!hidden) {
		if (input === "date") {
			if (!exclude) return refuseWith("input_", P.dateBare);
			prompt.take("input_", P.date, String).value;
			type = "date";
		} else if (input === "daterange") {
			prompt.take("input_", P.dateRange, String).value;
			type = "date-range";
		} else if (input === "checkbox") return refuseWith("input_", P.checkbox);
		else if (input === "select1" || input === "select") {
			const itemset = prompt.peek("itemset");
			const instance = isJsonObject(itemset) ? itemset.instance_id : undefined;
			if (
				typeof instance === "string" &&
				instance.startsWith("commcare-reports:")
			)
				return refuseWith("input_", P.reports);
			const source = isJsonObject(itemset)
				? itemsetSource(itemset.nodeset)
				: undefined;
			if (source === undefined || instance !== `item-list:${source.tag}`) {
				const cursor = prompt.object(
					"itemset",
					"Itemset",
					input === "select1" ? P.itemset : P.itemsetMulti,
				);
				cursor.refuse("instance_id", P.itemsetScheme, named);
				return undefined;
			}
			const label = fieldName(
				isJsonObject(itemset) ? itemset.label : undefined,
			);
			const value = fieldName(
				isJsonObject(itemset) ? itemset.value : undefined,
			);
			const sortText = isJsonObject(itemset) ? itemset.sort : undefined;
			const sort =
				typeof sortText === "string" && sortText !== ""
					? fieldName(sortText)
					: undefined;
			const cursor = prompt.object(
				"itemset",
				"Itemset",
				input === "select1" ? P.itemset : P.itemsetMulti,
			);
			if (
				label === undefined ||
				value === undefined ||
				(typeof sortText === "string" && sortText !== "" && sort === undefined)
			) {
				cursor.refuse("label", P.itemsetRefs, named);
				return undefined;
			}
			const table = ctx.input.lookup.table(source.tag);
			if (table === undefined) {
				cursor.handOff("instance_id", "lookup-table-read", source.tag);
				ctx.facts.unreadTables.push({ tag: source.tag, place });
				return undefined;
			}
			const valueColumn = table.column(value);
			const labelColumn = table.column(label);
			const sortColumn = sort === undefined ? undefined : table.column(sort);
			if (
				valueColumn === undefined ||
				labelColumn === undefined ||
				(sort !== undefined && sortColumn === undefined)
			) {
				ctx.accounting.circumstance("unrecognized", place, {
					name: "schema:Itemset.value",
				});
				return undefined;
			}
			prompt.take("input_", input === "select1" ? P.select1 : P.select, String)
				.value;
			itemsetCursor = cursor;
			cursor.take("instance_id", P.itemsetInstance, String).value;
			// A filter's claim on the nodeset is the expression stage's, by the registration below.
			if (source.filter === undefined)
				cursor.take("nodeset", P.itemsetNodeset, String).value;
			cursor.take("label", P.itemsetLabel, String).value;
			cursor.take("value", P.itemsetValue, String).value;
			if (sortColumn !== undefined)
				cursor.take("sort", P.itemsetSort, String).value;
			type = input === "select1" ? "select" : "multi-select";
			options = {
				kind: "lookup",
				tableId: table.tableId as LookupTableId,
				valueColumnId: valueColumn as LookupColumnId,
				labelColumnId: labelColumn as LookupColumnId,
				// The label column is the order a field with no sort column of its own prints
				// (`searchInputLookupSortColumnId`), and a document holds that order as no sort column
				// (`withCanonicalSearchInputOptions`).
				...(sortColumn !== undefined &&
					sortColumn !== labelColumn && {
						sortColumnId: sortColumn as LookupColumnId,
					}),
			};
			optionsFilterText = source.filter;
			if (optionsFilterText !== undefined && options !== undefined)
				options.filter = pendingPlaceholder("condition");
		} else if (input !== undefined && input !== null && input !== "") {
			ctx.accounting.circumstance("unrecognized", place, {
				name: "schema:CaseSearchProperty.input_",
			});
			return undefined;
		}
		if (appearance === "barcode_scan" && type === "text") {
			prompt.take("appearance", P.barcode, String).value;
			type = "barcode";
		} else if (typeof appearance === "string" && appearance !== "")
			prompt.drop("appearance", P.appearanceOther);
		if (!exclude && ATTRIBUTE_PROMPT_NAMES.has(name))
			return refuseWith("name", P.nameAttribute);
	}
	if (type === "date-range" && prompt.used("default_value"))
		return refuseWith("default_value", P.defaultOnRange);

	const uuid = ctx.accounting.identity(
		ctx.resolver.claim(
			externalKey.searchInput(module.uniqueId, name),
			`${module.uniqueId}/search/${name}`,
		),
		place,
		"schema:CaseSearchProperty.name",
	);
	if (uuid === undefined) return undefined;
	prompt.take("name", P.name, String).value;
	if (name === "owner_id" && exclude)
		ctx.accounting.claimEntry(
			{ json: prompt, key: "name" },
			P.ownerKey.entry,
			"csql-key:owner_id",
			place,
		);
	if (exclude && hidden) prompt.take("exclude", P.hiddenExclude, Boolean).value;
	else if (exclude) prompt.take("exclude", P.exclude, Boolean).value;
	if (hidden) prompt.take("hidden", P.hiddenValue, Boolean).value;

	const label = prompt.take("label", P.label, languageMap).value;
	const hintMap = prompt.take("hint", P.hint, languageMap).value;
	const register = (
		slot:
			| "search_input_default"
			| "search_input_required_when"
			| "search_input_validation_rule"
			| "search_input_options"
			| "search_input_hidden_value",
		text: string,
		at: { json: JsonCursor; key: string },
		interpolation: "none" | "no-case" | "no-dots",
		key: string,
	) =>
		ctx.pending.register(
			{
				ref: {
					entity: "module",
					uuid: module.uuid,
					slot,
					member: { searchInputUuid: uuid },
				},
				text,
				mode: { target: "hq-json", interpolation },
				place,
				key,
			},
			at,
		);
	const defaultText = prompt.peek("default_value");
	const hasDefault =
		typeof defaultText === "string" && defaultText.trim() !== "";
	const defaultIndex = hasDefault
		? register(
				hidden ? "search_input_hidden_value" : "search_input_default",
				defaultText,
				{ json: prompt, key: "default_value" },
				"none",
				"schema:CaseSearchProperty.default_value",
			)
		: undefined;
	let requiredWhen: number | undefined;
	let required: { message?: string } | undefined;
	if (prompt.used("required")) {
		const assertion = prompt.object("required", "Assertion", P.required);
		const test = assertion.peek("test");
		const text = assertion.take("text", P.requiredText, languageMap).value;
		required = {};
		if (
			typeof test !== "string" ||
			test.trim() === "" ||
			test.trim() === "true()"
		)
			assertion.take("test", P.requiredAlways, String).value;
		else
			requiredWhen = register(
				"search_input_required_when",
				test,
				{ json: assertion, key: "test" },
				"no-case",
				"schema:Assertion.test",
			);
		const message = sourceText(ctx, text);
		const nova = requiredDefaultTexts(ctx);
		const novaSentence =
			nova !== undefined &&
			appCodes(ctx).every((code) => (text[code] ?? "") === nova.get(code));
		if (!novaSentence) {
			required.message = message;
			ctx.translations.set(
				makeTranslationUnitId("search-input", uuid, "required-message"),
				"text",
				translatedTexts(ctx, text),
			);
		}
	}
	let validationRule: number | undefined;
	let validationMessage: string | undefined;
	const validationList = prompt.list("validations", "Assertion", P.validation);
	const first = validationList[0];
	if (first !== undefined) {
		const test = first.peek("test");
		const text = first.take("text", P.validationText, languageMap).value;
		const authored = withoutRuntimeGuard(
			test,
			sourceFirst(ctx).map((code) => text[code] ?? ""),
		);
		const guarded =
			authored.kind === "whole"
				? undefined
				: guardTexts(ctx).get(authored.guard.key);
		if (authored.kind === "guard") first.derived("test", P.validationGuard);
		else {
			const rule = authored.kind === "split" ? authored.rule : test;
			if (typeof rule === "string" && rule.trim() !== "")
				validationRule = register(
					"search_input_validation_rule",
					rule,
					{ json: first, key: "test" },
					"no-dots",
					"schema:Assertion.test",
				);
			const messages =
				authored.kind === "split"
					? Object.fromEntries(
							Object.entries(text).map(([code, one]) => [
								code,
								withoutSuffix(
									one,
									` ${guarded?.get(code) ?? authored.guard.message}`,
								),
							]),
						)
					: text;
			validationMessage = sourceText(ctx, messages);
			ctx.translations.set(
				makeTranslationUnitId("search-input", uuid, "validation-message"),
				"text",
				translatedTexts(ctx, messages),
			);
		}
	}
	const optionsFilter =
		optionsFilterText === undefined || itemsetCursor === undefined
			? undefined
			: register(
					"search_input_options",
					optionsFilterText,
					{ json: itemsetCursor, key: "nodeset" },
					"none",
					"schema:Itemset.nodeset",
				);

	ctx.translations.set(
		makeTranslationUnitId("search-input", uuid, "label"),
		"text",
		translatedTexts(ctx, label),
	);
	const hint = sourceText(ctx, hintMap);
	if (hint !== "")
		ctx.translations.set(
			makeTranslationUnitId("search-input", uuid, "hint"),
			"text",
			translatedTexts(ctx, hintMap),
		);

	const common = {
		uuid,
		name,
		label: sourceText(ctx, label),
		...(hint !== "" && { hint }),
		...(required !== undefined && {
			required: {
				...(requiredWhen !== undefined && {
					when: pendingPlaceholder("condition"),
				}),
				...(required.message !== undefined && { message: required.message }),
			},
		}),
		...(validationRule !== undefined && {
			validation: {
				rule: pendingPlaceholder("condition"),
				message: validationMessage ?? "",
			},
		}),
	};
	let entry: SearchInputDef;
	if (type === "hidden")
		entry = {
			uuid,
			name,
			label: common.label,
			kind: "hidden",
			value: pendingPlaceholder("value"),
		};
	else {
		const widget = {
			...common,
			type,
			...(options !== undefined && { options }),
			...(defaultIndex !== undefined &&
				type !== "date-range" && { default: pendingPlaceholder("value") }),
		};
		entry = (
			exclude
				? {
						...widget,
						kind: "advanced",
						predicate: pendingPlaceholder("condition"),
					}
				: {
						...widget,
						kind: "simple",
						property: name,
						...(type === "date-range" && { mode: { kind: "range" } }),
					}
		) as SearchInputDef;
	}
	return {
		cursor: prompt,
		uuid,
		name,
		type,
		exclude,
		...(defaultIndex !== undefined &&
			(hidden ? { hiddenValue: defaultIndex } : { default: defaultIndex })),
		...(requiredWhen !== undefined && { requiredWhen }),
		...(validationRule !== undefined && { validationRule }),
		...(optionsFilter !== undefined && { optionsFilter }),
		input: entry,
	};
}

/** The app's language codes, the reading's source first and the rest in the app's order: the
 *  order a stored text is read in, since the source language holds Nova's own sentences. */
function sourceFirst(ctx: ReadContext): readonly string[] {
	const source = sourceCode(ctx);
	const codes = appCodes(ctx);
	return source === undefined
		? codes
		: [source, ...codes.filter((code) => code !== source)];
}

/** Each runtime guard's text in each of the app's languages, by the guard's key, per reading. */
const GUARD_TEXTS = new WeakMap<
	ReadContext,
	ReadonlyMap<string, ReadonlyMap<string, string>>
>();

/**
 * Each runtime guard's text in each language, read over every Search field of the app: the
 * guard's message is one translation unit of the app (`system/search-validation/<key>`), joined
 * after each field's own message (`searchPrompts.ts::buildValidation`). In the reading's source
 * language the unit's text is its source, the catalog sentence, whatever the stored texts say: a
 * document holds no other text there, and a field whose stored text does not end with it keeps
 * its whole text, which the menu's projection then does not print back. The source is a
 * language that holds Nova's sentence wherever another does (`languages.ts::readingSourceCode`),
 * which may be other than the first. In any other language the text is `guardSplit.ts::readGuardText`'s: a
 * text that is the guard alone as it stands; else, where every text that joins it ends with the
 * source sentence, untranslated; else the longest text after a space that every joined text of
 * that language ends with and that leaves each field a message of its own. The stored bytes are
 * the join alone, so the last is the reading's choice of where one field's message ends, which
 * the canonical choice `joined-search-guards-split-as-read` makes of a Nova-born document; the
 * whole menu's projection holds every choice. Each text read is written as the unit's
 * translation.
 */
function guardTexts(
	ctx: ReadContext,
): ReadonlyMap<string, ReadonlyMap<string, string>> {
	const cached = GUARD_TEXTS.get(ctx);
	if (cached !== undefined) return cached;
	const codes = appCodes(ctx);
	const ordered = sourceFirst(ctx);
	const entries = new Map<string, SearchRuntimeValidationMessage>();
	const alone = new Map<string, Map<string, string>>();
	const joined = new Map<string, Map<string, string[]>>();
	for (const prompt of storedPrompts(ctx.app.peek("modules"))) {
		const first = Array.isArray(prompt.validations)
			? prompt.validations[0]
			: undefined;
		if (!isJsonObject(first)) continue;
		const text = languageMap(first.text);
		const reading = withoutRuntimeGuard(
			first.test,
			ordered.map((code) => text[code] ?? ""),
		);
		if (reading.kind === "whole") continue;
		const key = reading.guard.key;
		entries.set(key, reading.guard);
		for (const code of codes) {
			const one = text[code] ?? "";
			if (reading.kind === "guard") {
				const byCode = alone.get(key) ?? new Map<string, string>();
				alone.set(key, byCode);
				if (!byCode.has(code)) byCode.set(code, one);
			} else {
				const byCode = joined.get(key) ?? new Map<string, string[]>();
				joined.set(key, byCode);
				byCode.set(code, [...(byCode.get(code) ?? []), one]);
			}
		}
	}
	const out = new Map<string, ReadonlyMap<string, string>>();
	const source = sourceCode(ctx);
	for (const [key, entry] of entries) {
		const byCode = new Map<string, string>();
		for (const code of codes) {
			const given = alone.get(key)?.get(code);
			const texts = joined.get(key)?.get(code) ?? [];
			const read =
				code === source
					? entry.message
					: readGuardText(entry.message, given, texts);
			if (read !== undefined) byCode.set(code, read);
		}
		out.set(key, byCode);
		ctx.translations.set(
			makeTranslationUnitId("system", "search-validation", key),
			"text",
			translatedTexts(ctx, Object.fromEntries(byCode)),
		);
	}
	GUARD_TEXTS.set(ctx, out);
	return out;
}

/** The required message's text in each language, per reading (`requiredDefaultTexts`). */
const REQUIRED_TEXTS = new WeakMap<
	ReadContext,
	ReadonlyMap<string, string> | null
>();

/**
 * The text of Nova's message for a required field with none of its own, in each language, read
 * over every Search field of the app: the message is one translation unit of the app
 * (`system/search-required/default`), printed whole by each such field. In the reading's source
 * language it is the catalog sentence; in every other language it is the text there of the first
 * required field, in menu and prompt order, whose source text is that sentence. A field whose
 * text is this one in every language holds no message of its own; any other keeps its text as
 * its message, which prints the same bytes. Each text read is written as the unit's translation.
 * Undefined where no required field's source text is the sentence.
 */
function requiredDefaultTexts(
	ctx: ReadContext,
): ReadonlyMap<string, string> | undefined {
	const cached = REQUIRED_TEXTS.get(ctx);
	if (cached !== undefined) return cached ?? undefined;
	const source = sourceCode(ctx);
	const carrier =
		source === undefined
			? undefined
			: storedPrompts(ctx.app.peek("modules"))
					.map((prompt) =>
						isJsonObject(prompt.required)
							? languageMap(prompt.required.text)
							: undefined,
					)
					.find(
						(text) => text?.[source] === SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
					);
	if (carrier === undefined) {
		REQUIRED_TEXTS.set(ctx, null);
		return undefined;
	}
	const out = new Map(
		appCodes(ctx).map((code) => [code, carrier[code] ?? ""] as const),
	);
	REQUIRED_TEXTS.set(ctx, out);
	ctx.translations.set(
		makeTranslationUnitId("system", "search-required", "default"),
		"text",
		translatedTexts(ctx, Object.fromEntries(out)),
	);
	return out;
}

function withoutSuffix(text: string, suffix: string): string {
	return text.endsWith(suffix)
		? text.slice(0, text.length - suffix.length)
		: text;
}

/** Whether `input` is a simple Search field that names, as its mode, the mode its widget takes
 *  when it names none. */
function namesItsDefaultMode(input: SearchInputDef): boolean {
	return (
		input.kind === "simple" &&
		input.type !== "date-range" &&
		input.mode !== undefined &&
		input.mode.kind === DEFAULT_SEARCH_MODE_KIND[input.type]
	);
}

/**
 * The reader's canonical choice `exact-search-mode-is-absent`: a simple Search field whose mode
 * is the one its widget takes when it names none (exact matching, for a text, date, barcode or
 * choice widget), and the same field naming no mode. Every print reads the mode through the
 * widget's default (`modules.ts::effectiveSimpleSearchModeKind`), so both print one source, and
 * the reader proposes no mode first (`rows.ts`), so it returns the field with none. A date range
 * field's mode is required and is not changed.
 */
export function exactSearchModeIsAbsent(doc: BlueprintDoc): BlueprintDoc {
	const named = doc.moduleOrder.some((uuid) =>
		doc.modules[uuid]?.caseListConfig?.searchInputs.some(namesItsDefaultMode),
	);
	if (!named) return doc;
	return withCandidate(doc, (draft) => {
		for (const module of Object.values(draft.modules))
			for (const input of module.caseListConfig?.searchInputs ?? [])
				if (namesItsDefaultMode(input))
					delete (input as { mode?: unknown }).mode;
	});
}
