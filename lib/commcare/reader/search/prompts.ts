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
import { authoredCasePropertyNameSchema } from "@/lib/domain/casePropertyName";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import {
	DEFAULT_SEARCH_MODE_KIND,
	SEARCH_INPUT_NAME_PATTERN,
	SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
	type SearchInputLookupOptions,
} from "@/lib/domain/modules";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import type { SearchRuntimeValidationMessage } from "@/lib/domain/searchRuntimeValidationMessages";
import type { TranslationUnitRole } from "@/lib/domain/translationUnits";
import {
	circumstanceFinding,
	type Finding,
	type HqPlace,
} from "@/lib/publish/hqFindings";
import { isProjectSearchParameter } from "../../hq/projectSearch";
import { isReservedSearchInputName } from "../../suite/case-search/reservedInputNames";
import type { FormSyntax } from "../../xpath/formSyntax";
import { withCandidate } from "../candidate";
import {
	appCodes,
	type HeldTexts,
	heldTextsIn,
	languageMap,
	shownTexts,
	sourceCode,
	sourceText,
	translatedTexts,
	unheldTextsIn,
} from "../caseList/columns";
import { sameState } from "../caseList/details";
import {
	type Claim,
	defineClaims,
	derived,
	drop,
	refuse,
	take,
} from "../claims";
import type { DraftModule, ReadContext } from "../context";
import {
	holdText,
	recordTextRewrite,
	type UnheldText,
	unheldRefusal,
} from "../heldText";
import { externalKey } from "../identity";
import { isJsonObject, type JsonCursor } from "../jsonCursor";
import { manifestFindingOf } from "../languages";
import { pendingPlaceholder } from "../pendingExpressions";
import { readFormSyntax } from "../syntaxRead";
import { readGuardText } from "./guardSplit";
import { BLANK_IS_ABSENT, spelledAsShown } from "./settings";
import { storedPrompts, withoutRuntimeGuard } from "./systemSentences";
import { searchPlace } from "./workflow";

const S = "case-search/";

/** The entry a required or validation test with no message in any language is refused under. */
const NO_MESSAGE = `${S}a-required-or-validation-test-with-no-message-in-any-language`;

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
	/** A hint on a hidden prompt, which no runtime shows (`readPrompt`). */
	hiddenHint: drop(
		`${S}hint-on-a-hidden-prompt`,
		"schema:CaseSearchProperty.hint",
	),
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
	/** `appearance: address` beside an `input_` of `date`, `daterange` or `checkbox`, which HQ's
	 *  build writes over it (`readPrompt`). */
	addressUnderInput: drop(
		`${S}appearance-address-beside-an-input-hq-s-build-writes-over-it`,
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
	itemsetElsewhere: refuse(
		`${S}itemset-without-the-item-list-its-instance-id-names`,
		"schema:Itemset.nodeset",
	),
	/** A label, value or sort ref naming a column the told table lacks: a read of what is not
	 *  there, which a device reads blank for every choice. */
	itemsetColumn: refuse(
		"expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant",
		null,
	),
	/** No `input_`, HQ's own default (`CaseSearchProperty.input_` is `None`, which its source read
	 *  leaves out): a plain text field. */
	text: take(`${S}text-prompt-no-input`, "schema:CaseSearchProperty.input_"),
	inputUnnamed: refuse(
		`${S}input-no-runtime-names`,
		"schema:CaseSearchProperty.input_",
	),
	/** `input_: address`, which HQ's build writes as the prompt's `input` as it does an address
	 *  appearance (`remote_requests.py::build_query_prompts`). */
	inputAddress: refuse(
		`${S}appearance-address-geocoder-broadcast-emitted-input-address`,
		"parser:QueryPromptParser/prompt@input",
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
	blankReceiver: drop(
		BLANK_IS_ABSENT,
		"schema:CaseSearchProperty.receiver_expression",
	),
	blankDefault: drop(
		BLANK_IS_ABSENT,
		"schema:CaseSearchProperty.default_value",
	),
	blankInput: drop(BLANK_IS_ABSENT, "schema:CaseSearchProperty.input_"),
	blankAppearance: drop(
		BLANK_IS_ABSENT,
		"schema:CaseSearchProperty.appearance",
	),
	blankRequiredTest: drop(
		BLANK_IS_ABSENT,
		"schema:CaseSearchProperty.required",
	),
	requiredNoMessage: refuse(NO_MESSAGE, "schema:CaseSearchProperty.required"),
	validationNoMessage: refuse(
		NO_MESSAGE,
		"schema:CaseSearchProperty.validations",
	),
	group: refuse(`${S}is-group-group-key`, "schema:CaseSearchProperty.is_group"),
	groupMissing: refuse(
		`${S}groups-present-and-an-input-without-group-key`,
		"schema:CaseSearchProperty.group_key",
	),
	/** A member's `group_key` beside groups: the group's own finding (`readPrompt`). */
	groupKey: refuse(
		`${S}is-group-group-key`,
		"schema:CaseSearchProperty.group_key",
	),
});

const P = PROMPT_CLAIMS;

/** The case attributes a prompt can be named for, and the case's name, which HQ's search reads
 *  by its own rule (`case_search/const.py::INDEXED_METADATA_BY_KEY`: `@case_id`, `@owner_id`,
 *  `@status`, and `name`, the case's name, which Nova names `case_name`). */
export const ATTRIBUTE_PROMPT_NAMES = new Set([
	"case_id",
	"owner_id",
	"status",
	"name",
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
	/** By language code, the whole text Nova prints for the field's validation as the reading
	 *  holds the stored one (`readValidation`): its message, held as every app string is, with
	 *  the guard's text joined after it. The settle compares the projection's with it. */
	readonly validationText?: Readonly<Record<string, string>>;
	/** The provisional entry written into the draft. */
	readonly input: SearchInputDef;
	/** Whether a finding stands for the prompt, or project data's rules settle a read of it
	 *  (`unreadTables`): the field is in the provisional document for the expressions that read
	 *  it, and keeps its search out of the settle. */
	readonly refused: boolean;
	/** The tag of the lookup table the field's choices come from, where the reading was not told
	 *  of the table: the search waits on project data's read of it. */
	readonly unreadTable?: string;
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

/**
 * The appearance HQ's Case List page shows for a prompt (`case_claim.js::_getAppearance`): the
 * stored `appearance`, or none; a selection's lookup or Mobile UCR choice over it; `address` where
 * the stored appearance is; and the input type over all of them where it is a date, a date range
 * or a checkbox.
 */
function editorAppearance(prompt: JsonCursor): string {
	const stored = prompt.peek("appearance");
	let appearance = typeof stored === "string" ? stored : "";
	const input = prompt.peek("input_");
	if (input === "select1" || input === "select") {
		const itemset = prompt.peek("itemset");
		const instanceId = isJsonObject(itemset) ? itemset.instance_id : undefined;
		appearance =
			typeof instanceId === "string" && instanceId.includes("commcare-reports")
				? "report_fixture"
				: "lookup_table_fixture";
	}
	if (stored === "address") appearance = "address";
	if (input === "date" || input === "daterange" || input === "checkbox")
		appearance = input;
	return appearance;
}

/** The appearances HQ's Case List page shows that take no value another screen sends a prompt:
 *  every one but a plain text field and a lookup or Mobile UCR selection. */
const RECEIVER_REFUSED_APPEARANCES = new Set([
	"barcode_scan",
	"address",
	"date",
	"daterange",
	"checkbox",
]);

/** Whether a prompt carries a widget: an itemset, an input type or an appearance, a blank input
 *  type or appearance being none (`readPrompt`). */
function carriesWidget(prompt: JsonCursor): boolean {
	const holds = (key: string) => prompt.used(key) && prompt.peek(key) !== "";
	return prompt.used("itemset") || holds("input_") || holds("appearance");
}

/**
 * Reads each prompt of a searching menu into a Search field at its provisional arm, and keeps
 * what the settle needs. A prompt that raised a finding is read as far as the finding leaves it
 * (`PromptReading.refused`); a group's own entry, which is no field, has no reading.
 */
export function readSearchPrompts(
	ctx: ReadContext,
	module: DraftModule,
	config: JsonCursor,
	defaultFilterNames: ReadonlyMap<string, readonly string[]>,
	projectService = false,
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
			projectService,
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
	defaultFilterNames: ReadonlyMap<string, readonly string[]>,
	grouped: boolean,
	projectService: boolean,
): PromptReading | undefined {
	const stored = prompt.peek("name");
	const name = typeof stored === "string" ? stored : "";
	const named = { name: name };
	// A group's own entry is no field: HQ's build makes it a group of the search screen
	// (`remote_requests.py::build_query_prompt_groups`), which Nova holds no slot for. It is one
	// finding, naming the group's key, as each member's `group_key` names it, and covers every key
	// the entry holds.
	if (prompt.peek("is_group") === true) {
		const groupKey = prompt.peek("group_key");
		prompt.refuseWhole(P.group, {
			name: typeof groupKey === "string" ? groupKey : name,
		});
		return undefined;
	}
	// Each refusal is the one finding for its cause, at the key that holds it, and the reading
	// goes on: every other key of the prompt is read as it would be, or, where the refusal leaves
	// nothing to read it into, stands under that finding (`cover`), so the close names none of
	// them. A refused prompt is still a field of the provisional document (`PromptReading.refused`),
	// so the expressions of the other fields that read it bind; it keeps the search out of the
	// settle.
	const claimed = new Set<string>();
	const site = (at: JsonCursor, key: string) => `${at.pointer}\u0000${key}`;
	let refused = false;
	let unreadTable: string | undefined;
	const refuseWith = (
		key: string,
		claim: Claim<"refuse">,
		at: JsonCursor = prompt,
		detail: { readonly name: string; readonly reason?: string } = named,
	): Finding => {
		if (at.used(key)) {
			at.refuse(key, claim, detail);
			claimed.add(site(at, key));
		} else ctx.accounting.finding(claim, place, detail);
		refused = true;
		return manifestFindingOf(claim, place, detail);
	};
	const unrecognizedAt = (surfaceKey: string): Finding => {
		const detail = { name: surfaceKey };
		ctx.accounting.circumstance("unrecognized", place, detail);
		refused = true;
		return circumstanceFinding("unrecognized", place, detail);
	};
	const cover = (at: JsonCursor, keys: readonly string[], by: Finding) => {
		for (const key of keys)
			if (at.used(key) && !claimed.has(site(at, key))) {
				ctx.accounting.cover({ json: at, key }, by);
				claimed.add(site(at, key));
			}
	};
	const refusedHere = (key: string) => claimed.has(site(prompt, key));
	// A blank `""` is the key absent: HQ's Case List page writes `receiver_expression: ""` for
	// every plain or lookup prompt and `default_value` for a multi-select one on each save
	// (`views/modules.py::_update_search_properties`), and HQ's build and Web Apps read each only
	// where it holds text (`remote_requests.py`: `if prop.default_value`; `query.js`, `receive`).
	// A blank `input_` or `appearance` is no widget: HQ's build writes neither where it is blank
	// (`remote_requests.py::build_query_prompts`: `if prop.input_`, `if prop.appearance`), so both
	// runtimes show a plain text field, and HQ's Case List page reads a plain text field
	// (`case_claim.js::_getAppearance`), whose save writes neither.
	// A `required` whose test is blank is no requirement, whatever its text: HQ's build writes no
	// `<required>` and no text for it (`remote_requests.py`, `app_strings.py`:
	// `if prop.required.test`).
	const storedRequired = prompt.peek("required");
	const requiredTest = isJsonObject(storedRequired)
		? storedRequired.test
		: undefined;
	const requires =
		prompt.used("required") &&
		requiredTest !== null &&
		requiredTest !== undefined &&
		requiredTest !== "";
	for (const [key, claim, blank] of [
		[
			"receiver_expression",
			P.blankReceiver,
			prompt.peek("receiver_expression") === "",
		],
		["default_value", P.blankDefault, prompt.peek("default_value") === ""],
		["input_", P.blankInput, prompt.peek("input_") === ""],
		["appearance", P.blankAppearance, prompt.peek("appearance") === ""],
		["required", P.blankRequiredTest, prompt.used("required") && !requires],
	] as const)
		if (blank && prompt.used(key)) {
			prompt.drop(key, claim);
			claimed.add(site(prompt, key));
			sameState(
				ctx,
				claim.entry,
				`${prompt.pointer}/${key}`,
				"list-settings-respelled",
			);
		}
	const holds = (
		key: "receiver_expression" | "default_value" | "input_" | "appearance",
	) => prompt.used(key) && prompt.peek(key) !== "";
	// Each text as HQ's build shows it in each app language (`app_strings.py`, `clean_trans` of
	// the map): a language the map lacks, or holds blank, shows another language's text.
	// Each is held as every app string is (`caseList/columns.ts::heldTextsIn`): no space at
	// either end, and a label or message blank-looking in a language beside the source's text
	// takes the source's text there.
	//
	// A text Nova's gate admits no spelling of is one finding, at its own key (`claimText`), and
	// the prompt is still read over each language's text as HQ's build shows it, so the field
	// stays in the provisional document for every expression that reads it and nothing else the
	// prompt holds is reported for that text.
	const codes = appCodes(ctx);
	const readText = (stored: unknown, role: TranslationUnitRole): PromptText =>
		promptText(ctx, stored, codes, role);
	const labelRead = readText(prompt.peek("label"), "search-input-label");
	const hintRead = readText(prompt.peek("hint"), "search-input-hint");
	const requiredRead: PromptText = requires
		? readText(
				isJsonObject(storedRequired) ? storedRequired.text : undefined,
				"search-input-required-message",
			)
		: {
				held: { texts: NO_ENTRIES, workersSeeAnother: false },
				texts: NO_ENTRIES,
			};
	const label = labelRead.texts;
	const hintMap = hintRead.texts;
	const requiredMap = requiredRead.texts;
	// A key CommCare HQ reads as part of the request (a setting, a tag, an unsearched key, an
	// owner, project space or reverse-index filter, CSQL) never searches the property it names.
	if (
		projectService
			? !isProjectSearchParameter(name)
			: isReservedSearchInputName(name)
	)
		refuseWith("name", P.nameReserved);
	else if (!SEARCH_INPUT_NAME_PATTERN.test(name))
		refuseWith("name", P.nameOutside);
	else if (defaultFilterNames.has(name)) {
		refuseWith("name", P.nameShared);
		// The name is a class of each default filter that shares it too, so the refusal stands at
		// each one's `property`.
		for (const pointer of defaultFilterNames.get(name) ?? [])
			ctx.accounting.findingAt(P.nameShared, place, pointer, named);
	}
	// Beside a group, a member's `group_key` names its group, whose own entry's finding it is; a
	// member with none is a finding of its own.
	if (grouped) {
		const groupKey = prompt.peek("group_key");
		if (prompt.used("group_key"))
			refuseWith("group_key", P.groupKey, prompt, {
				name: String(groupKey),
			});
		else refuseWith("group_key", P.groupMissing);
	}
	if (prompt.used("allow_blank_value"))
		refuseWith("allow_blank_value", P.allowBlank);
	if (holds("receiver_expression"))
		refuseWith(
			"receiver_expression",
			RECEIVER_REFUSED_APPEARANCES.has(editorAppearance(prompt))
				? P.receiverOther
				: P.receiver,
		);
	const hidden = prompt.peek("hidden") === true;
	const exclude = prompt.peek("exclude") === true;
	const checked = requires || prompt.used("validations");
	const appearance = prompt.peek("appearance");
	const input = prompt.peek("input_");
	// HQ's build writes a stored `input_` over the `input="address"` an address appearance gives
	// the prompt, and writes no `appearance` for it (`remote_requests.py::build_query_prompts`), and
	// HQ's Case List page shows a date, date range or checkbox input over an address appearance
	// (`case_claim.js::_getAppearance` tests those last): beside one of the three, no runtime and no
	// page of HQ's shows an address field, and the appearance is read as nothing.
	const inputOverAddress =
		input === "date" || input === "daterange" || input === "checkbox";
	// A hidden prompt Nova cannot hold is read as a Hidden Value, and each key whose meaning the
	// refusal names (its checks, its widget, `exclude`) stands under the refusal's finding.
	let hiddenRefused = false;
	let addressRefused: Finding | undefined;
	if (hidden) {
		const claim = checked
			? P.hiddenChecked
			: carriesWidget(prompt)
				? P.hiddenWidget
				: !exclude && !projectService
					? P.hiddenNoExclude
					: !holds("default_value")
						? P.hiddenNoDefault
						: undefined;
		if (claim !== undefined) {
			hiddenRefused = true;
			cover(
				prompt,
				[
					"exclude",
					"input_",
					"itemset",
					"appearance",
					"validations",
					...(requires ? ["required"] : []),
				],
				refuseWith("hidden", claim),
			);
		}
	} else if (appearance === "address" && !inputOverAddress)
		addressRefused = refuseWith(
			"appearance",
			checked ? P.addressRequired : P.address,
		);
	const validations = prompt.peek("validations");
	// An address field's checks are the address finding's, which names them: HQ's Case List page
	// blanks every check of an address field on a save (`case_claim.js::_getProperties`).
	if (!hiddenRefused && Array.isArray(validations) && validations.length > 1) {
		if (addressRefused !== undefined)
			cover(prompt, ["validations"], addressRefused);
		else refuseWith("validations", P.validationsLater);
	}
	// A check whose message is blank in every language: HQ's build shows the runtime's own
	// sentence for a validation (`remote_requests.py` writes no text where `has_text` is false)
	// and a blank one for a requirement, and Nova holds no check without a message of its own.
	if (
		!hiddenRefused &&
		requires &&
		requiredRead.held !== undefined &&
		sourceText(ctx, requiredMap) === ""
	)
		refuseWith("required", P.requiredNoMessage);
	const storedValidation = Array.isArray(validations)
		? validations[0]
		: undefined;
	const validationRead = isJsonObject(storedValidation)
		? readText(storedValidation.text, "search-input-validation-message")
		: undefined;
	const validation = readValidation(
		ctx,
		storedValidation,
		validationRead?.texts ?? NO_ENTRIES,
	);
	if (
		!hiddenRefused &&
		!refusedHere("validations") &&
		validation?.kind === "checked" &&
		validation.rule !== undefined &&
		validationRead?.held !== undefined &&
		sourceText(ctx, validation.messages) === ""
	)
		refuseWith("validations", P.validationNoMessage);
	const readsRequired = requires && !hiddenRefused && !refusedHere("required");
	const readsValidation = !hiddenRefused && !refusedHere("validations");

	let type: PromptReading["type"] = hidden ? "hidden" : "text";
	let options: SearchInputLookupOptions | undefined;
	let optionsFilterText: string | undefined;
	let itemsetCursor: JsonCursor | undefined;
	if (!hidden) {
		if (input === "date") {
			if (!exclude) refuseWith("input_", P.dateBare);
			else prompt.take("input_", P.date, String).value;
			type = "date";
		} else if (input === "daterange") {
			prompt.take("input_", P.dateRange, String).value;
			type = "date-range";
		} else if (input === "checkbox")
			cover(prompt, ["itemset"], refuseWith("input_", P.checkbox));
		else if (input === "select1" || input === "select") {
			const itemset = prompt.peek("itemset");
			const instance = isJsonObject(itemset) ? itemset.instance_id : undefined;
			// The scheme HQ's build checks, where the itemset names an instance
			// (`helpers/validators.py::validate_search_config`: `instance_id.split(':', 1)[0]`).
			const scheme =
				typeof instance === "string" && instance !== ""
					? instance.split(":")[0]
					: undefined;
			const source = isJsonObject(itemset)
				? itemsetSource(itemset.nodeset)
				: undefined;
			const ITEMSET_KEYS = [
				"instance_id",
				"nodeset",
				"label",
				"value",
				"sort",
			] as const;
			if (scheme === "commcare-reports")
				cover(prompt, ["itemset"], refuseWith("input_", P.reports));
			else if (!isJsonObject(itemset))
				cover(
					prompt,
					["input_", "itemset"],
					unrecognizedAt("schema:CaseSearchProperty.itemset"),
				);
			else {
				const cursor = prompt.object(
					"itemset",
					"Itemset",
					input === "select1" ? P.itemset : P.itemsetMulti,
				);
				const label = fieldName(itemset.label);
				const value = fieldName(itemset.value);
				const sortText = itemset.sort;
				const sort =
					typeof sortText === "string" && sortText !== ""
						? fieldName(sortText)
						: undefined;
				const table =
					source === undefined ? undefined : ctx.input.lookup.table(source.tag);
				const valueColumn =
					value === undefined ? undefined : table?.column(value);
				const labelColumn =
					label === undefined ? undefined : table?.column(label);
				const sortColumn = sort === undefined ? undefined : table?.column(sort);
				if (scheme !== undefined && scheme !== "item-list") {
					// An instance of another scheme, which HQ's build refuses.
					const raised = refuseWith("instance_id", P.itemsetScheme, cursor);
					cover(cursor, ITEMSET_KEYS, raised);
					cover(prompt, ["input_"], raised);
				} else if (
					source === undefined ||
					instance !== `item-list:${source.tag}`
				) {
					// No instance named, or a lookup table's instance whose nodeset reads elsewhere
					// than its item list: HQ builds it, and Nova's choices are the table's item list.
					const raised = refuseWith("nodeset", P.itemsetElsewhere, cursor);
					cover(cursor, ITEMSET_KEYS, raised);
					cover(prompt, ["input_"], raised);
				} else if (
					label === undefined ||
					value === undefined ||
					(typeof sortText === "string" &&
						sortText !== "" &&
						sort === undefined)
				) {
					const raised = refuseWith("label", P.itemsetRefs, cursor);
					cover(cursor, ITEMSET_KEYS, raised);
					cover(prompt, ["input_"], raised);
				} else if (table === undefined) {
					// Project data's lookup table rules settle the read (`unreadTables`); the prompt's
					// other keys are what Nova holds of a field over a table.
					cursor.handOff("instance_id", "lookup-table-read", source.tag);
					ctx.facts.unreadTables.push({ tag: source.tag, place });
					unreadTable = source.tag;
					refused = true;
					prompt.take(
						"input_",
						input === "select1" ? P.select1 : P.select,
						String,
					).value;
					cursor.take("nodeset", P.itemsetNodeset, String).value;
					cursor.take("label", P.itemsetLabel, String).value;
					cursor.take("value", P.itemsetValue, String).value;
					cursor.take("sort", P.itemsetSort, String).value;
				} else if (
					valueColumn === undefined ||
					labelColumn === undefined ||
					(sort !== undefined && sortColumn === undefined)
				) {
					// A ref to a column the table lacks reads blank for every choice on a device; the
					// one finding stands at the first such ref.
					const raised = refuseWith(
						valueColumn === undefined
							? "value"
							: labelColumn === undefined
								? "label"
								: "sort",
						P.itemsetColumn,
						cursor,
						// The form parser's reason for a read of a column the table lacks, so a reader of
						// the account can tell a read of the Project's data that is not there.
						{ ...named, reason: "parse:unknown-column" },
					);
					cover(cursor, ITEMSET_KEYS, raised);
					cover(prompt, ["input_"], raised);
				} else {
					prompt.take(
						"input_",
						input === "select1" ? P.select1 : P.select,
						String,
					).value;
					itemsetCursor = cursor;
					cursor.take("instance_id", P.itemsetInstance, String).value;
					// The table the field's choices read, through Nova's typed carrier.
					ctx.accounting.claimEntry(
						{ json: cursor, key: "instance_id" },
						"expressions-and-data/item-list-tag-read-through-nova-s-typed-lookup-carriers",
						"instance-scheme:item-list",
						place,
					);
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
						// (`searchInputLookupSortColumnId`), and a document holds that order as no sort
						// column (`withCanonicalSearchInputOptions`).
						...(sortColumn !== undefined &&
							sortColumn !== labelColumn && {
								sortColumnId: sortColumn as LookupColumnId,
							}),
					};
					optionsFilterText = source.filter;
					if (optionsFilterText !== undefined)
						options.filter = pendingPlaceholder("condition");
				}
			}
		} else if (input === "address") {
			// HQ's build writes it as the prompt's `input`, as it does an address appearance: the
			// address field's finding, once where the appearance already gave it.
			if (addressRefused !== undefined)
				cover(prompt, ["input_", "itemset"], addressRefused);
			else cover(prompt, ["itemset"], refuseWith("input_", P.inputAddress));
		} else if (input === undefined || input === null)
			prompt.takeDefault("input_", P.text);
		else if (input !== "")
			cover(prompt, ["itemset"], refuseWith("input_", P.inputUnnamed));
		if (!refusedHere("appearance")) {
			if (appearance === "barcode_scan" && type === "text") {
				prompt.take("appearance", P.barcode, String).value;
				type = "barcode";
			} else if (appearance === "address" && inputOverAddress) {
				prompt.drop("appearance", P.addressUnderInput);
				sameState(
					ctx,
					P.addressUnderInput.entry,
					`${prompt.pointer}/appearance`,
					"list-settings-respelled",
				);
			} else if (typeof appearance === "string" && appearance !== "")
				prompt.drop("appearance", P.appearanceOther);
		}
		if (!refusedHere("name")) {
			if (!projectService && !exclude && ATTRIBUTE_PROMPT_NAMES.has(name))
				refuseWith("name", P.nameAttribute);
			// A prompt without `exclude` matches the case property of its own name, which Nova holds
			// as the simple field's property: a name Nova's property grammar refuses (`_x`,
			// `date-opened`, `external-id`) names a property no document can hold.
			else if (
				!projectService &&
				!exclude &&
				!authoredCasePropertyNameSchema.safeParse(name).success
			)
				refuseWith("name", P.nameOutside);
		}
	}
	if (type === "date-range" && holds("default_value"))
		refuseWith("default_value", P.defaultOnRange);

	const uuid = ctx.accounting.identity(
		ctx.identities.claim(
			externalKey.searchInput(module.uniqueId, name),
			`${module.uniqueId}/search/${name}`,
		),
		place,
		"schema:CaseSearchProperty.name",
	);
	if (uuid === undefined) return undefined;
	if (!refusedHere("name")) {
		prompt.take("name", P.name, String).value;
		if (!projectService && name === "owner_id" && exclude)
			ctx.accounting.claimEntry(
				{ json: prompt, key: "name" },
				P.ownerKey.entry,
				"csql-key:owner_id",
				place,
			);
	}
	if (!hiddenRefused) {
		if (exclude && hidden)
			prompt.take("exclude", P.hiddenExclude, Boolean).value;
		else if (exclude) prompt.take("exclude", P.exclude, Boolean).value;
		if (hidden) prompt.take("hidden", P.hiddenValue, Boolean).value;
	}

	// A text map spelled other than as the build shows it prints the same text, and the first
	// publish writes it as shown.
	const respelled = (
		at: JsonCursor,
		key: string,
		entry: string,
		read: HeldTexts | undefined,
	) => {
		if (
			read !== undefined &&
			at.used(key) &&
			(read.workersSeeAnother ||
				!spelledAsShown(at.peek(key), read.texts, codes))
		)
			recordTextRewrite(
				ctx,
				{ entry, path: `${at.pointer}/${key}` },
				"list-settings-respelled",
				read.workersSeeAnother,
			);
	};
	claimText(prompt, "label", P.label, labelRead);
	respelled(prompt, "label", P.label.entry, labelRead.held);
	// A hidden prompt's hint is shown nowhere: Web Apps hides the prompt (`query.js`, `d-none`) and
	// Android shows a prompt's label alone (`QueryRequestUiController.getLabel`). Nova's hidden
	// field holds none, and the first publish writes none. A hint the gate admits no spelling of,
	// or one holding a carriage return, whose rest a device reads as a line of the app strings
	// HQ's build writes it into, is read as any prompt's is.
	const storedHint = prompt.peek("hint");
	if (
		hidden &&
		hintRead.held !== undefined &&
		!(
			isJsonObject(storedHint) &&
			Object.values(storedHint).some(
				(text) => typeof text === "string" && text.includes("\r"),
			)
		)
	) {
		if (prompt.used("hint")) {
			prompt.drop("hint", P.hiddenHint);
			sameState(
				ctx,
				P.hiddenHint.entry,
				`${prompt.pointer}/hint`,
				"list-settings-respelled",
			);
		}
	} else {
		claimText(prompt, "hint", P.hint, hintRead);
		respelled(prompt, "hint", P.hint.entry, hintRead.held);
	}
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
		deferRefusal = false,
	) => {
		// HQ interpolates the stored condition whole, a rule's runtime guard too.
		const stored = at.json.peek(at.key);
		return ctx.pending.register(
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
				...(deferRefusal && { deferRefusal: true as const }),
				...(interpolation !== "none" &&
					typeof stored === "string" &&
					stored !== text && { slotText: stored }),
			},
			at,
		);
	};
	const defaultText = prompt.peek("default_value");
	const hasDefault =
		holds("default_value") &&
		!refusedHere("default_value") &&
		typeof defaultText === "string" &&
		defaultText.trim() !== "";
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
	if (readsRequired) {
		const assertion = prompt.object("required", "Assertion", P.required);
		const test = assertion.peek("test");
		claimText(assertion, "text", P.requiredText, requiredRead);
		const text = requiredMap;
		respelled(assertion, "text", P.requiredText.entry, requiredRead.held);
		required = {};
		if (typeof test === "string" && test.trim() === "true()")
			assertion.take("test", P.requiredAlways, String).value;
		else if (typeof test === "string")
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
	const validationList = readsValidation
		? prompt.list("validations", "Assertion", P.validation)
		: [];
	const first = validationList[0];
	if (first !== undefined && validation !== undefined) {
		if (validationRead !== undefined)
			claimText(first, "text", P.validationText, validationRead);
		const whole = validationRead?.held;
		respelled(
			first,
			"text",
			P.validationText.entry,
			whole !== undefined &&
				validation.kind === "checked" &&
				validation.workersSeeAnother
				? { ...whole, workersSeeAnother: true }
				: whole,
		);
		if (validation.kind === "guard") first.derived("test", P.validationGuard);
		else {
			if (validation.rule !== undefined)
				validationRule = register(
					"search_input_validation_rule",
					validation.rule,
					{ json: first, key: "test" },
					"no-dots",
					"schema:Assertion.test",
					// Whether the refusal is the rule's or the message's the settle tells.
					validation.untold,
				);
			validationMessage = sourceText(ctx, validation.messages);
			ctx.translations.set(
				makeTranslationUnitId("search-input", uuid, "validation-message"),
				"text",
				translatedTexts(ctx, validation.messages),
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
	const hint = hidden ? "" : sourceText(ctx, hintMap);
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
			...(projectService && !exclude && { sendAnswer: true as const }),
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
		// A refused field reads no property: it stands in the provisional document only so the
		// expressions that read it bind.
		entry = (
			projectService
				? { ...widget, kind: "parameter", sendAnswer: !exclude }
				: exclude || refused
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
		...(readsValidation &&
			validation?.kind === "checked" && { validationText: validation.held }),
		input: entry,
		refused,
		...(unreadTable !== undefined && { unreadTable }),
	};
}

/**
 * A stored text of a prompt as a reading holds it (`caseList/columns.ts::heldTextsIn`), and the
 * texts the prompt is read over: the held texts, or, where Nova's gate admits no spelling of one,
 * each language's text as HQ's build shows it (none where the build prints a value the reader
 * cannot know), for a reading that has its finding already (`claimText`).
 */
interface PromptText {
	readonly held?: HeldTexts;
	readonly texts: Readonly<Record<string, string>>;
	/** Where the reading holds no spelling of the text: which text, and why, where it knows. */
	readonly unheld?: UnheldText;
}

function promptText(
	ctx: ReadContext,
	stored: unknown,
	codes: readonly string[],
	role: TranslationUnitRole,
): PromptText {
	const source = sourceCode(ctx);
	const held = heldTextsIn(stored ?? NO_ENTRIES, codes, source, role);
	if (held !== undefined) return { held, texts: held.texts };
	const unheld = unheldTextsIn(stored ?? NO_ENTRIES, codes, source, role);
	return {
		texts: shownTexts(stored ?? NO_ENTRIES, codes) ?? NO_ENTRIES,
		...(unheld !== undefined && { unheld }),
	};
}

/**
 * Claims a prompt's text at `key`: under `claim` where the reading holds it; where Nova's gate
 * admits no spelling of it, refused at the key under the entry that names why
 * (`heldText.ts::unheldRefusal`), one finding at the search; any other is left for the close to
 * name, one finding as well.
 */
function claimText(
	at: JsonCursor,
	key: string,
	claim: Claim<"take">,
	read: PromptText,
): void {
	if (read.held !== undefined) {
		at.take(key, claim, languageMap).value;
		return;
	}
	const refusal = unheldRefusal(read.unheld);
	if (refusal !== undefined)
		at.refuse(key, refusal.claim, { name: refusal.name });
}

/** A prompt's first validation as read: Nova's runtime guard alone, or the authored rule (where
 *  it holds one) with each language's message as HQ's build shows it, less the guard's sentence
 *  where the stored check joins the guard after it. */
type ValidationReading =
	| { readonly kind: "guard" }
	| {
			readonly kind: "checked";
			readonly rule?: string;
			readonly messages: Readonly<Record<string, string>>;
			/** By language code, the whole text Nova prints for the validation: each message with the
			 *  guard's text joined after it where the check carries the guard. */
			readonly held: Readonly<Record<string, string>>;
			/** Whether Nova's join of a message and the guard's text shows another text than the
			 *  stored text did in some language: the message's end lost a space. */
			readonly workersSeeAnother: boolean;
			/** No language's message told whether Nova's runtime guard is joined after the rule:
			 *  the rule is the whole stored test, and the settle tells by its structure
			 *  (`settings.ts::settleUntoldChecks`). */
			readonly untold: boolean;
	  };

/** `stored`, a prompt's first validation, as `ValidationReading`, over `text`, its text in each
 *  language as the prompt is read (`promptText`). */
function readValidation(
	ctx: ReadContext,
	stored: unknown,
	text: Readonly<Record<string, string>>,
): ValidationReading | undefined {
	if (!isJsonObject(stored)) return undefined;
	const test = stored.test;
	const authored = withoutRuntimeGuard(
		test,
		sourceFirst(ctx).map((code) => text[code] ?? ""),
	);
	if (authored.kind === "guard") return { kind: "guard" };
	const guarded =
		authored.kind === "whole"
			? undefined
			: guardTexts(ctx).get(authored.guard.key);
	const rule = authored.kind === "split" ? authored.rule : test;
	// Each language's own message is the text before the guard's, held as every app string is
	// (`heldText.ts::holdText`): a message whose end meets the guard's text with a space of its
	// own loses it, so Nova's join, one space between, shows one space fewer there.
	let workersSeeAnother = false;
	const messages = recordFromEntries(Object.entries(text));
	const held = recordFromEntries(Object.entries(text));
	if (authored.kind === "split")
		for (const [code, one] of Object.entries(text)) {
			const suffix = ` ${guarded?.get(code) ?? authored.guard.message}`;
			if (!one.endsWith(suffix)) continue;
			const before = one.slice(0, one.length - suffix.length);
			const message = holdText(before) ?? before;
			messages[code] = message;
			held[code] = `${message}${suffix}`;
			if (held[code] !== one) workersSeeAnother = true;
		}
	return {
		kind: "checked",
		...(typeof rule === "string" && rule.trim() !== "" && { rule }),
		messages,
		held,
		workersSeeAnother,
		untold: authored.kind === "whole",
	};
}

/**
 * A stored validation's text, its field's message with the runtime guard's sentence joined after
 * it where the check carries one (`searchPrompts.ts::buildValidation`), as a reading holds it
 * (`caseList/columns.ts::heldTextsIn`): no space at either end, and a language blank-looking
 * beside the source's text takes the source's whole text there, guard sentence included.
 */
function validationTexts(
	ctx: ReadContext,
	stored: unknown,
	codes: readonly string[],
): HeldTexts | undefined {
	return heldTextsIn(
		stored ?? NO_ENTRIES,
		codes,
		sourceCode(ctx),
		"search-input-validation-message",
	);
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
 * that language ends with and that leaves each field a message of its own, a split whose sides
 * meet the space with no space of their own first (`guardSplit.ts::sharedGuardText`). Each text
 * is held as every app string is (`heldText.ts::holdText`). The stored bytes are
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
		const text = validationTexts(ctx, first.text, codes)?.texts;
		if (text === undefined) continue;
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
			// A text split from a join is held as every app string is (`heldText.ts::holdText`).
			const held = read === undefined ? undefined : holdText(read);
			if (held !== undefined) byCode.set(code, held);
		}
		out.set(key, byCode);
		ctx.translations.set(
			makeTranslationUnitId("system", "search-validation", key),
			"text",
			translatedTexts(ctx, recordFromEntries(byCode)),
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
							? heldTextsIn(
									prompt.required.text ?? NO_ENTRIES,
									appCodes(ctx),
									source,
									"search-input-required-message",
								)?.texts
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
		translatedTexts(ctx, recordFromEntries(out)),
	);
	return out;
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

/**
 * The reader's canonical choice `blank-search-field-labels-are-their-names`: a Search field whose
 * label is blank, and the same field labelled with its name. A blank label's translation unit
 * takes the field's name as its source (`lib/domain/translationUnits.ts`, the
 * `search-input-label` unit), so both print the name as the prompt's label in every language,
 * and the reader reads the label a prompt holds (`readSearchPrompts`), so it returns the field
 * labelled with its name.
 */
export function blankSearchFieldLabelsAreTheirNames(
	doc: BlueprintDoc,
): BlueprintDoc {
	const blank = doc.moduleOrder.some((uuid) =>
		doc.modules[uuid]?.caseListConfig?.searchInputs.some(
			(input) => input.label === "",
		),
	);
	if (!blank) return doc;
	return withCandidate(doc, (draft) => {
		for (const module of Object.values(draft.modules))
			for (const input of module.caseListConfig?.searchInputs ?? [])
				if (input.label === "") input.label = input.name;
	});
}
