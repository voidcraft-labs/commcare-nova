/** A lost expression shape must fail the sample, not silently shrink its coverage. */
import * as fc from "fast-check";
import { expect, it } from "vitest";
import {
	EXPRESSION_SHAPES,
	expressionDocArbitrary,
	landedExpressionShapes,
} from "@/lib/commcare/__tests__/expressionDocArbitrary";
import { runValidation } from "@/lib/commcare/validator/runner";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import { slotContext } from "@/lib/domain/expression/context";
import {
	expressionContextAtPath,
	scalarDataType,
	typeOf,
} from "@/lib/domain/expression/typeChecker";
import { walkExpressionNodes } from "@/lib/domain/expression/walk";
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

it("stages datetime comparisons as explicit days while preserving the typed reads", () => {
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
				walkExpressionNodes(expression, (node, path) => {
					if (node.kind !== "eq" && node.kind !== "lt" && node.kind !== "gt")
						return;
					const scoped = expressionContextAtPath(expression, context, path);
					const operands = [node.left, node.right];
					const sourceTypes = operands.map((operand) =>
						scalarDataType(
							typeOf(
								operand.kind === "date-coerce" ? operand.value : operand,
								scoped,
							)?.data,
						),
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
					// Removing either coercion must fail even while PR5 admits the
					// underlying datetime comparison; changing the source type fails too.
					expect(sourceTypes).toEqual(["datetime", "datetime"]);
					expect(operands.map((operand) => operand.kind)).toEqual([
						"date-coerce",
						"date-coerce",
					]);
					expect(
						operands.map((operand) =>
							scalarDataType(typeOf(operand, scoped)?.data),
						),
					).toEqual(["date", "date"]);
					if (ref.entity === "module")
						expect(ref.slot).toBe("case_list_column_expression");
					surfaces.add(ref.entity === "module" ? "record" : "form");
					operators.add(node.kind);
				});
			}
	}
	expect([...surfaces].sort()).toEqual(["form", "record"]);
	expect([...operators].sort()).toEqual(["eq", "gt", "lt"]);
	expect(dateRecordFilters).toBeGreaterThan(0);
});
