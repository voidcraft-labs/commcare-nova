import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { literal, term } from "@/lib/domain/expression";
import { calculatedColumn, simpleSearchInputDef } from "@/lib/domain/modules";
import { hqHtmlUnescape, instanceScanCuts } from "../../../hqInstanceScan";
import { serializeXml } from "../../../serializeXml";
import { buildLongDetail } from "../../../suite/case-list/longDetail";
import { hqExpressionField } from "../../../suite/case-list/orderPlanOptions";
import { resultDetailTextWire } from "../../../suite/case-list/resultDetailText";
import { serializeWire } from "../../../xpath/wire/serialize";
import { readResultDetailText } from "../resultDetailText";
import { closedCodes, listOf, readLists } from "./listReading";

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

	it.each(["instance('unknown-name')", "instance(&apos;unknown-name&apos;)"])(
		"preserves protected literal text through HQ JSON without adding a false instance",
		(prefix) => {
			const content = {
				inputName: "detail_marker",
				prefix,
				suffix: prefix,
				localText: prefix,
			};
			const printed = serializeWire(resultDetailTextWire(content), {
				target: "hq-json",
				interpolation: "none",
			});
			expect(instanceScanCuts(hqHtmlUnescape(printed.text))).toHaveLength(2);
			expect(readResultDetailText(printed.text)).toEqual(content);
			const rawLiteral = prefix.includes("'") ? `"${prefix}"` : `'${prefix}'`;
			const raw = formula.replace("'entered=['", rawLiteral);
			expect(readResultDetailText(raw)).toBeUndefined();
		},
	);

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
					caseSearchConfig: {},
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

	it.each([true, false])(
		"binds the source prompt identity only when it is offered (%s)",
		async (offered) => {
			const column = calculatedColumn(
				testUuid("read-result-detail-column"),
				"Entered value",
				term(literal("local row")),
				{ notOnList: true, visibleInList: false },
			);
			const doc = buildDoc({
				modules: [
					{
						name: "Visits",
						caseType: "patient",
						caseListMenuItem: {},
						caseSearchConfig: {},
						caseListConfig: {
							columns: [column],
							listColumnOrder: [column.uuid],
							detailColumnOrder: [column.uuid],
							searchInputs: [
								simpleSearchInputDef(
									testUuid("read-result-detail-prompt"),
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
			const outcome = await readLists(doc, {
				edit: (app) => {
					app.cloudcare_enabled = true;
					const menu = app.modules[0];
					expect(menu.search_config.auto_launch).toBe(true);
					expect(menu.search_config.inline_search).not.toBe(true);
					expect(menu.search_config.default_search).not.toBe(true);
					const stored = menu.case_details.long.columns.find(
						(one) => one.useXpathExpression === true,
					);
					if (!stored) throw new Error("No stored Details calculation.");
					stored.field = offered
						? formula
						: formula.replaceAll("detail_marker", "foreign_marker");
				},
			});
			const list = listOf(outcome);
			const calculated = list.columns.find((one) => one.kind === "calculated");
			expect(calculated).toMatchObject({
				kind: "calculated",
				expression: term(literal("local row")),
			});
			if (calculated?.kind !== "calculated")
				throw new Error("Expected Detail calculation.");
			if (offered) {
				expect(closedCodes(outcome)).toEqual([]);
				expect(calculated.searchResultDetail).toEqual({
					inputUuid: list.searchInputs[0].uuid,
					prefix: "entered=[",
					suffix: "]",
				});
			} else {
				expect(closedCodes(outcome)).toContain(
					"menus-and-case-lists/standalone-search-result-detail-without-its-offered-prompt",
				);
				expect(calculated.searchResultDetail).toBeUndefined();
			}
		},
	);

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
