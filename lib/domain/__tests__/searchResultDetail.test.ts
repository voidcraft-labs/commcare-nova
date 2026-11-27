import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { literal, term } from "../expression";
import { calculatedColumn, simpleSearchInputDef } from "../modules";
import { resolveSearchResultDetailText } from "../searchResultDetail";

const prompt = testUuid("result-detail-prompt");
const columnUuid = testUuid("result-detail-column");
const branch = { inputUuid: prompt, prefix: "entered=[", suffix: "]" };
const column = calculatedColumn(
	columnUuid,
	"Entered value",
	term(literal("local row")),
	{
		notOnList: true,
		visibleInList: false,
	},
);
const doc = buildDoc({
	modules: [
		{
			name: "Patients",
			caseType: "patient",
			caseSearchConfig: {},
			caseListConfig: {
				columns: [column],
				listColumnOrder: [column.uuid],
				detailColumnOrder: [column.uuid],
				searchInputs: [
					simpleSearchInputDef(prompt, "marker", "Marker", "text", "case_name"),
				],
			},
			forms: [
				{
					name: "Visit",
					type: "followup",
					fields: [{ id: "note", kind: "text" }],
				},
			],
		},
	],
});
const module = doc.modules[doc.moduleOrder[0]];
const config = module.caseListConfig;
if (!config) throw new Error("The fixture needs its own Search.");
const web = {
	appSettings: { ...doc.appSettings, runsOnlyOn: "web-apps" as const },
};

describe("Search result Detail text", () => {
	it("binds the stable prompt ID against its current wire name", () => {
		expect(resolveSearchResultDetailText(web, module, column, branch)).toEqual({
			inputName: "marker",
			prefix: "entered=[",
			suffix: "]",
			localText: "local row",
		});
		expect(
			resolveSearchResultDetailText(
				web,
				{
					...module,
					caseListConfig: {
						...config,
						searchInputs: [
							simpleSearchInputDef(
								prompt,
								"renamed",
								"Marker",
								"text",
								"case_name",
							),
						],
					},
				},
				column,
				branch,
			)?.inputName,
		).toBe("renamed");
	});
	it("withholds ordinary list, inline and both-platform cases", () => {
		expect(
			resolveSearchResultDetailText(doc, module, column, branch),
		).toBeUndefined();
		expect(
			resolveSearchResultDetailText(
				web,
				{ ...module, caseSearchConfig: { workflow: "listFirst" } },
				column,
				branch,
			),
		).toBeUndefined();
		expect(
			resolveSearchResultDetailText(
				web,
				{ ...module, caseSearchConfig: { formsReadSearch: true } },
				column,
				branch,
			),
		).toBeUndefined();
		expect(
			resolveSearchResultDetailText(
				web,
				module,
				{ ...column, notOnList: undefined },
				branch,
			),
		).toBeUndefined();
		expect(
			resolveSearchResultDetailText(web, module, column, {
				...branch,
				inputUuid: testUuid("other"),
			}),
		).toBeUndefined();
	});
});
