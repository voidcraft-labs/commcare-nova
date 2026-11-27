/**
 * Contract: a column's load behavior commits only on a column that can use one, on a case list
 * whose faster loading is on, refused by the gate (`CASE_LIST_LOAD_BEHAVIOR_INVALID`) on every
 * editor, as the stored-document schema refuses it. The plausible failure: the column tools
 * admit a behavior the gate never checks, and the document's save then fails parsing it with no
 * word for the person (and, in a change set, every later save of that work fails).
 */
import { describe, expect, it } from "vitest";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import { prop, term } from "@/lib/domain/expression";
import { addCaseListColumnsTool } from "../addCaseListColumns";
import { configureCaseListTool } from "../configureCaseList";
import { updateCaseListColumnTool } from "../updateCaseListColumn";
import { MOD_A, makeCaseListFixture } from "./fixtures";

const visits = {
	kind: "calculated",
	header: "Visits",
	expression: term(prop("patient", "case_name")),
	loadBehavior: "cache",
} as const;

const { loadBehavior: _none, ...plainVisits } = visits;

describe("a column's load behavior through the shared tools", () => {
	it("is refused on a list whose faster loading is off, and admitted once it is on", async () => {
		const h = makeCaseListFixture();
		const before = h.currentDoc();
		const refused = await h.runTool(addCaseListColumnsTool, {
			moduleUuid: MOD_A,
			columns: [visits],
		});
		expect(refused.result).toHaveProperty("error");
		expect(String((refused.result as { error: unknown }).error)).toContain(
			"faster loading is off",
		);
		expect(h.currentDoc()).toBe(before);

		const on = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			optimizations: true,
		});
		if ("error" in on.result) throw new Error(on.result.error);
		const added = await h.runTool(addCaseListColumnsTool, {
			moduleUuid: MOD_A,
			columns: [visits],
		});
		if ("error" in added.result) throw new Error(String(added.result.error));
		// What the gate admits is a document the stored schema accepts.
		expect(
			blueprintDocSchema.safeParse(toPersistableDoc(h.currentDoc())).success,
		).toBe(true);
	});

	it("is refused on a calculated value with its own wording, which can't use one", async () => {
		const h = makeCaseListFixture();
		const on = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			optimizations: true,
			columns: [plainVisits],
		});
		if ("error" in on.result) throw new Error(on.result.error);
		const column = h
			.currentDoc()
			.modules[MOD_A]?.caseListConfig?.columns.find(
				(one) => one.header === "Visits",
			);
		if (column === undefined) throw new Error("The column wasn't added.");
		const before = h.currentDoc();
		const WORD = "00000000-0000-4000-8000-0000000c5b77";
		const refused = await h.runTool(updateCaseListColumnTool, {
			moduleUuid: MOD_A,
			columnUuid: column.uuid,
			column: {
				...visits,
				texts: [{ uuid: WORD, label: "visit" }],
			},
		});
		expect(refused.result).toHaveProperty("error");
		expect(String((refused.result as { error: unknown }).error)).toContain(
			"only a calculated value or a link can",
		);
		expect(h.currentDoc()).toBe(before);
	});
});
