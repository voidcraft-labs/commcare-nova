/** Pure path classification controlling the snapshot conversion, not a runtime proof.
 * Core snapshot conversion is exercised by ContainerRuntimeTest. */

import { describe, expect, it } from "vitest";
import { isCountReferencePath } from "@/lib/commcare/xform/countReference";

describe("isCountReferencePath — count carrier classifier", () => {
	// Inputs the emitter sees are already hashtag-expanded, so `#form/x`
	// arrives here as `/data/x`. We still spot-check the expanded forms.
	const directCases: ReadonlyArray<[label: string, expr: string]> = [
		["absolute child path", "/data/x"],
		["expanded #form path", "/data/desired_count"],
		["expanded #case path", "/data/case_count"],
		[
			"casedb instance walk",
			"instance('casedb')/casedb/case[@case_id='abc']/prop",
		],
		["relative step", "x"],
		["attribute step", "@count"],
		["self step", "."],
		["parent step", ".."],
		["path with predicate (Filtered over a path)", "/data/items[1]"],
		["axis-specified step", "child::item"],
	];

	const expressionCases: ReadonlyArray<[label: string, expr: string]> = [
		["integer literal", "5"],
		["addition expression", "3 + 2"],
		["count() function call", "count(/data/items)"],
		["if() function call", "if(a, b, c)"],
		["string-length() function call", "string-length(x)"],
		["empty string literal", "''"],
		["string literal", "'three'"],
		["parenthesized path (bare FilterExpr in JavaRosa)", "(/data/x)"],
		["filtered function call (Filtered over Invoke)", "count(/data/x)[1]"],
		["union of paths", "/data/a | /data/b"],
		["variable reference", "$count"],
		["multiplication", "2 * 3"],
		["empty string", ""],
		["whitespace only", "   "],
	];

	for (const [label, expr] of directCases) {
		it(`classifies ${label} as a direct path`, () => {
			expect(isCountReferencePath(expr)).toBe(true);
		});
	}

	for (const [label, expr] of expressionCases) {
		it(`classifies ${label} as an expression`, () => {
			expect(isCountReferencePath(expr)).toBe(false);
		});
	}
});
