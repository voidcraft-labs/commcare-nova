/**
 * The record dialect's law as a function: parsing a print gives back the
 * stored tree. Authoring keeps the law because every stored tree came through
 * the parser; a tree read from an app made in CommCare HQ did not, so the
 * reader of such apps is handed this judge and holds no record slot it
 * refuses. A slot every read tool prints (`output.ts`) is then a slot every
 * read can print.
 */
import type { RecordDialectJudge } from "@/lib/commcare/reader/expressions";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { expressionChildren } from "@/lib/domain/expression/children";
import {
	type LookupDefinitionIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import {
	type Expression,
	type ExpressionSlotRef,
	isExpression,
	type SlotContextRef,
	type Term,
} from "@/lib/domain/expression/types";
import { caseWriteKeyOf, sameCaseWriteKey } from "@/lib/domain/forms";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import {
	type AuthoringScope,
	type AuthoringScopeOptions,
	authoringValueScope,
	readScopeOptions,
} from "./bindings";
import { queryPrinter } from "./printQueryExpression";
import { parseQueryPredicate, parseQueryValue } from "./queryExpressions";

/** Where a read tool hands a record slot to the printer: the stored value it
 *  projects, the path of the slot inside it, and whether the read is a
 *  menu's (`getModule`, which prints a Search field's conditions with
 *  pattern matching). `authoringValueScope` reads the candidate case type
 *  and the table from the objects along the path. */
interface ReadSite {
	readonly options: AuthoringScopeOptions;
	readonly source: unknown;
	readonly path: readonly (string | number)[];
	readonly searchValidation: boolean;
}

/** A form's slot as `getForm` reads it: the form, the slot's path in it. */
function formReadSite(
	doc: BlueprintDoc,
	tables: readonly LookupTableDefinition[],
	ref: Extract<ExpressionSlotRef, { entity: "form" }>,
): ReadSite | undefined {
	const form = doc.forms[ref.uuid];
	if (form === undefined) return undefined;
	const site = (path: readonly (string | number)[]): ReadSite => ({
		options: readScopeOptions(doc, tables, ref.uuid),
		source: form,
		path,
		searchValidation: false,
	});
	if (ref.slot === "form_display_condition") return site(["displayCondition"]);
	if (!("member" in ref) || !("operationUuid" in ref.member)) return undefined;
	const member = ref.member;
	const operations = form.caseOperations ?? [];
	const index = operations.findIndex(
		(operation) => operation.uuid === member.operationUuid,
	);
	const operation = operations[index];
	if (operation === undefined) return undefined;
	const at = ["caseOperations", index] as const;
	switch (ref.slot) {
		case "case_operation_target_expression":
			return site([...at, "target", "expr"]);
		case "case_operation_condition":
			return site([...at, "condition"]);
		case "case_operation_name":
			return site([...at, "name"]);
		case "case_operation_owner":
			return site([...at, "owner"]);
		case "case_operation_rename":
			return site([...at, "rename"]);
		case "case_operation_write_value":
		case "case_operation_write_condition": {
			if (!("property" in member)) return undefined;
			const write = (operation.writes ?? []).findIndex((candidate) =>
				sameCaseWriteKey(caseWriteKeyOf(candidate), {
					property: member.property,
					...(member.via === undefined ? {} : { via: [...member.via] }),
				}),
			);
			if (write < 0) return undefined;
			return site([
				...at,
				"writes",
				write,
				ref.slot === "case_operation_write_value" ? "value" : "condition",
			]);
		}
		case "case_operation_link_target_expression": {
			if (!("identifier" in member)) return undefined;
			const link = (operation.links ?? []).findIndex(
				(candidate) => candidate.identifier === member.identifier,
			);
			if (link < 0) return undefined;
			return site([...at, "links", link, "target", "expr"]);
		}
	}
	return undefined;
}

/** A menu's slot as `getModule` reads it: the display condition alone, the
 *  case list's configuration or the search's, each with the slot's path in
 *  it. */
function moduleReadSite(
	doc: BlueprintDoc,
	tables: readonly LookupTableDefinition[],
	ref: Extract<ExpressionSlotRef, { entity: "module" }>,
): ReadSite | undefined {
	const module = doc.modules[ref.uuid];
	if (module === undefined) return undefined;
	const options = readScopeOptions(doc, tables, undefined, ref.uuid);
	const site = (
		source: unknown,
		path: readonly (string | number)[],
	): ReadSite => ({ options, source, path, searchValidation: true });
	const list = module.caseListConfig;
	const search = module.caseSearchConfig;
	switch (ref.slot) {
		case "module_display_condition":
			return site(module.displayCondition, []);
		case "case_list_filter":
			return site(list, ["filter"]);
		case "search_button_display_condition":
			return site(search, ["searchButtonDisplayCondition"]);
		case "excluded_owner_ids":
			return site(search, ["excludedOwnerIds"]);
		case "case_list_sort_expression": {
			const index =
				list?.calculatedSorts?.findIndex(
					(rule) => rule.uuid === ref.member.sortUuid,
				) ?? -1;
			return index < 0
				? undefined
				: site(list, ["calculatedSorts", index, "expression"]);
		}
		case "case_list_column_expression": {
			const column = (list?.columns ?? []).findIndex(
				(candidate) => candidate.uuid === ref.member.columnUuid,
			);
			return column < 0
				? undefined
				: site(list, ["columns", column, "expression"]);
		}
	}
	const input = (list?.searchInputs ?? []).findIndex(
		(candidate) => candidate.uuid === ref.member.searchInputUuid,
	);
	if (input < 0) return undefined;
	const at = ["searchInputs", input] as const;
	switch (ref.slot) {
		case "search_input_default":
			return site(list, [...at, "default"]);
		case "search_input_predicate":
			return site(list, [...at, "predicate"]);
		case "search_input_options":
			return site(list, [...at, "options", "filter"]);
		case "search_input_required_when":
			return site(list, [...at, "required", "when"]);
		case "search_input_validation_rule":
			return site(list, [...at, "validation", "rule"]);
		case "search_input_hidden_value":
			return site(list, [...at, "value"]);
	}
	return undefined;
}

/** Where a read tool prints a record slot, or undefined for a slot no read
 *  prints in the record dialect. A field's record slot is its choices'
 *  filter, which `getField` and `getForm` print over the field under its
 *  form's scope. */
function readSite(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	tables: readonly LookupTableDefinition[],
): ReadSite | undefined {
	if (ref.entity === "form") return formReadSite(doc, tables, ref);
	if (ref.entity === "module") return moduleReadSite(doc, tables, ref);
	if (ref.slot !== "lookup_options_source") return undefined;
	const field = doc.fields[ref.uuid];
	if (field === undefined) return undefined;
	return {
		options: readScopeOptions(doc, tables, findContainingForm(doc, ref.uuid)),
		source: field,
		path: ["optionsSource", "filter"],
		searchValidation: false,
	};
}

/** The slot's own authoring scope: the one a read tool prints it under
 *  (`output.ts::authoringEncoders`, through `authoringValueScope` at the
 *  slot's place in what the read projects), which an edit tool parses it
 *  under too. Undefined for a slot no read prints in the record dialect. */
export function recordSlotScope(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	lookup: LookupDefinitionIndex,
): AuthoringScope | undefined {
	const tables = [...lookup.values()] as unknown as LookupTableDefinition[];
	const site = readSite(doc, ref, tables);
	return site === undefined
		? undefined
		: authoringValueScope(
				site.options,
				site.source,
				site.path,
				site.searchValidation,
			);
}

/** Deep equality of two stored trees, key order aside; an absent key and an
 *  undefined one are one. */
function sameTree(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
			return false;
		return a.every((item, index) => sameTree(item, b[index]));
	}
	if (
		typeof a !== "object" ||
		typeof b !== "object" ||
		a === null ||
		b === null
	)
		return false;
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = new Set(
		[...Object.keys(left), ...Object.keys(right)].filter(
			(key) => left[key] !== undefined || right[key] !== undefined,
		),
	);
	for (const key of keys) if (!sameTree(left[key], right[key])) return false;
	return true;
}

type Printer = ReturnType<typeof queryPrinter>;

/** Whether the printer spells one node in some position: a leaf as a
 *  reference, any other node as a condition or a value. */
function spells(printer: Printer, node: Expression | Term): boolean {
	const attempts: (() => string)[] = !isExpression(node)
		? [() => printer.term(node)]
		: node.kind === "term"
			? [() => printer.term(node.term)]
			: [() => printer.predicate(node), () => printer.value(node)];
	return attempts.some((attempt) => {
		try {
			attempt();
			return true;
		} catch {
			return false;
		}
	});
}

/** The kind of the first node, innermost first, the printer has no spelling
 *  for while it spells every node below it: read from the tree, by asking the
 *  printer of each node. */
function unspelledKind(printer: Printer, tree: Expression): string | undefined {
	const visit = (node: Expression | Term): string | undefined => {
		for (const child of expressionChildren(node)) {
			if (child.kind === "relation") continue;
			const found = visit(child.value);
			if (found !== undefined) return found;
		}
		if (spells(printer, node)) return undefined;
		return isExpression(node) && node.kind === "term"
			? node.term.kind
			: node.kind;
	};
	return visit(tree);
}

/** Undefined where `queryPrinter` prints the slot's tree under the slot's own
 *  authoring scope and `parseQueryPredicate` or `parseQueryValue` reads the
 *  print back to a tree deep-equal to it. Otherwise the kind the printer has
 *  no spelling for, or `"round-trip"` where the trees differ. */
export const recordDialectRoundTrip: RecordDialectJudge = (
	doc,
	ref,
	expression,
	lookup,
) => {
	const scope = recordSlotScope(doc, ref, lookup);
	if (scope === undefined) return "round-trip";
	const printer = queryPrinter(scope);
	const types = new Map(
		[...lookup.values()].map((table) => [
			table.id,
			new Map(table.columns.map((column) => [column.id, column.dataType])),
		]),
	);
	const condition =
		slotContext(doc, ref, types)?.profile.expectation.kind === "condition";
	let text: string;
	try {
		text = condition
			? printer.predicate(expression)
			: printer.value(expression);
	} catch {
		return unspelledKind(printer, expression) ?? "round-trip";
	}
	let read: Expression;
	try {
		read = condition
			? parseQueryPredicate(text, scope)
			: parseQueryValue(text, scope);
	} catch {
		return "round-trip";
	}
	return sameTree(read, expression) ? undefined : "round-trip";
};
