/**
 * The fold loop: a fold proposes, the print proves, and a proposal whose print
 * differs is withdrawn at its site, so the node binds as the author wrote it.
 * The failures this holds: a joined literal the printer would split, or a
 * guard at a position where Nova writes none, held as anything but the tree
 * the author wrote; a nested `if` the slot's types refuse as a `switch` held
 * as that `switch`; a mismatch that names no fold site taken for one; a site
 * withdrawn and offered again; a loop that does not end; a weighted
 * checklist Nova moved into the branches of an `if` or a `cond` in its pair
 * read back as anything but the call over that `if` or `cond`. The rounds
 * are `readExpressions`' own.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { Expression } from "@/lib/domain/expression/types";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { calculatedColumn } from "@/lib/domain/modules";
import {
	EXPRESSION_ROUND_LIMIT,
	type ExpressionReadEnv,
	readExpressions,
} from "../index";
import { printSlot, readExpression } from "../readExpression";
import {
	fieldNamed,
	onlyForm,
	readEnv,
	registration,
} from "./expressionReadFixture";

function formDoc() {
	return buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Survey",
						type: "survey",
						fields: [
							f({ kind: "text", id: "q1", label: "Q1" }),
							f({ kind: "hidden", id: "h" }),
						],
					},
				],
			},
		],
	});
}

/** Judge a slot the way the reading's rounds do: withdraw the site the
 *  difference names and bind again, until equal or no site is named. */
function settle(
	judge: (withdrawn: ReadonlySet<string>) => ReturnType<typeof readExpression>,
) {
	const withdrawn = new Set<string>();
	const turns: ReturnType<typeof readExpression>[] = [];
	for (let turn = 0; turn < 16; turn++) {
		const judgment = judge(withdrawn);
		turns.push(judgment);
		if (judgment.kind !== "bound" || judgment.equal) break;
		if (judgment.withdraw === undefined) break;
		expect(withdrawn.has(judgment.withdraw)).toBe(false);
		withdrawn.add(judgment.withdraw);
	}
	return { turns, withdrawn, last: turns.at(-1) };
}

describe("a fold whose print differs is withdrawn at its site", () => {
	it("keeps two literals an author wrote as two concat parts", () => {
		const doc = formDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "h"),
			slot: "calculate",
		} as const;
		const pending = registration(doc, ref, "concat('a', 'b')");
		const { turns, withdrawn, last } = settle((sites) =>
			readExpression(doc, pending, readEnv(), { withdrawn: sites }),
		);
		expect(turns[0]).toMatchObject({ kind: "bound", equal: false });
		expect([...withdrawn]).toEqual([
			expect.stringMatching(/^protected-literal:/),
		]);
		expect(last).toMatchObject({
			kind: "bound",
			equal: true,
			candidate: { kind: "concat", parts: [{}, {}] },
		});
		// The stage's own rounds come to the same tree: the first withdraws the
		// joined run, the second holds the two parts.
		const reading = readExpressions(doc, [pending], readEnv());
		expect(reading.rounds).toBe(2);
		expect(reading.circumstances).toEqual([]);
		expect(reading.bound[0]).toMatchObject({
			kind: "concat",
			parts: [{}, {}],
		});
	});

	it("keeps a guard inside count, where Nova writes none, as the author's if", () => {
		const doc = formDoc();
		const form = onlyForm(doc);
		const table = "01890000-0000-7000-8000-000000000001" as LookupTableId;
		const column = "01890000-0000-7000-8000-000000000002" as LookupColumnId;
		const env = readEnv({
			lookup: new Map([
				[
					table,
					{
						id: table,
						name: "Districts",
						tag: "districts",
						columns: [
							{ id: column, wireName: "name", label: "Name", dataType: "text" },
						],
					},
				],
			]),
			instanceSources: new Map([
				[form, new Map([["districts", "jr://fixture/item-list:districts"]])],
			]),
		});
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "h"),
			slot: "calculate",
		} as const;
		const rows = "instance('districts')/districts_list/districts";
		const pending = registration(
			doc,
			ref,
			`count(if(count(${rows}) > 0, ${rows}, '')) > 0`,
		);
		const { withdrawn, last } = settle((sites) =>
			readExpression(doc, pending, env, { withdrawn: sites }),
		);
		expect([...withdrawn]).toContainEqual(
			expect.stringMatching(/^empty-rows-guard:/),
		);
		expect(last).toMatchObject({ kind: "bound", equal: true });
		const reading = readExpressions(doc, [pending], env);
		expect(reading.rounds).toBeGreaterThan(1);
		expect(reading.circumstances).toEqual([]);
		expect(reading.bound[0]).toMatchObject({
			kind: "gt",
			left: { kind: "count", via: { kind: "if" } },
		});
	});

	it("holds no switch the slot's types refuse, though it prints as the author's nested if", () => {
		const COLUMN = testUuid("withdrawal-band");
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "age", label: "Age", data_type: "int" }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							calculatedColumn(COLUMN, "Band", {
								kind: "term",
								term: { kind: "literal", value: "" },
							}),
						],
						searchInputs: [],
					},
					forms: [{ name: "Visit", type: "followup", fields: [] }],
				},
			],
		});
		const ref = {
			entity: "module",
			uuid: doc.moduleOrder[0] as (typeof doc.moduleOrder)[number],
			slot: "case_list_column_expression",
			member: { columnUuid: COLUMN },
		} as const;
		const reading = readExpressions(
			doc,
			[registration(doc, ref, "if(age = 'a', 'x', if(age = 'b', 'y', 'z'))")],
			readEnv(),
		);
		expect(reading.bound[0]).toBeUndefined();
		expect(reading.circumstances).toEqual([]);
		expect(
			reading.claims.filter((claim) => claim.detail.reason !== undefined),
		).toEqual([
			expect.objectContaining({
				detail: expect.objectContaining({
					reason: expect.stringContaining("incompatible-values"),
				}),
			}),
		]);
	});

	it("ends every reading within the round limit", () => {
		const doc = formDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "h"),
			slot: "calculate",
		} as const;
		const reading = readExpressions(
			doc,
			[
				registration(doc, ref, "concat('a', 'b', /data/q1, 'c', 'd')"),
				registration(
					doc,
					{ entity: "field", uuid: fieldNamed(doc, "q1"), slot: "relevant" },
					"concat('x', concat('y', 'z')) = 'xyz'",
				),
			],
			readEnv(),
		);
		expect(reading.rounds).toBeLessThan(EXPRESSION_ROUND_LIMIT);
		expect(reading.circumstances).toEqual([]);
	});

	it("names no site where the difference lies outside every fold", () => {
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [{ name: "p", label: "P" }] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [{ name: "Visit", type: "followup", fields: [] }],
				},
			],
		});
		const ref = {
			entity: "module",
			uuid: doc.moduleOrder[0] as (typeof doc.moduleOrder)[number],
			slot: "case_list_filter",
		} as const;
		// The emitter drops the boolean identity: the trees first differ at
		// the `and`, which no fold proposed.
		const judgment = readExpression(
			doc,
			registration(doc, ref, "true() and p = 'x'"),
			readEnv(),
		);
		expect(judgment).toMatchObject({ kind: "bound", equal: false });
		expect(judgment.kind === "bound" && judgment.withdraw).toBeFalsy();
	});
});

describe("a fold that declines a node binds none of it", () => {
	// A fold that bound a node's arguments and then declined would have the
	// plain binding bind them again, doubling the work at every level: forty
	// levels would never finish.
	const DEPTH = 40;
	const ref = (doc: ReturnType<typeof formDoc>) =>
		({
			entity: "field",
			uuid: fieldNamed(doc, "h"),
			slot: "calculate",
		}) as const;

	it("reads a forty-deep chain of ifs, the lookup HQ authors write by hand", () => {
		const doc = formDoc();
		let text = "''";
		for (let level = DEPTH; level > 0; level--)
			text = `if(/data/q1 = 'v${level}', 'n${level}', ${text})`;
		const reading = readExpressions(
			doc,
			[registration(doc, ref(doc), text)],
			readEnv(),
		);
		expect(reading.circumstances).toEqual([]);
		expect(reading.bound[0]).toBeDefined();
	});

	it("reads forty nested concats with no run of literals to join", () => {
		const doc = formDoc();
		let text = "concat(/data/q1, 'end')";
		for (let level = 0; level < DEPTH; level++)
			text = `concat(/data/q1, ${text})`;
		const reading = readExpressions(
			doc,
			[registration(doc, ref(doc), text)],
			readEnv(),
		);
		expect(reading.circumstances).toEqual([]);
		expect(reading.bound[0]).toBeDefined();
	});

	it("reads a forty-deep case list filter of three-clause ands inside ors", () => {
		// The relation test's fold reads a run of two clauses of a longer
		// `and`; an `and` with no such run is declined before any clause of it
		// is bound, so the `or` and the `and` each bind a level once.
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [{ name: "p", label: "P" }] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [{ name: "Visit", type: "followup", fields: [] }],
				},
			],
		});
		const filter = {
			entity: "module",
			uuid: doc.moduleOrder[0] as (typeof doc.moduleOrder)[number],
			slot: "case_list_filter",
		} as const;
		let text = "p = 'end'";
		for (let level = DEPTH; level > 0; level--)
			text = `p = 'a${level}' and p != 'b${level}' and (p = 'c${level}' or ${text})`;
		const judgment = readExpression(
			doc,
			registration(doc, filter, text),
			readEnv(),
		);
		expect(judgment).toMatchObject({ kind: "bound", equal: true });
	});
});

describe("a weighted checklist Nova moved into the branches of its pair", () => {
	const table = "01890000-0000-7000-8000-000000000011" as LookupTableId;
	const name = "01890000-0000-7000-8000-000000000012" as LookupColumnId;
	const weight = "01890000-0000-7000-8000-000000000013" as LookupColumnId;
	const rows = (columnId: LookupColumnId): Expression => ({
		kind: "project",
		of: { kind: "table-rows", tableId: table, where: [] },
		value: { kind: "table-column", tableId: table, columnId },
	});
	const lit = (value: string | number): Expression => ({
		kind: "term",
		term: { kind: "literal", value },
	});
	const checklist = (values: Expression): Expression => ({
		kind: "call",
		fn: "weighted-checklist",
		args: [lit(1), lit(2), values, rows(weight)],
	});

	it("reads back the call over an if and over a cond in its pair", () => {
		const doc = formDoc();
		const env = readEnv({
			lookup: new Map([
				[
					table,
					{
						id: table,
						name: "Districts",
						tag: "districts",
						columns: [
							{ id: name, wireName: "name", label: "Name", dataType: "text" },
							{
								id: weight,
								wireName: "weight",
								label: "Weight",
								dataType: "int",
							},
						],
					},
				],
			]) as ExpressionReadEnv["lookup"],
			instanceSources: new Map([
				[
					onlyForm(doc),
					new Map([["districts", "jr://fixture/item-list:districts"]]),
				],
			]),
		});
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "h"),
			slot: "calculate",
		} as const;
		const q1Is = (value: string): Expression => ({
			kind: "eq",
			left: {
				kind: "term",
				term: { kind: "field", uuid: fieldNamed(doc, "q1") },
			},
			right: lit(value),
		});
		for (const tree of [
			checklist({
				kind: "if",
				cond: q1Is("a"),
				// biome-ignore lint/suspicious/noThenProperty: The persisted branch is data, not a callable thenable.
				then: rows(name),
				else: lit("x"),
			}),
			checklist({
				kind: "call",
				fn: "cond",
				args: [q1Is("a"), rows(name), q1Is("b"), lit("y"), rows(weight)],
			}),
		]) {
			const text = printSlot(doc, ref, tree, env);
			// Nova writes the call inside each branch of the lazy call.
			expect(text).toMatch(/^(if|cond)\(/);
			const reading = readExpressions(doc, [registration(doc, ref, text)], env);
			expect(reading.circumstances, text).toEqual([]);
			expect(reading.bound[0], text).toEqual(tree);
		}
	});
});
