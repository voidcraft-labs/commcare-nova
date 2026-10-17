/**
 * Step `reserved-search-inputs`: the Search questions CommCare HQ reads as
 * part of the search request, never as a case property (part 06 of step 2's
 * plan, 6. Reserved search input names). Per menu, removing first and then
 * renaming what remains:
 *
 *   1. Each input that reaches HQ as its own request key and whose name is
 *      reserved (`isReservedSearchInputName`) is removed, an own-key input
 *      named `_xpath_query` among them, since a rename would make it start
 *      searching a property of the new name. HQ never searched it as the
 *      property it names, so no search result changes. Each expression of
 *      the menu that reads its answer takes the unanswered reading: every
 *      `when-input-present` over it becomes `match-all` and every other read
 *      of it the empty string, a Search value as the blank literal and a
 *      `#search/<name>` read in a form as `''`. The places read are the ones
 *      `lib/doc/searchInputMutations.ts::searchInputRemovalDependencies` and
 *      `::searchInputFormFieldDependencies` find for the removal, and the
 *      input leaves the list as the `removeSearchInput` reducer takes it out;
 *      `__tests__/equality.test.ts` holds the step to both.
 *   2. Each remaining input named `_xpath_query`, which does not reach HQ as
 *      its own key, so its name is only a handle, takes the lowest free
 *      suffix (`_xpath_query_2`). References are by uuid, so nothing else is
 *      rewritten.
 *
 * Whether an input reaches HQ as its own key is the rule of
 * `lib/commcare/suite/case-search/searchPrompts.ts::searchInputSuppressesAutoMatch`,
 * restated here over the stored input: only a simple input does, and only
 * when HQ's own exact or range match on its key is the authored comparison.
 *
 * One `search-input-removed` line per removal, naming the input by its own
 * name, which is what CommCare read, with `detail.menu` and
 * `detail.expressions`, the count of expressions that changed. One
 * `search-input-renamed` line per rename, naming the input, with
 * `detail.menu`, `detail.from` and `detail.to`.
 */

import { isReservedSearchInputName } from "@/lib/commcare/suite/case-search/reservedInputNames";
import {
	asUuid,
	CASE_NODE_ATTRIBUTE_PROPERTIES,
	DEFAULT_SEARCH_MODE_KIND,
	type SearchInputType,
} from "@/lib/domain";
import { suffixUntilFree } from "@/lib/domain/idSlug";
import type { Json, JsonRecord, RawDocument } from "../oldShape";
import type { CutoverStep, DocumentChange } from "../transform";
import { writableRecord } from "./caseLists";
import { formXPathSlots, isRecord, rawText } from "./relativePaths";

/** The name an input loses when it is only a handle. */
const XPATH_QUERY = "_xpath_query";

/**
 * Whether a stored input reaches HQ as its own request key: a simple input
 * whose exact match (not on a date, on its own case, under its own property
 * name, which HQ searches by that name) or range match (on its own case,
 * under its own property name) is what HQ applies to the key.
 */
function rawInputReachesHqAsOwnKey(input: JsonRecord): boolean {
	if (input.kind !== "simple") return false;
	const type = rawText(input.type) as SearchInputType;
	const mode = isRecord(input.mode)
		? rawText(input.mode.kind)
		: DEFAULT_SEARCH_MODE_KIND[type];
	const via = input.via;
	const onOwnCase = !isRecord(via) || via.kind === "self";
	const property = rawText(input.property);
	const underItsProperty = rawText(input.name) === property;
	if (mode === "exact") {
		return (
			type !== "date" &&
			onOwnCase &&
			underItsProperty &&
			!CASE_NODE_ATTRIBUTE_PROPERTIES.has(property)
		);
	}
	if (mode === "range") return onOwnCase && underItsProperty;
	return false;
}

/**
 * Give one stored Predicate or value expression the unanswered reading of
 * `inputUuid`, in place: a `when-input-present` over it becomes `match-all`
 * (its clause applies only once the input is answered), and any other read
 * of it the blank literal. Whether anything changed.
 */
function blankInputReads(node: Json | undefined, inputUuid: string): boolean {
	if (Array.isArray(node)) {
		let changed = false;
		for (const item of node)
			changed = blankInputReads(item, inputUuid) || changed;
		return changed;
	}
	if (!isRecord(node)) return false;
	const writable = writableRecord(node);
	if (
		node.kind === "when-input-present" &&
		isRecord(node.input) &&
		node.input.searchInputUuid === inputUuid
	) {
		for (const key of Object.keys(writable)) delete writable[key];
		writable.kind = "match-all";
		return true;
	}
	if (node.kind === "input" && node.searchInputUuid === inputUuid) {
		delete writable.searchInputUuid;
		writable.kind = "literal";
		writable.value = "";
		return true;
	}
	let changed = false;
	for (const value of Object.values(node)) {
		changed = blankInputReads(value, inputUuid) || changed;
	}
	return changed;
}

/**
 * Write each `#search/<name>` read of `inputUuid` in one stored XPath
 * expression as the text `''`, every other part kept as it is. Whether
 * anything changed.
 */
function blankSearchAnswerReads(
	expression: unknown,
	inputUuid: string,
): boolean {
	const parts = isRecord(expression as Json)
		? (expression as JsonRecord).parts
		: undefined;
	if (!Array.isArray(parts)) return false;
	let changed = false;
	for (const part of parts) {
		if (
			!isRecord(part) ||
			part.kind !== "search-answer-ref" ||
			part.searchInputUuid !== inputUuid
		) {
			continue;
		}
		const writable = writableRecord(part);
		delete writable.searchInputUuid;
		writable.kind = "text";
		writable.text = "''";
		changed = true;
	}
	return changed;
}

/**
 * The menu's stored expressions that may read one of its inputs' answers:
 * the list's filter, each other input's match, required condition, check
 * rule and starting value, each calculated column's formula,
 * the assigned-cases expression, and the Search action's display condition.
 */
function menuExpressions(
	module: JsonRecord,
	config: JsonRecord,
	inputs: readonly JsonRecord[],
): Json[] {
	const expressions: (Json | undefined)[] = [config.filter];
	for (const input of inputs) {
		expressions.push(input.predicate, input.default);
		if (isRecord(input.required)) expressions.push(input.required.when);
		if (isRecord(input.validation)) expressions.push(input.validation.rule);
	}
	if (Array.isArray(config.columns)) {
		for (const column of config.columns) {
			if (isRecord(column) && column.kind === "calculated") {
				expressions.push(column.expression);
			}
		}
	}
	const search = module.caseSearchConfig;
	if (isRecord(search)) {
		expressions.push(search.excludedOwnerIds);
		if (!("searchActionEnabled" in search)) {
			expressions.push(search.searchButtonDisplayCondition);
		}
	}
	return expressions.filter((expression): expression is Json =>
		isRecord(expression),
	);
}

/** Remove `input` from the menu and blank every read of it; the count of expressions changed. */
function removeInput(
	document: RawDocument,
	moduleUuid: string,
	module: JsonRecord,
	config: JsonRecord,
	input: JsonRecord,
): number {
	const inputUuid = rawText(input.uuid);
	const kept = (config.searchInputs as readonly Json[]).filter(
		(candidate) => candidate !== input,
	);
	writableRecord(config).searchInputs = kept;
	let count = 0;
	for (const expression of menuExpressions(
		module,
		config,
		kept.filter(isRecord),
	)) {
		if (blankInputReads(expression, inputUuid)) count += 1;
	}
	for (const formUuid of document.formOrder[moduleUuid] ?? []) {
		for (const slot of formXPathSlots(document, formUuid)) {
			if (slot.carrier.kind !== "field") continue;
			if (blankSearchAnswerReads(slot.value, inputUuid)) count += 1;
		}
	}
	return count;
}

export const reservedSearchInputsStep: CutoverStep = {
	id: "reserved-search-inputs",
	apply(document) {
		const changes: DocumentChange[] = [];
		for (const moduleUuid of document.moduleOrder) {
			const module = document.modules[moduleUuid];
			const config = module?.caseListConfig;
			if (
				module === undefined ||
				!isRecord(config) ||
				!Array.isArray(config.searchInputs)
			) {
				continue;
			}
			const menu = rawText(module.name);
			for (const input of config.searchInputs.filter(isRecord)) {
				const name = rawText(input.name);
				if (
					!rawInputReachesHqAsOwnKey(input) ||
					!isReservedSearchInputName(name)
				) {
					continue;
				}
				const count = removeInput(document, moduleUuid, module, config, input);
				changes.push({
					reason: "search-input-removed",
					entity: {
						type: "searchInput",
						uuid: asUuid(rawText(input.uuid)),
						nameAtMigration: name,
					},
					detail: { menu, expressions: String(count) },
				});
			}
			const remaining = (config.searchInputs as readonly Json[]).filter(
				isRecord,
			);
			for (const input of remaining) {
				if (input.name !== XPATH_QUERY) continue;
				const to = suffixUntilFree(
					XPATH_QUERY,
					new Set(remaining.map((candidate) => rawText(candidate.name))),
				);
				writableRecord(input).name = to;
				changes.push({
					reason: "search-input-renamed",
					entity: {
						type: "searchInput",
						uuid: asUuid(rawText(input.uuid)),
						nameAtMigration: rawText(input.label) || to,
					},
					detail: { menu, from: XPATH_QUERY, to },
				});
			}
		}
		return changes;
	},
};
