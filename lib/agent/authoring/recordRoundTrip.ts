/**
 * The record dialect's law as a function: parsing a print gives back the
 * stored tree. Authoring keeps the law because every stored tree came through
 * the parser; a tree read from an app made in CommCare HQ did not, so the
 * reader of such apps is handed this judge and holds no record slot it
 * refuses. A slot every read tool prints (`output.ts`) is then a slot every
 * read can print.
 */
import type { RecordDialectJudge } from "@/lib/commcare/reader/expressions";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { expressionChildren } from "@/lib/domain/expression/children";
import {
	type LookupDefinitionIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import {
	type Expression,
	isExpression,
	type SlotContextRef,
	type Term,
} from "@/lib/domain/expression/types";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import { AuthoringScope, type AuthoringScopeOptions } from "./bindings";
import { queryPrinter } from "./printQueryExpression";
import { parseQueryPredicate, parseQueryValue } from "./queryExpressions";

/** The slot's own authoring scope: the one a read tool prints it under and
 *  an edit tool parses it under. */
function slotScope(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	lookup: LookupDefinitionIndex,
): AuthoringScope {
	const tables = [...lookup.values()] as unknown as LookupTableDefinition[];
	const formUuid = ref.entity === "form" ? ref.uuid : undefined;
	const moduleUuid =
		ref.entity === "module"
			? ref.uuid
			: formUuid === undefined
				? undefined
				: moduleUuidOfForm(doc, formUuid);
	const options: AuthoringScopeOptions = {
		doc,
		tables,
		...(formUuid === undefined ? {} : { formUuid }),
		...(moduleUuid === undefined ? {} : { moduleUuid }),
		currentCaseType:
			moduleUuid === undefined ? undefined : doc.modules[moduleUuid]?.caseType,
		...(formUuid === undefined
			? {}
			: {
					operations: (doc.forms[formUuid]?.caseOperations ?? []).map(
						(operation) => ({ uuid: operation.uuid, name: operation.id }),
					),
				}),
		...(ref.slot === "search_input_required_when" ||
		ref.slot === "search_input_validation_rule"
			? { patternMatching: true as const }
			: {}),
		...(ref.entity === "module" && ref.slot === "search_input_options"
			? { tableId: searchInputTable(doc, ref) }
			: {}),
	};
	return new AuthoringScope(options);
}

/** The table a Search field's choices come from, whose rows its filter reads. */
function searchInputTable(
	doc: BlueprintDoc,
	ref: Extract<SlotContextRef, { entity: "module" }>,
): string | undefined {
	if (!("member" in ref) || !("searchInputUuid" in ref.member))
		return undefined;
	const memberUuid = ref.member.searchInputUuid;
	const input = doc.modules[ref.uuid]?.caseListConfig?.searchInputs.find(
		(candidate) => candidate.uuid === memberUuid,
	);
	const options =
		input !== undefined && "options" in input
			? (input.options as { tableId?: string } | undefined)
			: undefined;
	return options?.tableId;
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
	const scope = slotScope(doc, ref, lookup);
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
