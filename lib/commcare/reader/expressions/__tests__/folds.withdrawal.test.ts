/**
 * The fold loop: a fold proposes, the print proves, and a proposal whose print
 * differs is withdrawn at its site, so the node binds as the author wrote it.
 * The failures this holds: a joined literal the printer would split, or a
 * guard at a position where Nova writes none, held as anything but the tree
 * the author wrote; a mismatch that names no fold site taken for one; a site
 * withdrawn and offered again.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { readExpression } from "../readExpression";
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
		if (last?.kind === "bound" && last.equal) {
			expect([...withdrawn]).toContainEqual(
				expect.stringMatching(/^empty-rows-guard:/),
			);
			expect(last.candidate).toMatchObject({
				kind: "gt",
				left: { kind: "count", via: { kind: "if" } },
			});
		} else expect(last?.kind).not.toBe("bound");
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
