/**
 * What the expressions of an app read, from their syntax before any is
 * bound. The failures this holds: a case property declared twice or out of
 * code-unit order; one whose case type the syntax does not fix declared on
 * a guess; a property of the case a menu above chose, read in a form's own
 * slot, left undeclared; a `location_data` slug missing from the reads; a tag
 * the catalog lacks missing; a table a form only declares taken for a read; a
 * step of a path taken for a property of its own. And of the reading built on
 * the scan: a declared property no held slot reads left in the document; one
 * a held slot reads dropped from it; a tag the catalog lacks missing from
 * `unreadTables`, or a tag only declared listed there.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { slotContext } from "@/lib/domain/expression/context";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import { calculatedColumn } from "@/lib/domain/modules";
import { readExpressions } from "../index";
import { scanReads } from "../scanReads";
import {
	fieldNamed,
	onlyForm,
	readEnv,
	registration,
} from "./expressionReadFixture";

function doc() {
	return buildDoc({
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "patient", parent_type: "household", properties: [] },
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: { columns: [], searchInputs: [] },
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "q1", label: "Q1" })],
					},
				],
			},
		],
	});
}

const OWN =
	"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]";

describe("the scan of an app's expressions", () => {
	it("declares each property a fixed case type reads, once, in code-unit order", () => {
		const app = doc();
		const moduleUuid = app.moduleOrder[0] as (typeof app.moduleOrder)[number];
		const relevant: SlotContextRef = {
			entity: "field",
			uuid: fieldNamed(app, "q1"),
			slot: "relevant",
		};
		const filter: SlotContextRef = {
			entity: "module",
			uuid: moduleUuid,
			slot: "case_list_filter",
		};
		const scanned = scanReads(
			[
				registration(app, relevant, `${OWN}/zeta = 'a' and ${OWN}/alpha = 'b'`),
				registration(
					app,
					relevant,
					`count(instance('casedb')/casedb/case[@case_type = 'household'][Beta = 'x']/visits) > 0`,
				),
				registration(
					app,
					relevant,
					`instance('casedb')/casedb/case[@case_id = ${OWN}/index/parent]/village = 'x'`,
				),
				registration(app, filter, "gamma = 'y' and zeta = 'z'"),
				registration(app, relevant, `${OWN}/zeta = 'again'`),
				// No case type fixes this one: the case is another menu's.
				registration(
					app,
					relevant,
					"instance('casedb')/casedb/case[@case_id = /data/q1]/untyped = 'x'",
				),
			],
			app,
			readEnv(),
		);
		expect(scanned.caseProperties).toEqual([
			{ caseType: "household", property: "Beta" },
			{ caseType: "household", property: "village" },
			{ caseType: "household", property: "visits" },
			{ caseType: "patient", property: "alpha" },
			{ caseType: "patient", property: "gamma" },
			{ caseType: "patient", property: "zeta" },
		]);
	});

	it("declares a property a query of every case reads on the slot's own type, and a case keyed on the own case's id on that case's", () => {
		const app = doc();
		const relevant: SlotContextRef = {
			entity: "field",
			uuid: fieldNamed(app, "q1"),
			slot: "relevant",
		};
		const scanned = scanReads(
			[
				registration(
					app,
					relevant,
					"count(instance('casedb')/casedb/case[tag = 'x']) > 0",
				),
				registration(
					app,
					relevant,
					`instance('casedb')/casedb/case[@case_id = ${OWN}/@case_id]/score = 'y'`,
				),
				// Typed by a read above, so the query of every case names no
				// other type.
				registration(
					app,
					relevant,
					"count(instance('casedb')/casedb/case[score = 'z']) > 0",
				),
			],
			app,
			readEnv(),
		);
		expect(scanned.caseProperties).toEqual([
			{ caseType: "patient", property: "score" },
			{ caseType: "patient", property: "tag" },
		]);
	});

	it("declares a property of the case a menu above chose on its type, read in a form's display condition", () => {
		const app = buildDoc({
			caseTypes: [
				{ name: "household", properties: [] },
				{ name: "patient", parent_type: "household", properties: [] },
			],
			modules: [
				{
					uuid: "scan-households",
					name: "Households",
					caseType: "household",
					caseListConfig: { columns: [], searchInputs: [] },
					forms: [{ name: "Check", type: "followup", fields: [] }],
				},
				{
					name: "Patients",
					caseType: "patient",
					parentCaseModuleUuid: "scan-households",
					caseListConfig: { columns: [], searchInputs: [] },
					forms: [
						{
							uuid: "scan-visit",
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "q1", label: "Q1" })],
						},
					],
				},
			],
		});
		const display: SlotContextRef = {
			entity: "form",
			uuid: testUuid("scan-visit"),
			slot: "form_display_condition",
		};
		const scanned = scanReads(
			[
				registration(
					app,
					display,
					"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/parent_id]/village = 'x'",
				),
			],
			app,
			readEnv(),
		);
		expect(scanned.caseProperties).toEqual([
			{ caseType: "household", property: "village" },
		]);
	});

	it("collects place property slugs and table tags", () => {
		const app = doc();
		const form = onlyForm(app);
		const relevant: SlotContextRef = {
			entity: "field",
			uuid: fieldNamed(app, "q1"),
			slot: "relevant",
		};
		const scanned = scanReads(
			[
				registration(
					app,
					relevant,
					"instance('locations')/locations/location[@id = /data/q1]/location_data/zone = 'x'",
				),
				registration(
					app,
					relevant,
					"instance('locations')/locations/location[location_data/area = 'n']/@id = /data/q1",
				),
			],
			app,
			readEnv({
				instanceSources: new Map([
					[form, new Map([["crops", "jr://fixture/item-list:crops"]])],
				]),
			}),
		);
		expect(scanned.locationDataSlugs).toEqual(["area", "zone"]);
		// The form declares the table and nothing of it reads its id.
		expect(scanned.lookupTags).toEqual([]);
		expect(scanned.declaredLookupTags).toEqual(["crops"]);
	});

	it("reads a table by the id its form declares it under, or by its item-list id", () => {
		const app = doc();
		const form = onlyForm(app);
		const relevant: SlotContextRef = {
			entity: "field",
			uuid: fieldNamed(app, "q1"),
			slot: "relevant",
		};
		const scanned = scanReads(
			[
				registration(
					app,
					relevant,
					"count(instance('item-list:shadow')/crops_list/crops) > 0",
				),
				registration(
					app,
					relevant,
					"count(instance('item-list:soils')/soils_list/soils) > 0",
				),
			],
			app,
			readEnv({
				instanceSources: new Map([
					[
						form,
						new Map([
							["item-list:shadow", "jr://fixture/item-list:crops"],
							["item-list:seeds", "jr://fixture/item-list:seeds"],
						]),
					],
				]),
			}),
		);
		expect(scanned.lookupTags).toEqual(["crops", "soils"]);
		expect(scanned.declaredLookupTags).toEqual(["seeds"]);
	});
});

describe("the reading built on the scan", () => {
	it("keeps a declared property a held slot reads and drops the rest", () => {
		const app = doc();
		const relevant: SlotContextRef = {
			entity: "field",
			uuid: fieldNamed(app, "q1"),
			slot: "relevant",
		};
		const reading = readExpressions(
			app,
			[
				registration(app, relevant, `${OWN}/alpha = 'b'`),
				// Core answers no `normalize-space`, so this slot is not held,
				// and nothing else reads `omega`.
				registration(
					app,
					relevant,
					`${OWN}/omega = 'a' and normalize-space(/data/q1) = ''`,
				),
			],
			readEnv(),
		);
		expect(reading.bound[0]).toBeDefined();
		expect(reading.bound[1]).toBeUndefined();
		expect(reading.declaredProperties).toEqual([
			{ caseType: "patient", property: "alpha" },
		]);
		const patient = reading.doc.caseTypes?.find(
			(type) => type.name === "patient",
		);
		const names = patient?.properties.map((property) => property.name) ?? [];
		expect(names).toContain("alpha");
		expect(names).not.toContain("omega");
	});

	it("keeps a declared property of the case a held relation read reaches", () => {
		const column = testUuid("scan-relation-column");
		const app = buildDoc({
			caseTypes: [
				{
					name: "household",
					properties: [{ name: "size", label: "Size", data_type: "int" }],
				},
				{ name: "patient", parent_type: "household", properties: [] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							calculatedColumn(column, "Village", {
								kind: "term",
								term: { kind: "literal", value: "" },
							}),
						],
						searchInputs: [],
					},
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "q1", label: "Q1" })],
						},
					],
				},
			],
		});
		const ref: SlotContextRef = {
			entity: "module",
			uuid: app.moduleOrder[0] as (typeof app.moduleOrder)[number],
			slot: "case_list_column_expression",
			member: { columnUuid: column },
		};
		const reading = readExpressions(
			app,
			[
				registration(
					app,
					ref,
					"instance('casedb')/casedb/case[@case_id = current()/index/parent and @case_type = 'household']/village",
				),
			],
			readEnv(),
		);
		// The read names the patient it walks from; the property is the
		// household's.
		expect(reading.bound[0]).toMatchObject({
			kind: "term",
			term: { kind: "prop", property: "village" },
		});
		expect(reading.declaredProperties).toEqual([
			{ caseType: "household", property: "village" },
		]);
		const household = reading.doc.caseTypes?.find(
			(type) => type.name === "household",
		);
		expect(household?.properties.map((property) => property.name)).toEqual([
			"size",
			"village",
		]);
		const context = slotContext(reading.doc, ref, new Map());
		if (context === undefined) throw new Error("The column is not held.");
		expect(
			checkExpression(reading.bound[0] as Expression, context).errors,
		).toEqual([]);
	});

	it("lists a table the form declares and the catalog lacks as declared until an expression reads it", () => {
		const app = doc();
		const relevant: SlotContextRef = {
			entity: "field",
			uuid: fieldNamed(app, "q1"),
			slot: "relevant",
		};
		const env = readEnv({
			instanceSources: new Map([
				[onlyForm(app), new Map([["crops", "jr://fixture/item-list:crops"]])],
			]),
		});
		const declared = readExpressions(
			app,
			[registration(app, relevant, "/data/q1 = 'x'")],
			env,
		);
		expect(declared.unreadTables).toEqual([]);
		expect(declared.declaredTables).toEqual(["crops"]);
		const read = readExpressions(
			app,
			[
				registration(
					app,
					relevant,
					"count(instance('crops')/crops_list/crops) > 0",
				),
			],
			env,
		);
		expect(read.unreadTables).toEqual(["crops"]);
		expect(read.declaredTables).toEqual([]);
	});
});
