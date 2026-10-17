/**
 * A raw session read of a datum no menu of the app supplies.
 *
 * Core refuses to load a form whose logic reads a session datum its entry
 * does not declare, so the form never opens. The rule takes the declared ids
 * from the projection the compiler writes each entry from, and reads each
 * exact `session/data/<id>` step through Nova's XPath grammar.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	type FormSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import type { ValidationError } from "../errors";
import { runValidation } from "../runner";

const CASE_MODULE = testUuid("session-read-case-module");

const session = (id: string) =>
	`instance('commcaresession')/session/data/${id}`;

function readDoc(
	type: FormSpec["type"],
	fields: FieldSpec[],
	options: { several?: boolean; form?: Partial<FormSpec> } = {},
): BlueprintDoc {
	return buildDoc({
		appName: "Session reads",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: CASE_MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					...(options.several && {
						selection: { kind: "multiple" as const, maximum: 10 },
					}),
				},
				forms: [
					{
						name: "Visit",
						type,
						fields: [
							f({
								kind: "text",
								id: "name",
								label: proseText("Name"),
								...(type === "registration" && {
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							}),
							...fields,
						],
						...options.form,
					},
				],
			},
		],
	});
}

const hiddenReading = (id: string): FieldSpec =>
	f({ kind: "hidden", id: "point", calculate: session(id) });

function findings(doc: BlueprintDoc): ValidationError[] {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
}

describe("SESSION_DATUM_NOT_SUPPLIED", () => {
	it("refuses a hidden value that reads supply_point_id, located at its slot", () => {
		const refused = findings(
			readDoc("followup", [hiddenReading("supply_point_id")]),
		);
		expect(refused.map((error) => error.code)).toEqual([
			"SESSION_DATUM_NOT_SUPPLIED",
		]);
		const [error] = refused;
		expect(error?.location).toMatchObject({
			fieldId: "point",
			field: "calculate",
			formName: "Visit",
		});
		expect(error?.details).toEqual({
			datumId: "supply_point_id",
			slot: "calculate",
			carrier: "field",
		});
		expect(error?.message).toBe(
			`"point" reads "supply_point_id" from the session, but no menu of this app supplies it, so CommCare can't open "Visit". You can read a question, a case property or the worker's own record instead.`,
		);
		expect(userFacingError(error as ValidationError)).toBe(
			`"point" reads "supply_point_id" from the session, but no menu of this app supplies it, so CommCare can't open "Visit". You can read a question, a case property or the worker's own record instead.`,
		);
	});

	it("accepts case_id in a follow-up form, whose entry declares it", () => {
		expect(findings(readDoc("followup", [hiddenReading("case_id")]))).toEqual(
			[],
		);
	});

	it("refuses case_id in a survey form, whose entry declares no case", () => {
		const refused = findings(readDoc("survey", [hiddenReading("case_id")]));
		expect(refused.map((error) => error.code)).toEqual([
			"SESSION_DATUM_NOT_SUPPLIED",
		]);
		expect(refused[0]?.details?.datumId).toBe("case_id");
	});

	it("accepts a multi-select menu's selected_cases where the entry declares it", () => {
		expect(
			findings(
				readDoc("followup", [hiddenReading("selected_cases")], {
					several: true,
				}),
			),
		).toEqual([]);
		expect(
			findings(readDoc("followup", [hiddenReading("selected_cases")])).map(
				(error) => error.code,
			),
		).toEqual(["SESSION_DATUM_NOT_SUPPLIED"]);
	});

	it("leaves a read of the whole session/data container to the oracle", () => {
		expect(
			findings(
				readDoc("followup", [
					f({
						kind: "hidden",
						id: "point",
						calculate: "count(instance('commcaresession')/session/data/*)",
					}),
				]),
			),
		).toEqual([]);
	});

	it("says a form link's read never holds a value, offering no question", () => {
		const refused = findings(
			readDoc("followup", [], {
				form: {
					postSubmit: "app_home",
					formLinks: [
						{
							condition: `${session("supply_point_id")} = 'x'`,
							target: { type: "module", moduleUuid: CASE_MODULE },
						},
					],
				},
			}),
		).filter((error) => error.code === "SESSION_DATUM_NOT_SUPPLIED");
		expect(refused).toHaveLength(1);
		expect(refused[0]?.details).toMatchObject({
			slot: "form_link_condition",
			carrier: "form_link",
		});
		expect(userFacingError(refused[0] as ValidationError)).toBe(
			`A link from "Visit" reads "supply_point_id" from the session, but no menu of this app supplies it, so it never holds a value. You can read a case property or the worker's own record instead.`,
		);
	});

	it("says a CommCare Connect setting's read never holds a value", () => {
		const doc = buildDoc({
			appName: "Session reads",
			connectType: "deliver",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Deliver",
							type: "survey",
							fields: [
								f({ kind: "text", id: "name", label: proseText("Name") }),
							],
							connect: {
								deliver_unit: {
									id: "home_visit",
									name: "Home visit",
									entity_id: session("supply_point_id"),
								},
							} as never,
						},
					],
				},
			],
		});
		const refused = findings(doc);
		expect(refused.map((error) => error.code)).toEqual([
			"SESSION_DATUM_NOT_SUPPLIED",
		]);
		expect(refused[0]?.details).toMatchObject({
			slot: "deliver_entity_id",
			carrier: "connect",
		});
		expect(userFacingError(refused[0] as ValidationError)).toBe(
			`A CommCare Connect setting of "Deliver" reads "supply_point_id" from the session, but no menu of this app supplies it, so it never holds a value. You can read a question, a case property or the worker's own record instead.`,
		);
	});
});
