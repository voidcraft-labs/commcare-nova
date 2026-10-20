import { describe, expect, it } from "vitest";
import { parser } from "../../xpath/parser";
import { w } from "../../xpath/wire/builders";
import type { WireExpr } from "../../xpath/wire/tree";
import {
	csqlClauseWrapper,
	isCsqlStringLiteralRepresentable,
	quoteLiteral,
} from "../print";
import { type CsqlNode, c } from "../tree";

it.each([
	["", "''"],
	["Alice", "'Alice'"],
	['say "hello"', `'say "hello"'`],
	["a b\tc\nd 日本", "'a b\tc\nd 日本'"],
	["O'Brien", `"O'Brien"`],
	["'", `"'"`],
	["a''b", `"a''b"`],
	["a'b'c'd", `"a'b'c'd"`],
	["naïve\nO'Brien", `"naïve\nO'Brien"`],
	[`it's "quoted"`, null],
] as const)("quotes %j in the server-side CSQL grammar", (value, expected) => {
	expect(isCsqlStringLiteralRepresentable(value)).toBe(expected !== null);
	if (expected === null)
		expect(() => quoteLiteral(value, "csql")).toThrow(/no portable escape/);
	else expect(quoteLiteral(value, "csql")).toBe(expected);
});

// A choice the device makes between clauses splices its chosen branch into
// the CSQL text. HQ then parses that text with its own grammar, where `and`
// binds tighter than `or` (`eulxml/xpath/parserules.py::precedence`), so the
// spliced branch must group exactly as the branch printed in the choice's
// place would. Each case resolves the wrapper as the device would for each
// branch and parses the text it sends; the parse must equal the parse of the
// tree with that branch written in directly.

/** The device's answer for a wrapper, each condition decided by `taken`. */
function sent(wire: WireExpr, taken: boolean): string {
	switch (wire.k) {
		case "str":
			return wire.value;
		case "call":
			if (wire.fn === "concat")
				return wire.args.map((arg) => sent(arg, taken)).join("");
			if (wire.fn === "if") {
				const [condition, then, otherwise] = wire.args;
				if (
					condition === undefined ||
					then === undefined ||
					otherwise === undefined
				)
					throw new Error("An if() needs three arguments.");
				return sent(decided(condition, taken) ? then : otherwise, taken);
			}
			break;
		default:
			break;
	}
	throw new Error(`The test resolves no ${JSON.stringify(wire)}.`);
}

function decided(condition: WireExpr, taken: boolean): boolean {
	if (
		condition.k === "call" &&
		(condition.fn === "count" || condition.fn === "true")
	)
		return taken;
	throw new Error(`The test decides no ${JSON.stringify(condition)}.`);
}

/** The parse of a CSQL text, as nested node names and token text. */
function parsed(text: string): string {
	const out: string[] = [];
	const cursor = parser.parse(text).cursor();
	const walk = (): void => {
		const leaf = !cursor.firstChild();
		if (leaf) {
			out.push(`${cursor.name}:${text.slice(cursor.from, cursor.to)}`);
			return;
		}
		out.push("(");
		do walk();
		while (cursor.nextSibling());
		cursor.parent();
		out.push(`)${cursor.name}`);
	};
	walk();
	return out.join(" ");
}

const prop = (name: string, value: string) =>
	c.cmp("=", c.step(name), c.literal(value));
const orBranch = c.or(prop("q", "2"), prop("r", "3"));
const andBranch = c.and(prop("s", "4"), prop("t", "5"));
const parents: readonly [string, (clause: CsqlNode) => CsqlNode][] = [
	["and", (clause) => c.and(prop("p", "1"), clause)],
	["and, on the left", (clause) => c.and(clause, prop("p", "1"))],
	["or", (clause) => c.or(prop("p", "1"), clause)],
	["not", (clause) => c.not(clause)],
	["an and inside not", (clause) => c.not(c.and(prop("p", "1"), clause))],
	[
		"an and inside subcase-exists",
		(clause) =>
			c.query("subcase-exists", [
				c.literal("parent"),
				c.and(prop("p", "1"), clause),
			]),
	],
	[
		"an and inside ancestor-exists",
		(clause) =>
			c.query("ancestor-exists", [
				c.step("parent"),
				c.and(prop("p", "1"), clause),
			]),
	],
];

describe.each(parents)("a choice under %s", (_name, parent) => {
	it.each([
		["an or", orBranch, andBranch],
		["an and", andBranch, orBranch],
	] as const)(
		"groups %s branch as written in place",
		(_branch, first, second) => {
			const choice = c.choice("k", w.call("true"), first, second);
			const wrapper = csqlClauseWrapper(parent(choice)).wrapper;
			expect(parsed(sent(wrapper, true))).toBe(
				parsed(sent(csqlClauseWrapper(parent(first)).wrapper, true)),
			);
			expect(parsed(sent(wrapper, false))).toBe(
				parsed(sent(csqlClauseWrapper(parent(second)).wrapper, true)),
			);
		},
	);

	it("groups a when-input-present clause as written in place", () => {
		const trigger = w.context([w.step("mode")]);
		const presence = c.presence("k", trigger, orBranch);
		const wrapper = csqlClauseWrapper(parent(presence)).wrapper;
		expect(parsed(sent(wrapper, true))).toBe(
			parsed(sent(csqlClauseWrapper(parent(orBranch)).wrapper, true)),
		);
		expect(parsed(sent(wrapper, false))).toBe(
			parsed(
				sent(csqlClauseWrapper(parent(c.query("match-all"))).wrapper, true),
			),
		);
	});
});
