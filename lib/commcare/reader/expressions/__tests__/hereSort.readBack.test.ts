/**
 * An independent order calculation that reads `here()`, in an app that runs
 * only on Android, read back from Nova's own export.
 *
 * Contract: the reading settles each calculation's comparison against the
 * type the calculation orders by under the declaration that admits
 * `here()`, so it keeps a comparison that differs from that type's (a text
 * comparison of a whole number) and leaves out one that agrees (a
 * whole-number comparison, written as HQ's `int`). The document then
 * reads back whole, and the Android declaration the reading offers passes the
 * publish findings.
 *
 * Plausible failure: the settle types the calculation under both platforms,
 * where `here()` is refused, so the calculation's own comparison reads as
 * text: an `int` row then keeps an integer comparison the Android gate
 * reads as its own, and a `plain` row loses its text one, which under
 * Android writes `int` where HQ stored `plain`.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	type BlueprintDoc,
	type CalculatedSort,
	NEW_APP_SETTINGS,
	proseText,
} from "@/lib/domain";
import { ifExpr, literal, prop, term } from "@/lib/domain/expression";
import { publishFindings } from "@/proof/corpus/editBatches";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf, readHqApp } from "../../index";

/** Patients ordered by an independent calculation that reads where the worker is. */
function patients(comparator: CalculatedSort["comparator"]): BlueprintDoc {
	return buildDoc({
		appName: "Here first",
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		modules: [
			{
				uuid: testUuid("nearest-module"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					calculatedSorts: [
						{
							uuid: testUuid("nearest-sort"),
							// Cases saved where the worker stands first.
							expression: ifExpr(
								{
									kind: "eq",
									left: { kind: "here" },
									right: term(prop("patient", "home")),
								},
								term(literal(0)),
								term(literal(1)),
							),
							direction: "asc",
							priority: 0,
							label: "Nearest",
							...(comparator !== undefined && { comparator }),
						},
					],
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "home", label: proseText("Home"), data_type: "geopoint" },
				],
			},
		],
	});
}

function comparable(doc: BlueprintDoc): Record<string, unknown> {
	const plain = JSON.parse(JSON.stringify(toPersistableDoc(doc))) as Record<
		string,
		unknown
	>;
	delete plain.appId;
	delete (plain.appSettings as { runsOnlyOn?: unknown }).runsOnlyOn;
	return plain;
}

describe("an order calculation that reads here()", () => {
	it.each([
		["its own whole-number comparison", undefined, "int"],
		["a text comparison", "text", "plain"],
	] as const)("reads back with %s", async (_name, comparator, wireType) => {
		const doc = patients(comparator);
		expect(publishFindings(doc, undefined)).toEqual([]);
		const body = exportedBody(doc);
		const sorts = (
			body as unknown as {
				modules: {
					case_details: {
						short: {
							sort_elements: { sort_calculation: string; type: string }[];
						};
					};
				}[];
			}
		).modules[0].case_details.short.sort_elements;
		expect(
			sorts.filter((row) => row.sort_calculation !== "").map((row) => row.type),
		).toEqual([wireType]);
		const outcome = readHqApp(
			await inputFor(body, {
				resolver: matchingResolver(
					doc.appId,
					externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
				),
				knownCaseTypes: knownCaseTypesOf(doc),
				recordDialect: recordDialectRoundTrip,
			}),
		);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error(
				`The export read to an account: ${JSON.stringify(outcome.findings.slice(0, 3))}`,
			);
		const read = outcome.draft.doc;
		const expected = READER_CANONICAL_CHOICES.reduce(
			(current, choice) => choice.apply(current),
			doc,
		);
		expect(comparable(read)).toEqual(comparable(expected));
		const { declaration } = outcome.draft;
		expect(declaration.kind).toBe("choices");
		if (declaration.kind === "choices")
			expect(declaration.choices.map((choice) => choice.runsOnlyOn)).toEqual([
				"android",
			]);
		expect(
			publishFindings(
				{
					...read,
					appSettings: { ...read.appSettings, runsOnlyOn: "android" },
				},
				undefined,
			),
		).toEqual([]);
	});
});
