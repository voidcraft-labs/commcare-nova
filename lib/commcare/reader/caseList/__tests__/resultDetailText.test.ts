import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { literal, term } from "@/lib/domain/expression";
import { calculatedColumn, simpleSearchInputDef } from "@/lib/domain/modules";
import { serializeXml } from "../../../serializeXml";
import { buildLongDetail } from "../../../suite/case-list/longDetail";
import { hqExpressionField } from "../../../suite/case-list/orderPlanOptions";
import { resultDetailTextWire } from "../../../suite/case-list/resultDetailText";
import { serializeWire } from "../../../xpath/wire/serialize";
import { readResultDetailText } from "../resultDetailText";

const prompt =
	"instance('search-input:results')/input/field[@name = 'detail_marker']";
const roster = "count(current()/../../results) > 0";
const optional = `if(count(${prompt}) > 0, string(${prompt}), '')`;
const formula = `if(${roster}, concat('entered=[', ${optional}, ']'), 'local row')`;

describe("standalone Search result-detail text", () => {
	it("recovers the native witness and emits the same guarded read for HQ and the suite", () => {
		const parsed = readResultDetailText(formula);
		expect(parsed).toEqual({
			inputName: "detail_marker",
			prefix: "entered=[",
			suffix: "]",
			localText: "local row",
		});
		if (!parsed) throw new Error("The native witness was not read.");
		const suite = serializeWire(resultDetailTextWire(parsed), {
			target: "suite",
		});
		expect([...suite.instances].map((one) => one.id)).toEqual([
			"search-input:results",
		]);
		expect(readResultDetailText(suite.text)).toEqual(parsed);
		const hq = serializeWire(resultDetailTextWire(parsed), {
			target: "hq-json",
			interpolation: "no-dots",
		});
		expect(readResultDetailText(hq.text)).toEqual(parsed);
	});

	it("emits only on Details in the HQ and local projections", () => {
		const promptId = testUuid("result-detail-wire-prompt");
		const column = {
			...calculatedColumn(
				testUuid("result-detail-wire-column"),
				"Entered value",
				term(literal("local row")),
				{ notOnList: true, visibleInList: false },
			),
			searchResultDetail: {
				inputUuid: promptId,
				prefix: "entered=[",
				suffix: "]",
			},
		};
		const fixture = buildDoc({
			modules: [
				{
					name: "Visits",
					caseType: "patient",
					caseSearchConfig: { workflow: "searchFirst" },
					caseListConfig: {
						columns: [column],
						listColumnOrder: [column.uuid],
						detailColumnOrder: [column.uuid],
						searchInputs: [
							simpleSearchInputDef(
								promptId,
								"detail_marker",
								"Marker",
								"text",
								"case_name",
							),
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
		const doc = {
			...fixture,
			appSettings: { ...fixture.appSettings, runsOnlyOn: "web-apps" as const },
		};
		const module = doc.modules[doc.moduleOrder[0]];
		const hq = (screen: "results" | "details") =>
			serializeWire(hqExpressionField(column, module, doc, screen), {
				target: "hq-json",
				interpolation: "no-dots",
			});
		expect(readResultDetailText(hq("details").text)).toEqual(
			readResultDetailText(formula),
		);
		expect(hq("results").text).toBe("'local row'");
		expect(hq("results").instances.size).toBe(0);
		for (const target of ["case", "search"] as const) {
			const detail = buildLongDetail({ doc, module, moduleIndex: 0, target });
			expect(detail.instances.map((instance) => instance.id)).toEqual([
				"search-input:results",
			]);
			const out = serializeXml(detail.element);
			expect(out).toContain("current()/../../results");
			expect(out).toContain("detail_marker");
		}
	});

	it.each([
		`if(${roster}, concat('entered=[', string(${prompt}), ']'), 'local row')`,
		formula.replace("../results", "../casedb"),
		formula.replace("search-input:results", "search-input:results:inline"),
		formula.replaceAll("instance(", "instance ("),
		formula.replaceAll("'search-input:results'", "('search-input:results')"),
		formula.replace(
			`count(${prompt})`,
			"count(instance('search-input:results')/input/field)",
		),
		formula.replace(
			`count(${prompt})`,
			`count(${prompt.replace("detail_marker", "different_prompt")})`,
		),
		formula.replace("'local row'", `string(${prompt})`),
	])("does not recover a different scope or unguarded read", (text) => {
		expect(readResultDetailText(text)).toBeUndefined();
	});
});
