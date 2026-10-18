import type { SyntaxNode } from "@lezer/common";
import { decodeHTML } from "entities";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluate } from "@/lib/preview/xpath/evaluator";
import type { EvalContext } from "@/lib/preview/xpath/types";
import { keyAsVariable } from "../../../suite/case-list/keyVariable";
import { parser } from "../../parser";
import { w } from "../builders";
import { caseDbInstance, sessionInstance } from "../instances";
import { serializeWire } from "../serialize";
import type { NonShadowWireMode, WireExpr, WireMode } from "../tree";

const context: EvalContext = {
	getValue: () => undefined,
	resolveHashtag: () => "",
	contextPath: "/data/answer",
	position: 1,
};
const modes: readonly NonShadowWireMode[] = [
	{ target: "xform", constraint: false },
	{ target: "suite" },
	{ target: "hq-json", interpolation: "none" },
	{ target: "hq-json", interpolation: "case" },
	{ target: "hq-json", interpolation: "no-case" },
	{ target: "hq-json", interpolation: "no-dots" },
	{ target: "hq-json", interpolation: "enum-key" },
	{ target: "preview" },
];

/** The actual grammar's shape with grouping punctuation removed. A fully
 * parenthesized reference spelling supplies an independent precedence oracle. */
function parseShape(source: string): unknown {
	function read(node: SyntaxNode): unknown {
		expect(node.type.isError, source).toBe(false);
		if (node.firstChild === null)
			return [node.name, source.slice(node.from, node.to)];
		const children: unknown[] = [];
		for (
			let child: SyntaxNode | null = node.firstChild;
			child !== null;
			child = child.nextSibling
		) {
			if (child.name !== "(" && child.name !== ")") children.push(read(child));
		}
		return [node.name, ...children];
	}
	return read(parser.parse(source).topNode);
}

describe("canonical wire serialization", () => {
	it("keeps every binary tree's grouping against a fully parenthesized grammar parse", () => {
		type Example = { tree: WireExpr; reference: string };
		const leaves: fc.Arbitrary<Example> = fc
			.integer({ min: 0, max: 100 })
			.map((value) => ({ tree: w.num(value), reference: String(value) }));
		const ops = [
			"+",
			"-",
			"*",
			"div",
			"mod",
			"=",
			"!=",
			"<",
			"<=",
			">",
			">=",
		] as const;
		const examples = fc.letrec<{ expression: Example }>((tie) => ({
			expression: fc.oneof(
				{ depthSize: "small", maxDepth: 4 },
				leaves,
				fc
					.tuple(fc.constantFrom(...ops), tie("expression"), tie("expression"))
					.map(([op, left, right]) => ({
						tree:
							op === "+" ||
							op === "-" ||
							op === "*" ||
							op === "div" ||
							op === "mod"
								? w.arith(op, left.tree, right.tree)
								: w.cmp(op, left.tree, right.tree),
						reference: `((${left.reference}) ${op} (${right.reference}))`,
					})),
			),
		})).expression;
		fc.assert(
			fc.property(examples, ({ tree, reference }) => {
				expect(
					parseShape(serializeWire(tree, { target: "suite" }).text),
				).toEqual(parseShape(reference));
			}),
			{ seed: 261018, numRuns: 500 },
		);
	});

	it("uses canonical spaces and retains a right operand of equal precedence", () => {
		expect(
			serializeWire(w.sub(w.num(8), w.add(w.num(2), w.num(1))), {
				target: "suite",
			}).text,
		).toBe("8 - (2 + 1)");
		expect(
			serializeWire(
				w.call("if", [
					w.and(
						w.eq(w.num(1), w.num(1)),
						w.or(w.call("true"), w.call("false")),
					),
					w.neg(w.add(w.num(1), w.num(2))),
					w.str(""),
				]),
				{ target: "suite" },
			).text,
		).toBe("if(1 = 1 and (true() or false()), -(1 + 2), '')");
	});

	it("round-trips finite numbers as decimal text at ordinary and extreme magnitudes", () => {
		const check = (value: number) => {
			const printed = serializeWire(w.num(value), { target: "suite" }).text;
			expect(printed).toMatch(/^-?\d+(?:\.\d+)?$/u);
			expect(Number(printed)).toBe(value === 0 ? 0 : value);
		};
		for (const value of [
			Number.MIN_VALUE,
			-Number.MIN_VALUE,
			Number.MAX_VALUE,
			-Number.MAX_VALUE,
			-0,
			1.234e-7,
			1.5e21,
		])
			check(value);
		fc.assert(
			fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), check),
			{ seed: 261018, numRuns: 2000 },
		);
		expect(serializeWire(w.num(5), { target: "suite" }).text).toBe("5");
		for (const value of [NaN, Infinity, -Infinity])
			expect(() => w.num(value)).toThrow("finite");
	});

	it("keeps singleton and empty boolean combinations defined without artificial grouping", () => {
		const condition = w.eq(w.context([w.step("status")]), w.str("open"));
		expect(w.and(condition)).toBe(condition);
		expect(serializeWire(w.and(), { target: "suite" }).text).toBe("true()");
		expect(serializeWire(w.or(), { target: "suite" }).text).toBe("false()");
		expect(
			serializeWire(w.and(condition, w.and(condition, condition)), {
				target: "suite",
			}).text,
		).toBe("status = 'open' and status = 'open' and status = 'open'");
	});
});

describe("literal values across target spellings", () => {
	const values = [
		"",
		"O'Brien",
		'say "hello"',
		`it's "quoted"`,
		"a b\tc\nd 日本",
		"\\",
		"a\\\\",
		"a\\'\"",
		"#case",
		"#parent_case",
		"#host",
		"#user_role",
		"#session/data/user_id",
		"$fixture_value",
		"instance('missing')",
		'instance( "missing" )',
		"instance(&quot;missing&quot;)",
		"inst&#97;nce(&#34;missing&#34;)",
		"&#105;nstance&#40;&#x85;&quot;missing&quot;)",
		"instance(&#34missing&#34;)",
		"inst&#1;ance('missing')",
		"inst&#x7f;ance('missing')",
		"inst&#11;ance('missing')",
		"a\\#case and instance('x')\\",
		"instance('x')&",
	];
	it.each(values)("preserves the literal value %j", (value) => {
		for (const mode of modes) {
			const printed = serializeWire(w.str(value), mode);
			expect(evaluate(printed.text, context), JSON.stringify(mode)).toBe(value);
			expect(printed.instances.size).toBe(0);
			const argument = serializeWire(
				w.call("concat", [w.str("before:"), w.str(value), w.str(":after")]),
				mode,
			);
			expect(evaluate(argument.text, context), JSON.stringify(mode)).toBe(
				`before:${value}:after`,
			);
			expect(argument.instances.size).toBe(0);
		}
	});

	it("splices only literal encoding tokens into a parent concat and keeps empty quote pieces", () => {
		const tree = w.call("concat", [
			w.str('first_name = "'),
			w.context([w.step("query")]),
			w.str(`" or case_name = 'active'`),
		]);
		expect(serializeWire(tree, { target: "suite" }).text).toBe(
			`concat('first_name = "', query, '" or case_name = ', "'", 'active', "'", '')`,
		);
		const nested = w.call("concat", [
			w.str(`'"'`),
			w.call("concat", [w.context([w.step("query")]), w.str("suffix")]),
		]);
		expect(serializeWire(nested, { target: "suite" }).text).toBe(
			`concat('', "'", '"', "'", '', concat(query, 'suffix'))`,
		);
	});

	it("uses the shortest available quote delimiter before introducing concat", () => {
		expect(serializeWire(w.str("plain"), { target: "suite" }).text).toBe(
			"'plain'",
		);
		expect(serializeWire(w.str("O'Brien"), { target: "suite" }).text).toBe(
			'"O\'Brien"',
		);
		expect(
			serializeWire(w.str(`it's "quoted"`), { target: "suite" }).text,
		).toBe(`concat('it', "'", 's "quoted"')`);
	});

	it("leaves no instance-shaped literal after HQ's single HTML decode", () => {
		for (const value of values) {
			const text = serializeWire(w.str(value), {
				target: "hq-json",
				interpolation: "none",
			}).text;
			expect(decodeHTML(text)).not.toMatch(
				// biome-ignore lint/suspicious/noControlCharactersInRegex: Match HQ's Python whitespace class after HTML decoding.
				/instance\([\s\u001c-\u001f\u0085]*['"][\w:-]+['"][\s\u001c-\u001f\u0085]*\)/u,
			);
		}
	});

	it("protects every final fragment, including a backslash before a split token or quote", () => {
		for (const [value, needsSubstr] of [
			["a\\#case", false],
			["a\\'\"", true],
			["a\\instance('x')\\", true],
		] as const) {
			const text = serializeWire(w.str(value), {
				target: "hq-json",
				interpolation: "case",
			}).text;
			expect(evaluate(text, context)).toBe(value);
			expect(text).not.toMatch(/#(?:user|session\/|case|parent|host)/u);
			if (needsSubstr) expect(text).toContain("substr('\\\\', 0, 1)");
			const parent = serializeWire(
				w.call("concat", [w.str("before:"), w.str(value), w.str(":after")]),
				{ target: "hq-json", interpolation: "case" },
			).text;
			expect(evaluate(parent, context)).toBe(`before:${value}:after`);
			expect(parent).not.toMatch(/#(?:user|session\/|case|parent|host)/u);
			expect(parent).not.toContain("concat('before:', concat(");
			if (needsSubstr) expect(parent).toContain("substr('\\\\', 0, 1)");
		}
	});

	it("protects enum-key literal fragments while keeping hashtags and the intentional self placeholder", () => {
		const mode = { target: "hq-json", interpolation: "enum-key" } as const;
		for (const value of [
			"#case.#user\\",
			"a\\'\"",
			"instance(&quot;x&quot;)\\",
		]) {
			const literal = serializeWire(w.str(value), mode);
			expect(evaluate(literal.text, context)).toBe(value);
			expect(literal.text).toContain("substr('\\\\', 0, 1)");
			expect(literal.instances.size).toBe(0);
		}
		expect(
			serializeWire(
				w.call("selected", [w.context([w.self()]), w.str("#case.#user")]),
				mode,
			).text,
		).toBe("selected(., '#case.#user')");
		expect(() => serializeWire(w.context([w.parent()]), mode)).toThrow(
			"parent step",
		);
		expect(() => serializeWire(w.hqCase(), mode)).toThrow("case shortcut");
	});

	it("names image alt variables from the exact protected HQ enum key", () => {
		const value = "value\\";
		const key = "selected(., concat('value', substr('\\\\', 0, 1)))";
		expect(serializeWire(w.imageAltVar(value), { target: "suite" }).text).toBe(
			`$${keyAsVariable(key)}`,
		);
	});
});

describe("path spelling and shadow eligibility", () => {
	it("represents a generated parent-index wildcard as a distinct step", () => {
		const tree = w.context([
			w.step("index"),
			w.wildcard([
				w.not(w.eq(w.context([w.attr("relationship")]), w.str("extension"))),
			]),
		]);
		expect(serializeWire(tree, { target: "suite" }).text).toBe(
			"index/*[not(@relationship = 'extension')]",
		);
		expect(() =>
			serializeWire(w.context([w.step("*")]), { target: "suite" }),
		).toThrow("resolved XML name");
	});
	it("prints named child and attribute paths, explicit current paths and real instance roots", () => {
		const tree = w.instance(caseDbInstance(), [
			w.step("casedb"),
			w.step("case", [
				w.eq(
					w.context([w.attr("case_id")]),
					w.current([w.parent(), w.step("id")]),
				),
			]),
			w.step("name"),
		]);
		const result = serializeWire(tree, { target: "suite" });
		expect(result.text).toBe(
			"instance('casedb')/casedb/case[@case_id = current()/../id]/name",
		);
		expect([...result.instances]).toEqual([caseDbInstance()]);
	});

	it("spells the same shared self subtree separately inside and outside a predicate", () => {
		const self = w.context([w.self()]);
		const expr = w.call("concat", [
			self,
			w.form([w.step("choices", [w.eq(self, w.str("yes"))])]),
		]);
		expect(
			serializeWire(expr, { target: "xform", constraint: false }).text,
		).toBe("concat(., /data/choices[./. = 'yes'])");
		expect(
			serializeWire(expr, { target: "xform", constraint: true }).text,
		).toBe("concat(., /data/choices[. = 'yes'])");
		expect(serializeWire(expr, { target: "suite" }).text).toBe(
			"concat(., /data/choices[. = 'yes'])",
		);
	});

	it("prints only complete Vellum shadows and uses the same tree in the real attribute", () => {
		const field = w.form(["visits", "seen"], "hashtag");
		expect(
			serializeWire(field, { target: "vellum", constraint: false })?.text,
		).toBe("#form/visits/seen");
		expect(
			serializeWire(field, { target: "xform", constraint: false }).text,
		).toBe("/data/visits/seen");
		for (const value of [
			w.expansion("case", field),
			w.expansion("worker", field),
			w.expansion("search", field),
			w.form([w.step("visits", [w.num(1)])], "hashtag"),
			w.form([w.step("visits"), w.attr("count")], "hashtag"),
			w.hqCase([w.step("name")]),
		]) {
			expect(
				serializeWire(w.call("string", [value]), {
					target: "vellum",
					constraint: false,
				}),
			).toBeUndefined();
		}
	});

	it("refuses dot paths in dot-interpolated slots and limits the HQ shortcut to its slot", () => {
		for (const interpolation of ["case", "no-case"] as const) {
			for (const expr of [
				w.context(),
				w.context([w.self()]),
				w.current([w.parent()]),
				w.context([w.step("index"), w.parent()]),
			])
				expect(() =>
					serializeWire(expr, { target: "hq-json", interpolation }),
				).toThrow("self or parent");
		}
		expect(
			serializeWire(w.context(), {
				target: "hq-json",
				interpolation: "no-dots",
			}).text,
		).toBe(".");
		expect(
			serializeWire(w.hqCase([w.step("status")]), {
				target: "hq-json",
				interpolation: "case",
			}).text,
		).toBe("#case/status");
		expect(() => serializeWire(w.hqCase(), { target: "suite" })).toThrow(
			"case shortcut",
		);
	});

	it("collects exactly printed roots, even when repeated, and refuses conflicting sources", () => {
		const root = w.instance(caseDbInstance(), [w.step("casedb")]);
		const tree = w.call("concat", [
			root,
			root,
			w.instance(sessionInstance(), [w.step("session")]),
			w.str("instance('unused')"),
		]);
		expect([...serializeWire(tree, { target: "suite" }).instances]).toEqual([
			caseDbInstance(),
			sessionInstance(),
		]);
		expect([...serializeWire(root, { target: "suite" }).instances]).toEqual([
			caseDbInstance(),
		]);
		expect(() =>
			serializeWire(
				w.call("concat", [root, w.instance({ id: "casedb", src: "wrong" })]),
				{ target: "suite" },
			),
		).toThrow("two different sources");
	});

	it("limits the finite generated variables to their owning targets", () => {
		const suite = [
			w.caseIdVar(),
			w.nextInputVar(),
			w.calculatedPropertyVar(),
			w.enumLabelVar(3),
			w.imageAltVar("yes"),
			w.endpointArgumentVar("case_id_parent-visit"),
		];
		expect(
			suite
				.map((expr) => serializeWire(expr, { target: "suite" }).text)
				.slice(0, 4),
		).toEqual([
			"$case_id",
			"$next_input",
			"$calculated_property",
			"$knova_text_3",
		]);
		expect(serializeWire(suite[4], { target: "suite" }).text).toMatch(
			/^\$h[0-9a-f]{8}$/u,
		);
		for (const expr of suite)
			expect(() =>
				serializeWire(expr, { target: "xform", constraint: false }),
			).toThrow("suite variable");
		expect(
			serializeWire(w.hqEnumVar(3), {
				target: "hq-json",
				interpolation: "none",
			}).text,
		).toBe("$nova_text_0000000003");
		expect(() => serializeWire(w.hqEnumVar(3), { target: "suite" })).toThrow(
			"HQ enum",
		);
		expect(
			serializeWire(w.endpointArgumentVar("case_id_parent-visit"), {
				target: "suite",
			}).text,
		).toBe("$case_id_parent-visit");
		for (const name of ["", "$case_id", "case_id/child", "1case", "case:type"])
			expect(() =>
				serializeWire(w.endpointArgumentVar(name), { target: "suite" }),
			).toThrow("local name");
	});
});

// This is a type boundary as well as a runtime serializer.
function noRawFunctionOrVariableEscape(mode: WireMode): void {
	// @ts-expect-error Only the pinned native table and three context calls exist.
	w.call("arbitrary-function", []);
	// @ts-expect-error There is no raw XPath tree arm.
	serializeWire({ k: "raw", text: "1 + 2" }, mode);
}
void noRawFunctionOrVariableEscape;
