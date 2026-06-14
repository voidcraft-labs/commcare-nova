/**
 * The expression round-trip law: `print(parse(s)) === s` BYTE-IDENTICAL
 * for every input string, over an unrenamed doc. This is the
 * migration-safety oracle — a stored expression converts to its AST
 * only because printing that AST provably reproduces the original
 * bytes, so the representation change touches zero wire bytes.
 *
 * Three layers:
 *   1. a curated corpus of every reference spelling, whitespace shape,
 *      quoting style, and known-degenerate input,
 *   2. a fast-check fuzz over grammar-shaped composites (refs +
 *      operators + literals + predicates + gratuitous whitespace),
 *   3. a fuzz over arbitrary unicode strings (the law holds for inputs
 *      the grammar rejects too — they parse to one opaque text run).
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	fieldPathResolver,
	printXPath,
	type XPathPrintableDoc,
	xpathPrintContext,
} from "@/lib/domain";
import { parseXPathExpression } from "../expressionAst";

const FORM = "form-1";

/** A form with a top-level field, a group with a nested field, and a
 *  sibling-of-group leaf — enough structure for every resolution
 *  shape (top-level, nested, dangling, prefix-only). */
const doc: XPathPrintableDoc = {
	forms: { [FORM]: {} },
	fields: {
		"f-age": { id: "age" },
		"f-grp": { id: "grp" },
		"f-inner": { id: "inner" },
		"f-name": { id: "name" },
	},
	fieldOrder: {
		[FORM]: ["f-age", "f-grp", "f-name"],
		"f-grp": ["f-inner"],
	},
};

const resolve = fieldPathResolver(doc, FORM);
const printCtx = () => xpathPrintContext(doc);

function roundTrip(source: string): string {
	return printXPath(parseXPathExpression(source, resolve), printCtx());
}

const CORPUS: string[] = [
	"",
	"#form/age",
	"#form/grp/inner",
	"#form/gone",
	"#form/grp/gone",
	"#form/gone/inner",
	"/data/age",
	"/data/grp/inner",
	"/data/gone",
	"/data/grp",
	"/data",
	"//data//age",
	"/ data / grp / inner",
	"/data/age + /data/grp/inner",
	"#mother/age",
	"#mother/age/extra",
	"#case/age",
	"#case/parent/age",
	"#case/case_id",
	"#user/role",
	"#user/role/extra",
	"today() - #form/age > 7",
	"if(#form/age >= 18, 'adult', \"minor\")",
	"concat('#form/age', \"/data/age\")",
	"count(/data/grp) > 0 and #form/name != ''",
	"/data/grp[1]/inner",
	"/data/grp[#form/age > 2]/inner",
	"  #form/age  ",
	"#form/age+#form/grp/inner",
	"not(selected(#form/name, 'x'))",
	"../age",
	"./age",
	"string-length(#form/name) > 0",
	"date('2024-01-01') < today()",
	"3.14 * .5",
	"$var + 1",
	"child::age",
	"@attr",
	"instance('casedb')/casedb/case[@case_id = #form/age]/name",
	"if(", // broken — stays opaque
	"((",
	"'unterminated",
	"#form/",
	"#form",
	"# form/age",
	"#form /age",
	"#form/ age",
	"a | b",
	"-#form/age",
	"/data/age[1]",
];

describe("expression round-trip law", () => {
	it("holds over the curated corpus", () => {
		for (const source of CORPUS) {
			expect(roundTrip(source)).toBe(source);
		}
	});

	it("holds over grammar-shaped composites", () => {
		const ref = fc.constantFrom(
			"#form/age",
			"#form/grp/inner",
			"#form/gone",
			"#mother/age",
			"#case/age",
			"#user/role",
			"/data/age",
			"/data/grp/inner",
			"/data/gone",
			"/ data /grp/ inner",
			"//data/age",
		);
		const atom = fc.oneof(
			ref,
			fc.constantFrom(
				"1",
				"3.14",
				"'text'",
				'"two words"',
				"today()",
				"$v",
				"../sibling",
				".",
				"random_node",
			),
		);
		const ws = fc.constantFrom("", " ", "  ", "\n", "\t ");
		const op = fc.constantFrom(
			"+",
			"-",
			"*",
			"div",
			"mod",
			"=",
			"!=",
			"<",
			">=",
			"and",
			"or",
			"|",
		);
		const binary = fc
			.tuple(atom, ws, op, ws, atom)
			.map(([a, w1, o, w2, b]) => `${a}${w1} ${o} ${w2}${b}`);
		const call = fc
			.tuple(fc.constantFrom("if", "concat", "count", "not"), atom, binary)
			.map(([fn, a, b]) => `${fn}(${a}, ${b})`);
		const predicated = fc.tuple(ref, binary).map(([r, p]) => `${r}[${p}]`);
		const expr = fc.oneof(atom, binary, call, predicated);
		const composite = fc
			.tuple(ws, expr, ws)
			.map(([lead, e, trail]) => `${lead}${e}${trail}`);

		fc.assert(
			fc.property(composite, (source) => {
				expect(roundTrip(source)).toBe(source);
			}),
			{ numRuns: 500, seed: 20260611 },
		);
	});

	it("holds over arbitrary strings (opaque passthrough included)", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 80 }), (source) => {
				expect(roundTrip(source)).toBe(source);
			}),
			{ numRuns: 500, seed: 20260611 },
		);
	});
});
