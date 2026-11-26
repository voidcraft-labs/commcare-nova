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
	LookupTableId,
	SearchInputDef,
	SearchInputGroup,
	Uuid,
} from "@/lib/domain";
import { authoredCasePropertyNameSchema } from "@/lib/domain/casePropertyName";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import { sameLookupRead } from "@/lib/domain/lookupRead";
import {
	DEFAULT_SEARCH_MODE_KIND,
	SEARCH_ADDRESS_PARTS,
	SEARCH_INPUT_NAME_PATTERN,
	SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
	type SearchAddressReceiver,
	type SearchInputLookupOptions,
} from "@/lib/domain/modules";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import type { SearchRuntimeValidationMessage } from "@/lib/domain/searchRuntimeValidationMessages";
import {
	searchInputGroupLabelUnitId,
	type TranslationUnitRole,
} from "@/lib/domain/translationUnits";
import {
	circumstanceFinding,
	type Finding,
	type HqPlace,
} from "@/lib/publish/hqFindings";
import { isProjectSearchParameter } from "../../hq/projectSearch";
import {
	bindLookupRead,
	lookupReadNames,
	lookupReadPath,
} from "../../lookup/readPath";
import { isReservedSearchInputName } from "../../suite/case-search/reservedInputNames";
import {
	type FormSyntax,
	literalInstanceId,
	needsInstanceDeclaration,
} from "../../xpath/formSyntax";
import { scannedInstances } from "../../xpath/instanceSources";
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
import { interpolateHqXPath } from "../hqInterpolation";
import { externalKey } from "../identity";
import { isJsonObject, type JsonCursor } from "../jsonCursor";
import { manifestFindingOf } from "../languages";
import { lookupNameRefusal, undiscoveredLookupName } from "../lookupNames";
import { pendingPlaceholder } from "../pendingExpressions";
import { sourceFactories } from "../sourceFactories";
import { readFormSyntax, readStoredNameSyntax } from "../syntaxRead";
import { readGuardText } from "./guardSplit";
import { BLANK_IS_ABSENT, spelledAsShown } from "./settings";
import { storedPrompts, withoutRuntimeGuard } from "./systemSentences";
import { searchPlace } from "./workflow";

const S = "case-search/";

/** The entry a required or validation test with no message in any language is read under. */
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
	nameAttribute: take(
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
	addressPicker: take(
		`${S}address-picker-on-a-search-screen`,
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
	dateBare: take(
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
	itemsetCheckbox: take(
		`${S}input-checkbox-itemset`,
		"schema:CaseSearchProperty.itemset",
	),
	reports: refuse(
		`${S}input-select1-select-commcare-reports-itemset-mobile-ucr`,
		"schema:CaseSearchProperty.input_",
	),
	checkbox: take(
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
	/** An itemset whose nodeset reads a table's item list and that names no instance, or another
	 *  item list: HQ's build writes the nodeset alone and declares the instance from it, and the
	 *  first publish names the nodeset's (`readPrompt`). */
	itemsetInstanceElsewhere: drop(
		`${S}itemset-without-the-item-list-its-instance-id-names`,
		"schema:Itemset.instance_id",
	),
	itemsetElsewhere: refuse(
		`${S}itemset-nodeset-other-than-a-table-s-item-list`,
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
	itemsetRichLabel: take(
		`${S}itemset-refs-to-item-attributes-attr-or-property-qualified`,
		"schema:Itemset.label",
	),
	itemsetRichValue: take(
		`${S}itemset-refs-to-item-attributes-attr-or-property-qualified`,
		"schema:Itemset.value",
	),
	itemsetRichSort: take(
		`${S}itemset-refs-to-item-attributes-attr-or-property-qualified`,
		"schema:Itemset.sort",
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
	hiddenNoDefault: take(
		`${S}hidden-exclude-without-a-default-value-on-a-prompt-with-no`,
		"schema:CaseSearchProperty.hidden",
	),
	hiddenNoDefaultExclude: take(
		`${S}hidden-exclude-without-a-default-value-on-a-prompt-with-no`,
		"schema:CaseSearchProperty.exclude",
	),
	hiddenNoExclude: take(
		`${S}hidden-without-exclude-on-a-prompt-with-no-itemset-input-type-or`,
		"schema:CaseSearchProperty.hidden",
	),
	hiddenWidget: take(
		`${S}hidden-on-a-prompt-that-carries-an-itemset-input-type-or`,
		"schema:CaseSearchProperty.hidden",
	),
	hiddenChecked: refuse(
		`${S}hidden-together-with-required-or-validations`,
		"schema:CaseSearchProperty.hidden",
	),
	exclude: take(`${S}exclude`, "schema:CaseSearchProperty.exclude"),
	allowBlank: take(
		`${S}allow-blank-value`,
		"schema:CaseSearchProperty.allow_blank_value",
	),
	/** `allow_blank_value` on a hidden prompt: what Web Apps sends then turns on whether the
	 *  computed value begins with a blank (`readPrompt`). */
	allowBlankHidden: refuse(
		`${S}allow-blank-value-on-a-hidden-prompt`,
		"schema:CaseSearchProperty.allow_blank_value",
	),
	/** `allow_blank_value` on a shown prompt named `owner_id` without `exclude`: HQ refuses the
	 *  blank sent beside an owner (`readPrompt`). */
	allowBlankOwner: refuse(
		`${S}allow-blank-value-on-a-prompt-named-owner-id`,
		"schema:CaseSearchProperty.allow_blank_value",
	),
	addressReceiver: take(
		`${S}address-picker-receiver-on-a-search-screen`,
		"schema:CaseSearchProperty.receiver_expression",
	),
	receiver: refuse(
		`${S}receiver-expression`,
		"schema:CaseSearchProperty.receiver_expression",
	),
	receiverOther: refuse(
		`${S}receiver-expression-on-a-prompt-whose-editor-appearance-is`,
		"schema:CaseSearchProperty.receiver_expression",
	),
	receiverSingleChoice: refuse(
		`${S}address-receiver-single-choice-lookup-position`,
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
	/** A requirement's or a check's text blank in every language: a requirement with no message,
	 *  a check that shows CommCare's sentence (`readPrompt`). */
	requiredNoMessage: take(NO_MESSAGE, "schema:Assertion.text"),
	validationNoMessage: take(NO_MESSAGE, "schema:Assertion.text"),
	group: take(`${S}is-group-group-key`, "schema:CaseSearchProperty.is_group"),
	groupName: take(`${S}is-group-group-key`, "schema:CaseSearchProperty.name"),
	groupLabel: take(`${S}is-group-group-key`, "schema:CaseSearchProperty.label"),
	groupLayout: refuse(
		`${S}search-group-layout-unreadable`,
		"schema:CaseSearchProperty.group_key",
	),
	groupHeading: refuse(
		`${S}search-group-heading-unreadable`,
		"schema:CaseSearchProperty.label",
	),
	groupMissing: refuse(
		`${S}groups-present-and-an-input-without-group-key`,
		"schema:CaseSearchProperty.group_key",
	),
	groupKey: take(
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

function parse(text: unknown, storedNames = false): FormSyntax | undefined {
	if (typeof text !== "string") return undefined;
	const read = storedNames ? readStoredNameSyntax(text) : readFormSyntax(text);
	return read.ok ? read.node : undefined;
}

/** An itemset's nodeset as `instance('item-list:<tag>')/<tag>_list/<tag>[filter]`: the tag and the
 *  filter's text, where it is that shape. */
function itemsetSource(
	text: unknown,
	suiteSources: ReadonlyMap<string, string>,
): { tag: string; filter?: string; undiscovered?: true } | undefined {
	if (typeof text !== "string") return undefined;
	let node = parse(text, true);
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
	const id = literalInstanceId(list.left);
	if (id?.value !== `item-list:${item}`) return undefined;
	if (
		list.left !== undefined &&
		needsInstanceDeclaration(list.left, text) &&
		!suiteSources.has(id.value)
	)
		return { tag: item, undiscovered: true };
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

/** Whether a prompt carries a widget: an itemset, an input type, or an appearance that gives one
 *  (a barcode scan, an address); a blank input type is none, and any other appearance dresses no
 *  widget Nova holds, which the reading drops (`P.appearanceOther`, `readPrompt`). */
function carriesWidget(prompt: JsonCursor): boolean {
	const appearance = prompt.peek("appearance");
	return (
		prompt.used("itemset") ||
		(prompt.used("input_") && prompt.peek("input_") !== "") ||
		appearance === "barcode_scan" ||
		appearance === "address"
	);
}

/**
 * Reads each prompt of a searching menu into a Search field at its provisional arm, and keeps
 * what the settle needs. A prompt that raised a finding is read as far as the finding leaves it
 * (`PromptReading.refused`); a group's own entry, which is no field, has no reading.
 */
/** Read physical heading rows separately from the fields that send answers. */
function readSearchGroups(
	ctx: ReadContext,
	module: DraftModule,
	prompts: readonly JsonCursor[],
	place: HqPlace,
) {
	const groups: SearchInputGroup[] = [];
	const hasFields = prompts.some((row) => row.peek("is_group") !== true);
	const memberships = new Map<JsonCursor, Uuid>();
	const keys = new Set<string>();
	let refused = false;
	for (const [index, row] of prompts.entries()) {
		if (row.peek("is_group") !== true) continue;
		const key = row.peek("group_key");
		if (
			typeof key !== "string" ||
			!key ||
			!hasFields ||
			keys.has(key) ||
			row.peek("name") !== key
		) {
			row.refuseWhole(P.groupLayout, { name: String(key ?? "") });
			refused = true;
			continue;
		}
		keys.add(key);
		const codes = appCodes(ctx);
		const copy = promptText(
			ctx,
			row.peek("label"),
			codes,
			"search-input-group-label",
		);
		const label = sourceText(ctx, copy.texts);
		if (copy.held === undefined || !label) {
			row.refuseWhole(P.groupHeading, { name: key });
			refused = true;
			continue;
		}
		const members: JsonCursor[] = [];
		for (let next = index + 1; next < prompts.length; next++) {
			const member = prompts[next];
			if (member.peek("is_group") === true) break;
			if (member.peek("group_key") !== key) {
				refused = true;
				continue;
			}
			members.push(member);
		}
		const names = members.flatMap((member) => {
			const name = member.peek("name");
			return typeof name === "string" ? [name] : [];
		});
		const uuid = ctx.accounting.identity(
			ctx.identities.claim(
				externalKey.searchInputGroup(module.uniqueId, names, groups.length),
				`${module.uniqueId}/search/groups/${index}`,
			),
			place,
			"schema:CaseSearchProperty.group_key",
		);
		if (uuid === undefined) {
			refused = true;
			continue;
		}
		row.take("is_group", P.group, Boolean).value;
		row.take("name", P.groupName, String).value;
		row.take("group_key", P.groupKey, String).value;
		row.take("label", P.groupLabel, languageMap).value;
		ctx.translations.set(
			searchInputGroupLabelUnitId(uuid),
			"text",
			translatedTexts(ctx, copy.texts),
		);
		groups.push({ uuid, label });
		if (key !== `group_header_${index}`) {
			for (const owningRow of [row, ...members])
				sameState(
					ctx,
					P.groupKey.entry,
					`${owningRow.pointer}/group_key`,
					"list-settings-respelled",
				);
			sameState(
				ctx,
				P.groupName.entry,
				`${row.pointer}/name`,
				"list-settings-respelled",
			);
		}
		for (const member of members) memberships.set(member, uuid);
	}
	const grouped = prompts.some(
		(row) => row.peek("is_group") === true || row.used("group_key"),
	);
	return {
		groups,
		memberships,
		refused:
			refused ||
			(grouped &&
				prompts.some(
					(row) => row.peek("is_group") !== true && !memberships.has(row),
				)),
		grouped,
	};
}

export function readSearchPrompts(
	ctx: ReadContext,
	module: DraftModule,
	config: JsonCursor,
	defaultFilterNames: ReadonlyMap<string, readonly string[]>,
	projectService = false,
) {
	const place = searchPlace(module);
	const prompts = config.list(
		"properties",
		"CaseSearchProperty",
		P.order,
		() => place,
	);
	const groupReading = readSearchGroups(ctx, module, prompts, place);
	// Each of these texts is emitted into the same remote request. Exclude
	// group headings and gated defaults, which need their own target facts.
	const suiteSources = new Map<string, string>();
	const scan = (text: unknown, interpolateDots?: boolean) => {
		if (typeof text !== "string") return;
		const runtime =
			interpolateDots === undefined
				? { ok: true as const, text }
				: interpolateHqXPath(text, { interpolateDots });
		if (runtime.ok)
			for (const [id, source] of scannedInstances(
				runtime.text,
				sourceFactories(ctx.input),
				undefined,
				(name) =>
					ctx.accounting.circumstance("unbuildable-data-source-name", place, {
						name,
					}),
			))
				suiteSources.set(id, source);
	};
	for (const prompt of prompts) {
		if (prompt.peek("is_group") === true) continue;
		const itemset = prompt.peek("itemset");
		if (isJsonObject(itemset)) scan(itemset.nodeset);
		const required = prompt.peek("required");
		if (isJsonObject(required)) scan(required.test, true);
		const validations = prompt.peek("validations");
		if (Array.isArray(validations)) {
			for (const rule of validations)
				if (isJsonObject(rule)) scan(rule.test, false);
		}
	}
	const sourceNames = new Set(
		prompts
			.filter((prompt) => canReadAddressPrompt(prompt, projectService))
			.flatMap((prompt) => {
				const name = prompt.peek("name");
				return typeof name === "string" ? [name] : [];
			}),
	);
	const out: PromptReading[] = [];
	for (const prompt of prompts) {
		if (prompt.peek("is_group") === true) continue;
		const reading = readPrompt(
			ctx,
			module,
			prompt,
			place,
			defaultFilterNames,
			groupReading.grouped,
			groupReading.memberships.get(prompt),
			suiteSources,
			projectService,
			sourceNames,
		);
		if (reading !== undefined) out.push(reading);
	}
	const linkedPrompts = out.map((prompt): PromptReading => {
		const input = prompt.input;
		if (
			input.kind === "address" ||
			input.kind === "hidden" ||
			input.addressReceiver?.kind !== "unsubscribed"
		)
			return prompt;
		const configured = input.addressReceiver;
		const source = out.find(
			({ input }) =>
				input.kind === "address" && input.name === configured.topic,
		);
		if (source === undefined) return prompt;
		return {
			...prompt,
			input: {
				...input,
				addressReceiver: {
					kind: "address",
					source: source.uuid,
					parts: configured.fields.split("||") as Array<
						(typeof SEARCH_ADDRESS_PARTS)[number]
					>,
				},
			},
		};
	});
	return {
		prompts: linkedPrompts,
		groups: groupReading.groups,
		groupRefused: groupReading.refused,
	};
}

function canReadAddressPrompt(
	prompt: JsonCursor,
	projectService: boolean,
): boolean {
	const required = prompt.peek("required");
	const validations = prompt.peek("validations");
	const itemset = prompt.peek("itemset");
	return (
		!projectService &&
		typeof prompt.peek("name") === "string" &&
		/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(prompt.peek("name"))) &&
		prompt.peek("is_group") !== true &&
		prompt.peek("appearance") === "address" &&
		!prompt.peek("input_") &&
		!prompt.peek("default_value") &&
		prompt.peek("hidden") !== true &&
		prompt.peek("allow_blank_value") !== true &&
		!prompt.peek("receiver_expression") &&
		(!isJsonObject(required) || !required.test) &&
		(!Array.isArray(validations) || validations.length === 0) &&
		(!isJsonObject(itemset) || !itemset.nodeset)
	);
}

function readPrompt(
	ctx: ReadContext,
	module: DraftModule,
	prompt: JsonCursor,
	place: HqPlace,
	defaultFilterNames: ReadonlyMap<string, readonly string[]>,
	grouped: boolean,
	group: Uuid | undefined,
	suiteSources: ReadonlyMap<string, string>,
	projectService: boolean,
	addressSources: ReadonlySet<string>,
): PromptReading | undefined {
	const stored = prompt.peek("name");
	const name = typeof stored === "string" ? stored : "";
	const named = { name: name };
	// Each refusal is the one finding for its cause, at the key that holds it, and the reading
	// goes on: every other key of the prompt is read as it would be, or, where the refusal leaves
	// nothing to read it into, stands under that finding (`cover`), so the close names none of
	// them. A refused prompt is still a field of the provisional document (`PromptReading.refused`),
	// so the expressions of the other fields that read it bind; it keeps the search out of the
	// settle.
	// Each claimed key and the refusal it stands under, if any, so a key read only beside another can stand under its refusal.
	const claimed = new Map<string, Finding | undefined>();
	const site = (at: JsonCursor, key: string) => `${at.pointer}\u0000${key}`;
	let refused = false;
	let unreadTable: string | undefined;
	const refuseWith = (
		key: string,
		claim: Claim<"refuse">,
		at: JsonCursor = prompt,
		detail: { readonly name: string; readonly reason?: string } = named,
	): Finding => {
		const finding = manifestFindingOf(claim, place, detail);
		if (at.used(key)) {
			at.refuse(key, claim, detail);
			claimed.set(site(at, key), finding);
		} else ctx.accounting.finding(claim, place, detail);
		refused = true;
		return finding;
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
				claimed.set(site(at, key), by);
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
			claimed.set(site(prompt, key), undefined);
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
	if (grouped) {
		if (group !== undefined) prompt.take("group_key", P.groupKey, String).value;
		else if (prompt.used("group_key")) refuseWith("group_key", P.groupLayout);
		else refuseWith("group_key", P.groupMissing);
	}
	const address = canReadAddressPrompt(prompt, projectService);
	const inputType = editorAppearance(prompt);
	const sourceReceiver = prompt.peek("receiver_expression");
	let addressReceiver:
		| Exclude<SearchAddressReceiver, { kind: "address" }>
		| undefined;
	if (holds("receiver_expression")) {
		const wire =
			typeof sourceReceiver === "string"
				? /^([A-Za-z_][A-Za-z0-9_]*)-([A-Za-z_][A-Za-z0-9_]*(?:\|\|[A-Za-z_][A-Za-z0-9_]*)*)$/.exec(
						sourceReceiver,
					)
				: null;
		const parts = wire?.[2].split("||") ?? [];
		const validSource = wire !== null && addressSources.has(wire[1]);
		if (
			RECEIVER_REFUSED_APPEARANCES.has(inputType) ||
			prompt.peek("hidden") === true
		)
			refuseWith("receiver_expression", P.receiverOther);
		else if (validSource && prompt.peek("input_") === "select1")
			refuseWith("receiver_expression", P.receiverSingleChoice);
		else if (
			wire === null ||
			(validSource &&
				!parts.every((part) =>
					(SEARCH_ADDRESS_PARTS as readonly string[]).includes(part),
				))
		)
			refuseWith("receiver_expression", P.receiver);
		else {
			prompt.take("receiver_expression", P.addressReceiver, String).value;
			addressReceiver = {
				kind: "unsubscribed",
				topic: wire[1],
				fields: wire[2],
			};
		}
	}
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
	// A hidden prompt with no widget that leaves its key out of the request is a value the search
	// never matches by its name, Nova's hidden arm; any other hidden prompt is a Search field Web
	// Apps does not draw (`hidden: true`), read as a shown one is. A hidden prompt Nova cannot hold
	// is read as a Hidden Value, and each key whose meaning the refusal names (its checks, its
	// widget, `exclude`) stands under the refusal's finding.
	const widget = carriesWidget(prompt);
	const hiddenArm = hidden && (exclude || projectService) && !widget;
	let hiddenRefused = false;
	let addressRefused: Finding | undefined;
	// Web Apps draws "Include results where … is blank" under a shown prompt whose
	// `allow_blank_value` is on (`query/item.html`) and sends its blank before the answer
	// (`query.js::encodeValue`); Android draws none. A hidden prompt's row is hidden whole, so the
	// box is never ticked, but Web Apps reads a starting value that begins with a blank as ticked
	// (`query.js::decodeValue`) and sends that blank only where the prompt allows blank: what a
	// hidden prompt sends then turns on what it computes, which only the run decides.
	const allowsBlank = prompt.used("allow_blank_value");
	if (allowsBlank && hidden)
		refuseWith("allow_blank_value", P.allowBlankHidden);
	// A shown `owner_id` prompt without `exclude` reaches HQ as the owner filter, which refuses any
	// second value (`case_search/models.py::SearchCriteria._validate_multiple_terms`), so a ticked
	// box beside an answer stops the search ("Multiple values are only supported for simple text
	// and range searches"), while the box alone searches every owner.
	else if (allowsBlank && !exclude && name === "owner_id")
		refuseWith("allow_blank_value", P.allowBlankOwner);
	if (hidden && checked) {
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
			refuseWith("hidden", P.hiddenChecked),
		);
	} else if (appearance === "address" && !inputOverAddress && !address)
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
	// A check whose message is blank in every language (a language with no text shows another's,
	// `shownTexts`, so the source's is blank only where every one is): HQ's build writes a blank
	// text for a requirement (`app_strings.py`, `clean_trans` of the map), which Nova holds as a
	// requirement with no message (`noMessage`), and no text for a validation
	// (`remote_requests.py`: `if validation.has_text`), whose worker reads Core's own sentence,
	// which Nova holds as a check with no message of its own.
	const requiredBlank =
		requires &&
		requiredRead.held !== undefined &&
		sourceText(ctx, requiredMap) === "";
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
	const validationBlank =
		validation?.kind === "checked" &&
		validationRead?.held !== undefined &&
		sourceText(ctx, validation.messages) === "";
	// HQ builds a check's text wherever any value of its map is a nonempty string, the app's
	// languages or not (`models/base.py::has_text`: `any(self.text.values())`), so a check blank
	// in every language the app has, beside text under a language it no longer has, shows the
	// worker a blank message, where Nova's publish of a check with no message shows Core's own
	// sentence: the worker reads another message after the next publish.
	const validationShownBlank =
		validationBlank &&
		isJsonObject(storedValidation) &&
		isJsonObject(storedValidation.text) &&
		Object.values(storedValidation.text).some(
			(value) => typeof value === "string" && value !== "",
		);
	const readsRequired = requires && !hiddenRefused && !refusedHere("required");
	const readsValidation = !hiddenRefused && !refusedHere("validations");

	let type: PromptReading["type"] =
		hiddenArm || hiddenRefused ? "hidden" : "text";
	// The hidden arm reads no widget, so an appearance that gives none is dropped here, as the
	// widget block drops it on a shown field.
	if (
		hiddenArm &&
		!hiddenRefused &&
		typeof appearance === "string" &&
		appearance !== ""
	)
		prompt.drop("appearance", P.appearanceOther);
	let options: SearchInputLookupOptions | undefined;
	let optionsFilterText: string | undefined;
	let itemsetCursor: JsonCursor | undefined;
	if (type !== "hidden") {
		if (input === "date") {
			prompt.take("input_", exclude ? P.date : P.dateBare, String).value;
			type = "date";
		} else if (input === "daterange") {
			prompt.take("input_", P.dateRange, String).value;
			type = "date-range";
		} else if (
			input === "select1" ||
			input === "select" ||
			input === "checkbox"
		) {
			const widget =
				input === "select1"
					? P.select1
					: input === "checkbox"
						? P.checkbox
						: P.select;
			const binding =
				input === "select1"
					? P.itemset
					: input === "checkbox"
						? P.itemsetCheckbox
						: P.itemsetMulti;
			const itemset = prompt.peek("itemset");
			const instance = isJsonObject(itemset) ? itemset.instance_id : undefined;
			// The scheme HQ's build checks, where the itemset names an instance
			// (`helpers/validators.py::validate_search_config`: `instance_id.split(':', 1)[0]`).
			const scheme =
				typeof instance === "string" && instance !== ""
					? instance.split(":")[0]
					: undefined;
			const source = isJsonObject(itemset)
				? itemsetSource(itemset.nodeset, suiteSources)
				: undefined;
			// The instance HQ's Case List page shows the field's table by (`case_claim.js::itemsetModel`:
			// `lookupTableNodeset` reads `instance_id`), which neither runtime reads: HQ's build writes
			// the nodeset alone (`remote_requests.py::build_query_prompts`) and declares each instance
			// the nodeset reads (`post_process/instances.py`). Where it names no instance, or another
			// item list, the field's table is the one its nodeset reads, and the first publish names it.
			const namesSource =
				source !== undefined && instance === `item-list:${source.tag}`;
			const readInstanceElsewhere = (cursor: JsonCursor) => {
				cursor.drop("instance_id", P.itemsetInstanceElsewhere);
				if (scheme === "item-list")
					ctx.accounting.claimEntry(
						{ json: cursor, key: "instance_id" },
						"expressions-and-data/item-list-tag-read-through-nova-s-typed-lookup-carriers",
						"instance-scheme:item-list",
						place,
					);
				sameState(
					ctx,
					P.itemsetInstanceElsewhere.entry,
					`${cursor.pointer}/instance_id`,
					"list-settings-respelled",
				);
			};
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
				const cursor = prompt.object("itemset", "Itemset", binding);
				const label = lookupReadPath(itemset.label, "stored-xml");
				const value = lookupReadPath(itemset.value, "stored-xml");
				const sortText = itemset.sort;
				const sort =
					typeof sortText === "string" && sortText !== ""
						? lookupReadPath(sortText, "stored-xml")
						: undefined;
				const table =
					source === undefined || source.undiscovered
						? undefined
						: ctx.input.lookup.table(source.tag);
				const valueColumn =
					value === undefined || !table
						? undefined
						: bindLookupRead(value, table);
				const labelColumn =
					label === undefined || !table
						? undefined
						: bindLookupRead(label, table);
				const sortColumn =
					sort === undefined || !table
						? undefined
						: bindLookupRead(sort, table);
				const nameRefusal = source?.undiscovered
					? undiscoveredLookupName(source.tag)
					: table === undefined || source === undefined
						? undefined
						: (lookupNameRefusal(source.tag, "search_input_options", "tag") ??
							[
								{ read: label, bound: labelColumn },
								{ read: value, bound: valueColumn },
								{ read: sort, bound: sortColumn },
							].flatMap(({ read, bound }) => {
								if (read === undefined || bound === undefined) return [];
								return lookupReadNames(read).flatMap((name) => {
									const refusal = lookupNameRefusal(
										name,
										"search_input_options",
										"column",
									);
									return refusal === undefined ? [] : [refusal];
								});
							})[0]);
				if (nameRefusal !== undefined) {
					const raised = refuseWith("nodeset", nameRefusal.claim, cursor, {
						name: nameRefusal.name,
					});
					cover(cursor, ITEMSET_KEYS, raised);
					cover(prompt, ["input_"], raised);
				} else if (scheme !== undefined && scheme !== "item-list") {
					// An instance of another scheme, which HQ's build refuses.
					const raised = refuseWith("instance_id", P.itemsetScheme, cursor);
					cover(cursor, ITEMSET_KEYS, raised);
					cover(prompt, ["input_"], raised);
				} else if (source === undefined) {
					// A nodeset that reads elsewhere than a table's item list: HQ builds it, and Nova's
					// choices are a table's item list.
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
					const raised = refuseWith(
						label === undefined
							? "label"
							: value === undefined
								? "value"
								: "sort",
						P.itemsetColumn,
						cursor,
						{ ...named, reason: "parse:invalid-lookup-selector" },
					);
					cover(cursor, ITEMSET_KEYS, raised);
					cover(prompt, ["input_"], raised);
				} else if (table === undefined) {
					// Project data's lookup table rules settle the read (`unreadTables`); the prompt's
					// other keys are what Nova holds of a field over a table.
					if (namesSource)
						cursor.handOff("instance_id", "lookup-table-read", source.tag);
					else readInstanceElsewhere(cursor);
					ctx.facts.unreadTables.push({ tag: source.tag, place });
					unreadTable = source.tag;
					refused = true;
					prompt.take("input_", widget, String).value;
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
					prompt.take("input_", widget, String).value;
					itemsetCursor = cursor;
					if (namesSource) {
						cursor.take("instance_id", P.itemsetInstance, String).value;
						// The table the field's choices read, through Nova's typed carrier.
						ctx.accounting.claimEntry(
							{ json: cursor, key: "instance_id" },
							"expressions-and-data/item-list-tag-read-through-nova-s-typed-lookup-carriers",
							"instance-scheme:item-list",
							place,
						);
					} else readInstanceElsewhere(cursor);
					// A filter's claim on the nodeset is the expression stage's, by the registration below.
					if (source.filter === undefined)
						cursor.take("nodeset", P.itemsetNodeset, String).value;
					cursor.take(
						"label",
						typeof labelColumn === "string"
							? P.itemsetLabel
							: P.itemsetRichLabel,
						String,
					).value;
					cursor.take(
						"value",
						typeof valueColumn === "string"
							? P.itemsetValue
							: P.itemsetRichValue,
						String,
					).value;
					if (sortColumn !== undefined)
						cursor.take(
							"sort",
							typeof sortColumn === "string"
								? P.itemsetSort
								: P.itemsetRichSort,
							String,
						).value;
					type =
						input === "select1"
							? "select"
							: input === "checkbox"
								? "checkboxes"
								: "multi-select";
					options = {
						kind: "lookup",
						tableId: table.tableId as LookupTableId,
						valueColumnId: valueColumn,
						labelColumnId: labelColumn,
						// The label column is the order a field with no sort column of its own prints
						// (`searchInputLookupSortColumnId`), and a document holds that order as no sort
						// column (`withCanonicalSearchInputOptions`).
						...(sortColumn !== undefined &&
							!sameLookupRead(sortColumn, labelColumn) && {
								sortColumnId: sortColumn,
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
		// An appearance only dresses the widget its input type gives: beside an input type Nova
		// refuses it is no field Nova holds, so it stands under that refusal rather than claim a
		// barcode scan (Android's scanner callout) or a respelled address for a field that is not
		// there.
		const widgetRefusal = claimed.get(site(prompt, "input_"));
		if (
			widgetRefusal !== undefined &&
			typeof appearance === "string" &&
			appearance !== ""
		)
			cover(prompt, ["appearance"], widgetRefusal);
		if (!refusedHere("appearance")) {
			if (address) {
				prompt.take("appearance", P.addressPicker, String).value;
				type = "address";
			} else if (appearance === "barcode_scan" && type === "text") {
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
			// A prompt without `exclude` matches the case property of its own name, which Nova holds
			// as the simple field's property: a name Nova's property grammar refuses (`_x`,
			// `date-opened`, `external-id`) names a property no document can hold.
			if (
				!projectService &&
				!exclude &&
				!address &&
				!ATTRIBUTE_PROMPT_NAMES.has(name) &&
				!authoredCasePropertyNameSchema.safeParse(name).success
			)
				refuseWith("name", P.nameOutside);
		}
	}

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
		prompt.take(
			"name",
			!projectService && !exclude && ATTRIBUTE_PROMPT_NAMES.has(name)
				? P.nameAttribute
				: P.name,
			String,
		).value;
		if (!projectService && name === "owner_id" && exclude)
			ctx.accounting.claimEntry(
				{ json: prompt, key: "name" },
				P.ownerKey.entry,
				"csql-key:owner_id",
				place,
			);
	}
	// A hidden field without a starting value is held as one with none: Web Apps holds it blank,
	// and Android, which shows it, seeds no answer for it
	// (`RemoteQuerySessionManager.initUserAnswers`).
	const storedDefault = prompt.peek("default_value");
	const hiddenWithValue =
		hidden && typeof storedDefault === "string" && storedDefault.trim() !== "";
	if (!hiddenRefused) {
		if (exclude && hiddenArm)
			prompt.take(
				"exclude",
				hiddenWithValue ? P.hiddenExclude : P.hiddenNoDefaultExclude,
				Boolean,
			).value;
		else if (exclude) prompt.take("exclude", P.exclude, Boolean).value;
		if (hiddenArm)
			prompt.take(
				"hidden",
				hiddenWithValue ? P.hiddenValue : P.hiddenNoDefault,
				Boolean,
			).value;
		else if (hidden)
			prompt.take(
				"hidden",
				widget ? P.hiddenWidget : P.hiddenNoExclude,
				Boolean,
			).value;
	}
	const allowBlank =
		!hidden &&
		allowsBlank &&
		!refusedHere("allow_blank_value") &&
		prompt.take("allow_blank_value", P.allowBlank, Boolean).value === true;

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
				suiteSources,
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
				type === "hidden"
					? "search_input_hidden_value"
					: "search_input_default",
				defaultText,
				{ json: prompt, key: "default_value" },
				"none",
				"schema:CaseSearchProperty.default_value",
			)
		: undefined;
	let requiredWhen: number | undefined;
	let required: { message?: string; noMessage?: true } | undefined;
	if (readsRequired) {
		const assertion = prompt.object("required", "Assertion", P.required);
		const test = assertion.peek("test");
		const textClaim = requiredBlank ? P.requiredNoMessage : P.requiredText;
		claimText(assertion, "text", textClaim, requiredRead);
		const text = requiredMap;
		respelled(assertion, "text", textClaim.entry, requiredRead.held);
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
		if (requiredBlank) required.noMessage = true;
		else if (!novaSentence) {
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
		const textClaim = validationBlank
			? P.validationNoMessage
			: P.validationText;
		if (validationRead !== undefined)
			claimText(first, "text", textClaim, validationRead);
		const whole = validationRead?.held;
		respelled(
			first,
			"text",
			textClaim.entry,
			whole !== undefined &&
				validation.kind === "checked" &&
				(validation.workersSeeAnother || validationShownBlank)
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
			if (!validationBlank) {
				validationMessage = sourceText(ctx, validation.messages);
				ctx.translations.set(
					makeTranslationUnitId("search-input", uuid, "validation-message"),
					"text",
					translatedTexts(ctx, validation.messages),
				);
			}
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
		...(group !== undefined && { group }),
		label: sourceText(ctx, label),
		...(hint !== "" && { hint }),
		...(required !== undefined && {
			required: {
				...(requiredWhen !== undefined && {
					when: pendingPlaceholder("condition"),
				}),
				...(required.message !== undefined && { message: required.message }),
				...(required.noMessage === true && { noMessage: true as const }),
			},
		}),
		...(validationRule !== undefined && {
			validation: {
				rule: pendingPlaceholder("condition"),
				...(validationMessage !== undefined && { message: validationMessage }),
			},
		}),
	};
	let entry: SearchInputDef;
	if (type === "hidden")
		entry = {
			uuid,
			name,
			label: common.label,
			...(group !== undefined && { group }),
			kind: "hidden",
			...(projectService && !exclude && { sendAnswer: true as const }),
			...(defaultIndex !== undefined && {
				value: pendingPlaceholder("value"),
			}),
		};
	else if (type === "address")
		entry = {
			kind: "address",
			type,
			uuid,
			name,
			label: common.label,
			...(group !== undefined && { group }),
			...(hint !== "" && { hint }),
			...(exclude && { excludeFromRequest: true }),
		};
	else {
		const widget = {
			...common,
			type,
			...(addressReceiver !== undefined && { addressReceiver }),
			...(options !== undefined && { options }),
			...(defaultIndex !== undefined && {
				default: pendingPlaceholder("value"),
			}),
			...(allowBlank && { allowBlank: true as const }),
			...(hidden && { hidden: true as const }),
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
							property: name === "name" ? "case_name" : name,
							...((ATTRIBUTE_PROMPT_NAMES.has(name) || type === "date") && {
								matching: "project-space",
							}),
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
			(type === "hidden"
				? { hiddenValue: defaultIndex }
				: { default: defaultIndex })),
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
	if (authored.kind === "guard") {
		guardTexts(ctx);
		return { kind: "guard" };
	}
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

/** Recover all languages of a guard recognized by a catalog sentence. A prompt carrying
 * it alone supplies its exact wording. Otherwise all joins for that guard must allow the
 * same split, just as the canonical wire comparison splits them. Once the search rows
 * are placed, settleUntoldChecks also recognizes fully customized guards by their test. */
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
	for (const [key, entry] of entries) {
		const byCode = new Map<string, string>();
		for (const code of codes) {
			const given = alone.get(key)?.get(code);
			const texts = joined.get(key)?.get(code) ?? [];
			const read = readGuardText(entry.message, given, texts);
			// A text split from a join is held as every app string is (`heldText.ts::holdText`).
			const held = read === undefined ? undefined : holdText(read);
			if (held !== undefined) byCode.set(code, held);
		}
		out.set(key, byCode);
		ctx.translations.set(
			makeTranslationUnitId("system", "search-validation", key),
			"text",
			translatedTexts(ctx, recordFromEntries(byCode), true),
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
	const codes = appCodes(ctx);
	const messages =
		source === undefined
			? []
			: storedPrompts(ctx.app.peek("modules")).map((prompt) =>
					isJsonObject(prompt.required)
						? heldTextsIn(
								prompt.required.text ?? NO_ENTRIES,
								codes,
								source,
								"search-input-required-message",
							)?.texts
						: undefined,
				);
	const defaults = (value?: string) =>
		value === SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE;
	const carrier =
		(source && messages.find((text) => defaults(text?.[source]))) ||
		messages.find((text) => codes.some((code) => defaults(text?.[code])));
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
		translatedTexts(ctx, recordFromEntries(out), true),
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
