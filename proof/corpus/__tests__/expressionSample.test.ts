/** A lost expression shape must fail the sample, not silently shrink its coverage. */
import * as fc from "fast-check";
import { expect, it } from "vitest";
import {
	EXPRESSION_SHAPES,
	expressionDocArbitrary,
	landedExpressionShapes,
} from "@/lib/commcare/__tests__/expressionDocArbitrary";
import { caseTypeDepthMap } from "@/lib/commcare/caseTypeDepths";
import { runValidation } from "@/lib/commcare/validator/runner";
import { formCasePropertyRead } from "@/lib/commcare/xform/formCaseRead";
import { formExpressionEmission } from "@/lib/commcare/xform/formExpressions";
import { toWire } from "@/lib/commcare/xpath/wire/fromExpression";
import { instantMicrosOperand } from "@/lib/commcare/xpath/wire/instant";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema, type Uuid } from "@/lib/domain";
import { slotContext } from "@/lib/domain/expression/context";
import {
	expressionContextAtPath,
	scalarDataType,
	typeOf,
} from "@/lib/domain/expression/typeChecker";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import { walkExpressionNodes } from "@/lib/domain/expression/walk";
import { formOfField } from "@/lib/domain/fieldForm";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";
import {
	DEFAULT_CORPUS_SEED,
	DEFAULT_EXPRESSION_SAMPLE_SIZE,
} from "../defaults";

const docs = fc.sample(expressionDocArbitrary, {
	seed: DEFAULT_CORPUS_SEED,
	numRuns: DEFAULT_EXPRESSION_SAMPLE_SIZE,
});

// This draw places a datetime plan beside a hidden sorted tile column. The
// plan needs another column because that hidden order rule cannot be calculated.
const hiddenTileColumnDoc = fc.sample(expressionDocArbitrary, {
	seed: DEFAULT_CORPUS_SEED + 1,
	numRuns: 32,
})[31];

it("lands every typed expression shape in the admitted fixed-seed sample", () => {
	const shapes = new Set<string>();
	for (const doc of docs) {
		for (const shape of landedExpressionShapes(doc)) shapes.add(shape);
		const parsed = blueprintDocSchema.parse(toPersistableDoc(doc));
		expect(
			runValidation(
				hydratePersistedBlueprint(parsed),
				LOOKUP_CONTEXT_UNAVAILABLE,
			),
		).toEqual([]);
	}
	expect([...shapes].sort()).toEqual([...EXPRESSION_SHAPES].sort());
	const tileParsed = blueprintDocSchema.parse(
		toPersistableDoc(hiddenTileColumnDoc),
	);
	expect(
		runValidation(
			hydratePersistedBlueprint(tileParsed),
			LOOKUP_CONTEXT_UNAVAILABLE,
		),
	).toEqual([]);
});

/** Every wire node of a tree, depth first. */
function wireNodes(wire: WireExpr): WireExpr[] {
	const found: WireExpr[] = [];
	const visit = (value: unknown): void => {
		if (typeof value !== "object" || value === null) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if ("k" in value) found.push(value as WireExpr);
		for (const child of Object.values(value)) visit(child);
	};
	visit(wire);
	return found;
}

/** A comparison of two moments as the device receives it: each side the
 * instant parse of an operand's text or a folded literal, at least one a
 * parse. Read from the tree's structure, never its text. */
function lowered(wire: WireExpr): boolean {
	if (wire.k !== "cmp") return false;
	const sides = [wire.left, wire.right];
	const parsed = sides.filter(
		(side) => instantMicrosOperand(side) !== undefined,
	).length;
	return (
		parsed > 0 && parsed + sides.filter((side) => side.k === "num").length === 2
	);
}

/** A form slot's expression as the XForm builder lowers it, the form's own
 * case read included. */
function formSlotWire(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	expression: Expression,
	slot: SlotContextRef,
): WireExpr {
	const formUuid = formOfField(doc, fieldUuid);
	const moduleUuid =
		formUuid === undefined
			? undefined
			: doc.moduleOrder.find((uuid) => doc.formOrder[uuid]?.includes(formUuid));
	if (formUuid === undefined || moduleUuid === undefined)
		throw new Error("A sampled form slot needs its form and module.");
	const moduleCaseType = doc.modules[moduleUuid]?.caseType;
	return formExpressionEmission(doc, formUuid, undefined, {
		formCaseProperty: formCasePropertyRead({
			formType: doc.forms[formUuid].type,
			caseTypeDepths: caseTypeDepthMap(moduleCaseType, doc.caseTypes ?? []),
			moduleCaseType,
		}),
	}).lower(expression, slot);
}

it("lowers the drawn datetime comparisons as instants over the typed reads", () => {
	const surfaces = new Set<string>();
	const operators = new Set<string>();
	let dateRecordFilters = 0;
	for (const doc of docs) {
		const owners = [
			...Object.values(doc.fields).map(({ uuid }) => ({
				entity: "field" as const,
				uuid,
			})),
			...Object.values(doc.modules).map(({ uuid }) => ({
				entity: "module" as const,
				uuid,
			})),
		];
		for (const owner of owners)
			for (const { ref, expression } of expressionSlotValues(doc, owner)) {
				const context = slotContext(doc, ref, new Map());
				if (context === undefined)
					throw new Error(
						"A sampled expression needs its actual slot context.",
					);
				let datetimeComparisons = 0;
				walkExpressionNodes(expression, (node, path) => {
					if (node.kind !== "eq" && node.kind !== "lt" && node.kind !== "gt")
						return;
					const scoped = expressionContextAtPath(expression, context, path);
					const operands = [node.left, node.right];
					const sourceTypes = operands.map((operand) =>
						scalarDataType(typeOf(operand, scoped)?.data),
					);
					if (!sourceTypes.includes("datetime")) {
						if (
							ref.entity === "module" &&
							sourceTypes.every((type) => type === "date")
						) {
							expect(ref.slot).toBe("case_list_filter");
							dateRecordFilters++;
						}
						return;
					}
					// The drawn reads compare as dates and times, with no day
					// coercion between them and the comparison.
					expect(sourceTypes).toEqual(["datetime", "datetime"]);
					for (const operand of operands)
						expect(operand.kind).not.toBe("date-coerce");
					if (ref.entity === "module")
						expect(ref.slot).toBe("case_list_column_expression");
					surfaces.add(ref.entity === "module" ? "record" : "form");
					operators.add(node.kind);
					datetimeComparisons++;
				});
				if (datetimeComparisons === 0) continue;
				// The slot as its device target emits it: each datetime comparison
				// is a lowered comparison, and none applies date() to its operands.
				const wire =
					ref.entity === "field"
						? formSlotWire(doc, ref.uuid, expression, ref)
						: toWire(expression, { target: "suite", types: context });
				const comparisons = wireNodes(wire).filter(lowered);
				expect(comparisons).toHaveLength(datetimeComparisons);
				for (const comparison of comparisons)
					expect(
						wireNodes(comparison).some(
							(node) => node.k === "call" && node.fn === "date",
						),
					).toBe(false);
			}
	}
	expect([...surfaces].sort()).toEqual(["form", "record"]);
	expect([...operators].sort()).toEqual(["eq", "gt", "lt"]);
	expect(dateRecordFilters).toBeGreaterThan(0);
});
