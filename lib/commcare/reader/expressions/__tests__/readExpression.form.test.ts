/**
 * One form slot read from an app's text: bound through the parser's reading
 * hook, printed by the production XForm emitter and compared. The failures
 * this holds: an own-case walk or the usercase selector left a query, a
 * default that reads the case read as anything but the preload it is, a form
 * of HQ's naming an instance otherwise, a question with a generated-looking
 * name taken for a generated node, a function Core does not answer or a
 * hashtag Core's lexer refuses accepted, and an axis spelling of a form path
 * refused.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { Expression } from "@/lib/domain/expression/types";
import { readExpression } from "../readExpression";
import {
	fieldNamed,
	onlyForm,
	readEnv,
	registration,
} from "./expressionReadFixture";

const OWN =
	"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]";

function visitDoc() {
	return buildDoc({
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "village", label: "Village" }],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [
					{ name: "age", label: "Age", data_type: "int" },
					{ name: "dob", label: "Date of birth", data_type: "date" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "q1", label: "Q1" }),
							f({ kind: "text", id: "nova_trimmed_x", label: "Trimmed" }),
						],
					},
				],
			},
		],
	});
}

function held(judgment: ReturnType<typeof readExpression>): Expression {
	expect(judgment.kind).toBe("bound");
	if (judgment.kind !== "bound") throw new Error("not bound");
	expect(judgment.equal).toBe(true);
	return judgment.candidate;
}

describe("a form slot's text read through the reading hook", () => {
	it("reads the own case's walk as the form's case, at depth 0 and 1", () => {
		const doc = visitDoc();
		const q1 = fieldNamed(doc, "q1");
		const ref = { entity: "field", uuid: q1, slot: "relevant" } as const;
		const own = held(
			readExpression(doc, registration(doc, ref, `${OWN}/age > 5`), readEnv()),
		);
		expect(own).toMatchObject({
			kind: "gt",
			left: {
				kind: "term",
				term: { kind: "form-case", caseType: "patient", property: "age" },
			},
		});
		const parent = held(
			readExpression(
				doc,
				registration(
					doc,
					ref,
					`instance('casedb')/casedb/case[@case_id = ${OWN}/index/parent]/village = 'x'`,
				),
				readEnv(),
			),
		);
		expect(parent).toMatchObject({
			kind: "eq",
			left: {
				kind: "term",
				term: { kind: "form-case", caseType: "household", property: "village" },
			},
		});
	});

	it("reads the usercase selector as the worker's record", () => {
		const doc = visitDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		} as const;
		const tree = held(
			readExpression(
				doc,
				registration(
					doc,
					ref,
					"instance('casedb')/casedb/case[@case_type = 'commcare-user'][hq_user_id = instance('commcaresession')/session/context/userid]/role = 'chw'",
				),
				readEnv(),
			),
		);
		expect(tree).toMatchObject({
			kind: "eq",
			left: {
				kind: "term",
				term: { kind: "session-user", field: "role", source: "worker-record" },
			},
		});
	});

	it("reads a default that is the own case's property as the preload", () => {
		const doc = visitDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "default_value",
		} as const;
		const tree = held(
			readExpression(doc, registration(doc, ref, `${OWN}/age`), readEnv()),
		);
		expect(tree).toEqual({
			kind: "term",
			term: { kind: "form-case", caseType: "patient", property: "age" },
		});
	});

	it("reads an instance the form declares under another id by its source", () => {
		const doc = visitDoc();
		const form = onlyForm(doc);
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		} as const;
		const env = readEnv({
			instanceSources: new Map([
				[
					form,
					new Map([
						["cases", "jr://instance/casedb"],
						["session", "jr://instance/session"],
					]),
				],
			]),
		});
		held(
			readExpression(
				doc,
				registration(
					doc,
					ref,
					"instance('cases')/casedb/case[@case_id = instance('session')/session/data/case_id]/age > 5",
				),
				env,
			),
		);
	});

	it("reads a question named like a generated node as the question", () => {
		const doc = visitDoc();
		const trimmed = fieldNamed(doc, "nova_trimmed_x");
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		} as const;
		const tree = held(
			readExpression(
				doc,
				registration(doc, ref, "/data/nova_trimmed_x = 'a'"),
				readEnv(),
			),
		);
		expect(tree).toMatchObject({
			kind: "eq",
			left: { kind: "term", term: { kind: "field", uuid: trimmed } },
		});
	});

	it("holds an axis spelling of the question's own node", () => {
		const doc = visitDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "validate",
		} as const;
		held(
			readExpression(
				doc,
				registration(doc, ref, "self::node() != 'x'"),
				readEnv(),
			),
		);
	});

	it("refuses a function Core does not answer and a hashtag Core cannot lex", () => {
		const doc = visitDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		} as const;
		for (const [text, code] of [
			["normalize-space(/data/q1) = ''", "unknown-function"],
			["is-blank(/data/q1)", "unknown-function"],
			["#form/q1 = 'a'", "unknown-hashtag"],
		] as const) {
			const judgment = readExpression(
				doc,
				registration(doc, ref, text),
				readEnv(),
			);
			expect(judgment.kind).toBe("refused");
			if (judgment.kind !== "refused") continue;
			expect(judgment.cause).toMatchObject({
				kind: "parse",
				issues: [expect.objectContaining({ code })],
			});
		}
	});

	it("reads what Core's own spelling of normalize-space prints back", () => {
		const doc = visitDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		} as const;
		const tree = held(
			readExpression(
				doc,
				registration(
					doc,
					ref,
					"replace(replace(/data/q1, '[ \\t\\r\\n]+', ' '), '^ | $', '') = 'a'",
				),
				readEnv(),
			),
		);
		expect(tree).toMatchObject({
			kind: "eq",
			left: { kind: "call", fn: "normalize-space" },
		});
	});
});
