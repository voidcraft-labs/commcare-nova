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
import {
	DEFAULT_CORPUS_SEED,
	DEFAULT_EXPRESSION_SAMPLE_SIZE,
} from "../defaults";

it("lands every typed expression shape in the admitted fixed-seed sample", () => {
	const shapes = new Set<string>();
	const docs = fc.sample(expressionDocArbitrary, {
		seed: DEFAULT_CORPUS_SEED,
		numRuns: DEFAULT_EXPRESSION_SAMPLE_SIZE,
	});
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
});
