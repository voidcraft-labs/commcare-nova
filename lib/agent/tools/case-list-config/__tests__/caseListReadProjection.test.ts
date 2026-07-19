import { describe, expect, it } from "vitest";
import { summarizeBlueprint } from "@/lib/agent/summarizeBlueprint";
import { asUuid, plainColumn } from "@/lib/domain";
import { getModuleTool } from "../../getModule";
import { MOD_A, makeCaseListFixture } from "./fixtures";

const A = asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const B = asUuid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
const C = asUuid("cccccccc-cccc-cccc-cccc-cccccccccccc");

function independentlyArrangedFixture() {
	const fixture = makeCaseListFixture();
	return {
		...fixture,
		doc: {
			...fixture.doc,
			modules: {
				...fixture.doc.modules,
				[MOD_A]: {
					...fixture.doc.modules[MOD_A],
					caseListConfig: {
						columns: [
							plainColumn(A, "case_name", "Patient", {
								listOrder: "z",
								detailOrder: "a",
							}),
							plainColumn(B, "phone", "Phone", {
								listOrder: "a",
								detailOrder: "z",
								visibleInDetail: false,
							}),
							plainColumn(C, "dob", "Date of birth", {
								listOrder: "b",
								detailOrder: "b",
								visibleInList: false,
							}),
						],
						searchInputs: [],
					},
				},
			},
		},
	};
}

describe("case-list read projections", () => {
	it("getModule exposes the exact independent visible screen sequences", async () => {
		const { doc, ctx } = independentlyArrangedFixture();
		const result = await getModuleTool.execute({ moduleIndex: 0 }, ctx, doc);
		if ("error" in result.data) throw new Error(result.data.error);

		expect(result.data.results_column_order).toEqual([B, A]);
		expect(result.data.details_column_order).toEqual([A, C]);
	});

	it("summary describes Results and Details as compositions, not hidden columns", () => {
		const { doc } = independentlyArrangedFixture();
		const summary = summarizeBlueprint(doc);
		const results = summary.indexOf("      results:");
		const details = summary.indexOf("      details:");

		expect(results).toBeGreaterThan(-1);
		expect(details).toBeGreaterThan(results);
		expect(summary.slice(results, details)).toMatch(/Phone[\s\S]*Patient/);
		expect(summary.slice(details)).toMatch(/Patient[\s\S]*Date of birth/);
		expect(summary).not.toContain("[list:");
		expect(summary).not.toContain("      columns:");
	});
});
