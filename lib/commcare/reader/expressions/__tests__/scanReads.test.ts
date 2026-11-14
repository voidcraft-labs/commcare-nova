/**
 * What the expressions of an app read, from their syntax before any is
 * bound. The failures this holds: a case property declared twice or out of
 * code-unit order; one whose case type the syntax does not fix declared on
 * a guess; a `location_data` slug missing from the reads; a tag the catalog
 * lacks missing; a step of a path taken for a property of its own.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { SlotContextRef } from "@/lib/domain/expression/types";
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
		expect(scanned.lookupTags).toEqual(["crops"]);
	});
});
