/**
 * Step 7, `lift-round-trip` (part 09 §5; part 02 §2.4): a guard. Every
 * expression slot of the target, whichever step wrote it or none, must
 * survive its own print, `parse(print(e)) = e`, under its slot's grammar
 * over the target, through the one function §10's postcondition runs over
 * the saved app (`roundTripFailuresOf`): form logic through the
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
import { formOfField } from "@/lib/domain/fieldForm";
import {
	type ExpressionCarrierRef,
	type ExpressionSlotValue,
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

/**
 * The record dialect's scope for a slot, as an SA read of its owner binds
 * names: the owner's form or module, then whatever the slot's key path from
 * the owner passes through (a cases choice source's row, a lookup source's
 * table), and a module's search validation slots with pattern matching, as
 * `getModule` reads them.
 */
function recordScope(
	doc: BlueprintDoc,
	ref: ExpressionSlotRef,
	path: readonly (string | number)[],
	index: RoundTripIndex,
): AuthoringScope {
	const owner =
		ref.entity === "module"
			? doc.modules[ref.uuid]
			: ref.entity === "form"
				? doc.forms[ref.uuid]
				: doc.fields[ref.uuid];
	return authoringValueScope(
		ownerScope(doc, ref, index.tables),
		owner,
		path,
		ref.entity === "module",
	);
}

function ownerScope(
	doc: BlueprintDoc,
	ref: ExpressionSlotRef,
	tables: AuthoringScopeOptions["tables"],
): AuthoringScopeOptions {
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

/**
 * What every slot of one document reads its lookup tables through, derived
 * once per document rather than once per slot.
 */
interface RoundTripIndex {
	readonly lookup: LookupDefinitionIndex;
	readonly types: LookupTypeIndex;
	readonly tables: AuthoringScopeOptions["tables"];
}

function roundTripIndexOf(lookup: LookupDefinitionIndex): RoundTripIndex {
	return {
		lookup,
		types: lookupTypes(lookup),
		tables: [...lookup.values()] as unknown as AuthoringScopeOptions["tables"],
	};
}

/**
 * Whether a slot's tree reads back to itself through its own grammar: the
 * form-XPath print and parser for a form-logic slot, the record dialect for
 * a record one, chosen by the slot's profile.
 */
export function expressionSurvives(
	doc: BlueprintDoc,
	value: ExpressionSlotValue,
	lookup: LookupDefinitionIndex,
	print: RoundTripPrint = printFormLogic,
): { readonly ok: boolean; readonly text?: string } {
	return survives(doc, value, roundTripIndexOf(lookup), print);
}

function survives(
	doc: BlueprintDoc,
	{ ref, expression, path }: ExpressionSlotValue,
	index: RoundTripIndex,
	print: RoundTripPrint,
): { readonly ok: boolean; readonly text?: string } {
	const { lookup } = index;
	const profile = slotContext(doc, ref, index.types)?.profile;
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
		const scope = recordScope(doc, ref, path, index);
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

/** One stored expression that does not survive its own print. */
export interface RoundTripFailure {
	readonly owner: ExpressionCarrierRef;
	readonly ref: ExpressionSlotRef;
	readonly text?: string;
}

/**
 * Every stored expression of a document that does not survive its own
 * print, every slot of the head registry read: the one law step 7 holds a
 * target to and §10's postcondition holds a saved app to.
 */
export function roundTripFailuresOf(
	doc: BlueprintDoc,
	lookup: LookupDefinitionIndex,
	print: RoundTripPrint = printFormLogic,
): RoundTripFailure[] {
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
	const index = roundTripIndexOf(lookup);
	const failures: RoundTripFailure[] = [];
	for (const owner of owners)
		for (const value of expressionSlotValues(doc, owner)) {
			const result = survives(doc, value, index, print);
			if (!result.ok)
				failures.push({
					owner,
					ref: value.ref,
					...(result.text === undefined ? {} : { text: result.text }),
				});
		}
	return failures;
}

/** §10's postcondition over a saved app: how many stored expressions do not survive their own print. */
export function roundTripFailures(
	doc: BlueprintDoc,
	options: { readonly lookup: LookupValidationContext },
): number {
	const definitions = lookupExpressionDefinitions(options.lookup);
	return roundTripFailuresOf(
		doc,
		definitions === "unavailable" ? new Map() : definitions,
	).length;
}

/**
 * The guard, with the print it holds each tree to (a test injects a faulty
 * one): the postcondition's own law over the whole target, so a value the
 * writer would refuse is a blocker here first.
 */
export function liftRoundTripStep(
	print: RoundTripPrint = printFormLogic,
): ExpressionsStep {
	return {
		id: "lift-round-trip",
		apply(doc, ctx) {
			const target = doc.target();
			if (!target.ok)
				return { changes: [], blockers: [], classes: [], places: [] };
			const places: BlockerPlace[] = roundTripFailuresOf(
				target.doc,
				ctx.lookup,
				print,
			).map((failure) => ({
				code: "round-trip",
				entity: { kind: failure.owner.entity, uuid: failure.owner.uuid },
				slot: failure.ref.slot,
				...(failure.text === undefined ? {} : { text: failure.text }),
			}));
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
