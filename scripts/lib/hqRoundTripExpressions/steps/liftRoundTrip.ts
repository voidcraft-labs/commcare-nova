/**
 * Step 7, `lift-round-trip` (part 09 §5; part 02 §2.4): a guard. Every slot
 * steps 3 to 6 wrote must survive its own print, `parse(print(e)) = e`,
 * under its slot's grammar over the target: form logic through the
 * canonical form-XPath print and the production parser (no `current` tree,
 * as the lift parsed it), a record value through the record dialect's
 * printer and compiler. A tree that does not is `round-trip`, a defect of
 * the stack, never an author's. `record-position` and
 * `SELECT_DEFAULT_NOT_AN_OPTION` are the checker's, so the gate after the
 * last step reruns them over every slot (`target-gate`).
 */

import {
	type AuthoringScope,
	type AuthoringScopeOptions,
	authoringValueScope,
} from "@/lib/agent/authoring/bindings";
import { queryPrinter } from "@/lib/agent/authoring/printQueryExpression";
import {
	parseQueryPredicate,
	parseQueryValue,
} from "@/lib/agent/authoring/queryExpressions";
import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import { projectFormExpression } from "@/lib/doc/expressionText";
import { lookupExpressionDefinitions } from "@/lib/doc/lookupExpressionContext";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { moduleUuidOfForm } from "@/lib/domain";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	type LookupDefinitionIndex,
	type LookupTypeIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import type {
	Expression,
	ExpressionSlotRef,
} from "@/lib/domain/expression/types";
import {
	type ExpressionCarrierRef,
	expressionSlotValues,
} from "@/lib/domain/referenceSlots";
import type { Uuid } from "@/lib/domain/uuid";
import { canonicalJsonText } from "@/lib/utils/canonicalJson";
import type { BlockerPlace, ExpressionsStep } from "../types";

/** A grammar's print of a tree in its slot, for the guard. */
export type RoundTripPrint = (
	doc: BlueprintDoc,
	slot: ExpressionSlotRef,
	expression: Expression,
	lookup: LookupDefinitionIndex,
) => string | undefined;

/** The canonical form-XPath print, or undefined where an identity is gone. */
export const printFormLogic: RoundTripPrint = (
	doc,
	slot,
	expression,
	lookup,
) => {
	const projection = projectFormExpression(doc, slot, expression, lookup);
	return projection.unresolved.length === 0 ? projection.text : undefined;
};

/** Where `value` sits inside `holder`, by identity; the walk an SA read's scope takes. */
function pathTo(
	holder: unknown,
	value: unknown,
): (string | number)[] | undefined {
	if (holder === value) return [];
	if (holder === null || typeof holder !== "object") return undefined;
	for (const [key, child] of Object.entries(holder)) {
		const rest = pathTo(child, value);
		if (rest !== undefined)
			return [Array.isArray(holder) ? Number(key) : key, ...rest];
	}
	return undefined;
}

/**
 * The record dialect's scope for a slot, as an SA read of its owner binds
 * names: the owner's form or module, then whatever the path to the value
 * passes through (a cases choice source's row, a lookup source's table).
 */
function recordScope(
	doc: BlueprintDoc,
	ref: ExpressionSlotRef,
	lookup: LookupDefinitionIndex,
	expression: Expression,
): AuthoringScope {
	const owner =
		ref.entity === "module"
			? doc.modules[ref.uuid]
			: ref.entity === "form"
				? doc.forms[ref.uuid]
				: doc.fields[ref.uuid];
	const path = pathTo(owner, expression) ?? [];
	return authoringValueScope(ownerScope(doc, ref, lookup), owner, path);
}

function ownerScope(
	doc: BlueprintDoc,
	ref: ExpressionSlotRef,
	lookup: LookupDefinitionIndex,
): AuthoringScopeOptions {
	const tables = [
		...lookup.values(),
	] as unknown as AuthoringScopeOptions["tables"];
	if (ref.entity === "module")
		return {
			doc,
			moduleUuid: ref.uuid,
			currentCaseType: doc.modules[ref.uuid]?.caseType,
			tables,
		};
	const formUuid =
		ref.entity === "form" ? ref.uuid : formOfField(doc, ref.uuid);
	const moduleUuid =
		formUuid === undefined ? undefined : moduleUuidOfForm(doc, formUuid);
	const form = formUuid === undefined ? undefined : doc.forms[formUuid];
	return {
		doc,
		...(formUuid === undefined ? {} : { formUuid }),
		...(moduleUuid === undefined ? {} : { moduleUuid }),
		currentCaseType:
			(form?.type === "followup" || form?.type === "close") && moduleUuid
				? doc.modules[moduleUuid]?.caseType
				: undefined,
		operations: (form?.caseOperations ?? []).map((operation) => ({
			uuid: operation.uuid,
			name: operation.id,
		})),
		tables,
	};
}

function formOfField(doc: BlueprintDoc, field: Uuid): Uuid | undefined {
	const seen = new Set<string>();
	let cursor: Uuid | undefined = doc.fieldParent[field];
	while (cursor !== undefined && !seen.has(cursor)) {
		if (Object.hasOwn(doc.forms, cursor)) return cursor;
		seen.add(cursor);
		cursor = doc.fieldParent[cursor];
	}
	return undefined;
}

/**
 * Whether a slot's tree reads back to itself through its own grammar: the
 * form-XPath print and parser for a form-logic slot, the record dialect for
 * a record one, chosen by the slot's profile.
 */
export function expressionSurvives(
	doc: BlueprintDoc,
	ref: ExpressionSlotRef,
	expression: Expression,
	lookup: LookupDefinitionIndex,
	print: RoundTripPrint = printFormLogic,
): { readonly ok: boolean; readonly text?: string } {
	const profile = slotContext(doc, ref, lookupTypes(lookup))?.profile;
	if (profile === undefined) return { ok: false };
	if (profile.ruleSet === "form") {
		const text = print(doc, ref, expression, lookup);
		if (text === undefined) return { ok: false };
		const parsed = parseFormExpression(text, { doc, slot: ref, lookup });
		return {
			ok:
				parsed.ok &&
				parsed.expression !== undefined &&
				canonicalJsonText(parsed.expression) === canonicalJsonText(expression),
			text,
		};
	}
	const condition = profile.expectation.kind === "condition";
	try {
		const scope = recordScope(doc, ref, lookup, expression);
		const printer = queryPrinter(scope);
		const text = condition
			? printer.predicate(expression)
			: printer.value(expression);
		const parsed = condition
			? parseQueryPredicate(text, scope)
			: parseQueryValue(text, scope);
		return {
			ok: canonicalJsonText(parsed) === canonicalJsonText(expression),
			text,
		};
	} catch {
		return { ok: false };
	}
}

function lookupTypes(lookup: LookupDefinitionIndex): LookupTypeIndex {
	return new Map(
		[...lookup.values()].map((table) => [
			table.id,
			new Map(
				table.columns.map((column) => [column.id, column.dataType] as const),
			),
		]),
	);
}

/**
 * §10's postcondition over a saved app: how many stored expressions do not
 * survive their own print, every slot of the head registry read.
 */
export function roundTripFailures(
	doc: BlueprintDoc,
	options: { readonly lookup: LookupValidationContext },
): number {
	const definitions = lookupExpressionDefinitions(options.lookup);
	const lookup = definitions === "unavailable" ? new Map() : definitions;
	let failures = 0;
	const owners: ExpressionCarrierRef[] = [
		...Object.keys(doc.modules).map((uuid) => ({
			entity: "module" as const,
			uuid: uuid as Uuid,
		})),
		...Object.keys(doc.forms).map((uuid) => ({
			entity: "form" as const,
			uuid: uuid as Uuid,
		})),
		...Object.keys(doc.fields).map((uuid) => ({
			entity: "field" as const,
			uuid: uuid as Uuid,
		})),
	];
	for (const owner of owners)
		for (const { ref, expression } of expressionSlotValues(doc, owner))
			if (!expressionSurvives(doc, ref, expression, lookup).ok) failures += 1;
	return failures;
}

/** The guard, with the print it holds each tree to (a test injects a faulty one). */
export function liftRoundTripStep(
	print: RoundTripPrint = printFormLogic,
): ExpressionsStep {
	return {
		id: "lift-round-trip",
		apply(doc, ctx) {
			const target = doc.target();
			if (!target.ok)
				return { changes: [], blockers: [], classes: [], places: [] };
			const places: BlockerPlace[] = [];
			for (const slot of doc.slots()) {
				if (slot.lifted === false || slot.lifted.value === undefined) continue;
				if (
					![
						"record-expressions",
						"form-logic-lift",
						"declare-read-properties",
						"repeat-read-first-row",
					].some((step) => slot.writtenBy.has(step as never))
				)
					continue;
				const result = expressionSurvives(
					target.doc,
					slot.ref,
					slot.lifted.value,
					ctx.lookup,
					print,
				);
				if (!result.ok)
					places.push({
						code: "round-trip",
						entity: { kind: slot.owner.entity, uuid: slot.owner.uuid },
						slot: slot.ref.slot,
						...(result.text === undefined ? {} : { text: result.text }),
					});
			}
			return {
				changes: [],
				blockers:
					places.length === 0
						? []
						: [{ code: "round-trip", count: places.length, findingCodes: [] }],
				classes: [],
				places,
			};
		},
	};
}
