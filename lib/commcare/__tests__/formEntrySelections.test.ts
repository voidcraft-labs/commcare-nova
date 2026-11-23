import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { formCaseSelections } from "@/lib/domain/advancedEntryDatums";
import { literal, term } from "@/lib/domain/expression/builders";
import type { FormCaseSelection } from "@/lib/domain/formEntryCases";
import { validateFormEntryCases } from "@/lib/domain/formEntryValidation";
import { planFormCaseWire } from "../casePlacementPlan";
import {
	entryDatumIds,
	entrySessionDatums,
	formLinkProjectionContext,
	physicalEntrySupplyProblems,
} from "../formLinkProjection";
import { namingFromHqPages } from "../reader/__tests__/hqPageNames";
import { readCases } from "../reader/caseManagement/__tests__/caseReading";
import { serializeWire } from "../xpath/wire/serialize";
import {
	advancedFixture,
	HOUSEHOLD_VISIT,
	HOUSEHOLDS,
	read,
} from "./advancedPlacementFixture";

describe("the supplies a worker opens a form with", () => {
	it("protects the physical new-case datum from a calculated key and a record tag with the same spelling", () => {
		const { doc, formUuid, moduleUuid } = advancedFixture({
			formType: "registration",
			operations: () => [
				{
					action: "own",
					uuid: testUuid("own"),
					id: "own_case",
					name: read("name"),
				},
			],
		});
		const collision = "case_id_new_household_0";
		const choice: FormCaseSelection = {
			uuid: testUuid("choice"),
			name: "Contact",
			caseType: "household",
			tag: "new_household_0",
			source: { kind: "choose", module: HOUSEHOLDS },
		};
		for (const form of [
			{ ...doc.forms[formUuid], caseSelections: [choice] },
			{
				...doc.forms[formUuid],
				computedDatums: [
					{
						uuid: testUuid("memo"),
						key: collision,
						value: term(literal("ready")),
					},
				],
			},
			{
				...doc.forms[formUuid],
				caseSelections: [{ ...choice, tag: "contact" }],
			},
		]) {
			const current = { ...doc, forms: { ...doc.forms, [formUuid]: form } };
			const ctx = formLinkProjectionContext(current, {
				entryMetadataOnly: true,
			});
			const problems = physicalEntrySupplyProblems(
				current,
				ctx,
				moduleUuid,
				formUuid,
			);
			if (form.caseSelections?.[0]?.tag === "contact")
				expect(problems).toEqual([]);
			else
				expect(problems).toEqual([
					{
						kind: "duplicate-key",
						name: collision,
						message: expect.stringContaining(collision),
					},
				]);
		}
	});

	it("follows a connection after parent alignment only when the source keeps its actual name", () => {
		const { doc, formUuid, moduleUuid } = advancedFixture({
			menu: "members",
			formType: "followup",
			nested: true,
			operations: () => [],
		});
		const choose = (tag: string): FormCaseSelection => ({
			uuid: testUuid(`parent-choice/${tag}`),
			name: "Choose a household",
			tag,
			caseType: "household",
			source: { kind: "choose", module: HOUSEHOLDS },
		});
		const parent = choose("household");
		for (const tag of ["household", "different"]) {
			const later = choose(tag);
			const reaches: FormCaseSelection = {
				uuid: testUuid("member-connection"),
				name: "Assigned member",
				tag: "assignment",
				caseType: "member",
				source: { kind: "index", selection: later.uuid, identifier: "member" },
			};
			const current = {
				...doc,
				modules: {
					...doc.modules,
					[HOUSEHOLDS]: {
						...doc.modules[HOUSEHOLDS],
						heldKind: "advanced" as const,
					},
				},
				forms: {
					...doc.forms,
					[HOUSEHOLD_VISIT]: {
						...doc.forms[HOUSEHOLD_VISIT],
						caseSelections: [parent],
					},
					[formUuid]: {
						...doc.forms[formUuid],
						caseSelections: [later, reaches],
					},
				},
			};
			for (const options of [{ entryMetadataOnly: true }, {}]) {
				const ctx = formLinkProjectionContext(current, options);
				const datums = entrySessionDatums(current, ctx, moduleUuid, formUuid);
				expect(datums.find((row) => row.advancedLoadTag === tag)?.id).toBe(
					"case_id_household",
				);
				expect(
					physicalEntrySupplyProblems(current, ctx, moduleUuid, formUuid).map(
						(issue) => issue.kind,
					),
				).toEqual(tag === "household" ? [] : ["aligned-connection"]);
			}
		}
	});
	it("keeps two choices from the same list distinct, even when a value reads the first after the worker answers the second", () => {
		const { doc, formUuid, moduleUuid } = advancedFixture({
			formType: "followup",
			operations: () => [],
		});
		const make = (name: string, tag: string): FormCaseSelection => ({
			uuid: testUuid(tag),
			name,
			tag,
			caseType: "household",
			source: { kind: "choose", module: HOUSEHOLDS },
		});
		const first = make("Referring household", "referring");
		const second = make("Receiving household", "receiving");
		const reached: FormCaseSelection = {
			uuid: testUuid("reached"),
			tag: "reached",
			caseType: "household",
			name: "Household to contact",
			source: {
				kind: "expression",
				value: term({
					kind: "session-datum",
					datum: { kind: "form-selection", selection: first.uuid },
				}),
			},
		};
		const computed = {
			uuid: testUuid("entry-value"),
			key: "receiving_id",
			value: term({
				kind: "session-datum",
				datum: { kind: "form-selection", selection: second.uuid },
			}),
		};
		const current = {
			...doc.forms[formUuid],
			caseSelections: [first, second, reached],
			computedDatums: [computed],
		};
		const saved = { ...doc, forms: { ...doc.forms, [formUuid]: current } };
		const ctx = formLinkProjectionContext(saved);
		expect(validateFormEntryCases(saved, current)).toEqual([]);
		const plan = planFormCaseWire(saved, formUuid);
		expect(plan.kind).toEqual("advanced");
		const values = entrySessionDatums(saved, ctx, moduleUuid, formUuid);
		expect(values.map((row) => row.id)).toEqual([
			"case_id_referring",
			"case_id_receiving",
			"case_id_reached",
			"receiving_id",
		]);
		expect(
			values
				.filter((row) => row.function)
				.map(
					(row) =>
						row.function &&
						serializeWire(row.function, { target: "suite" }).text,
				),
		).toEqual([
			"instance('commcaresession')/session/data/case_id_referring",
			"instance('commcaresession')/session/data/case_id_receiving",
		]);
		expect(
			entryDatumIds(saved, ctx, moduleUuid, formUuid).map((row) => row.refs),
		).toEqual([
			[{ kind: "form-selection", selection: first.uuid }],
			[{ kind: "form-selection", selection: second.uuid }],
			[{ kind: "form-selection", selection: reached.uuid }],
			[{ kind: "entry-value", datum: computed.uuid }],
		]);
		expect(
			validateFormEntryCases(saved, {
				...current,
				caseSelections: [reached, first, second],
			}),
		).toHaveLength(1);
	});

	it("uses stable identities for the ordinary form and distinguishes no list from an empty list", () => {
		const { doc, formUuid } = advancedFixture({
			formType: "followup",
			operations: () => [],
		});
		const implicit = formCaseSelections(doc, formUuid);
		expect(implicit).toHaveLength(1);
		expect(formCaseSelections({ ...doc }, formUuid)).toEqual(implicit);
		const saved = {
			...doc,
			forms: {
				...doc.forms,
				[formUuid]: {
					...doc.forms[formUuid],
					caseSelections: [],
					computedDatums: [
						{
							key: "at_entry",
							uuid: testUuid("constant"),
							value: term(literal("ready")),
						},
					],
				},
			},
		};
		expect(formCaseSelections(saved, formUuid)).toEqual([]);
	});
	it("reads a calculated entry value and retains its expression", async () => {
		const { doc } = advancedFixture({
			formType: "followup",
			operations: () => [],
		});
		const read = await namingFromHqPages(readCases)(doc, {
			edit(app) {
				const form = app.modules
					.flatMap((menu) => menu.forms)
					.find((row) => JSON.stringify(row.name).includes("Under test"));
				if (!form) throw new Error("The source needs the target form.");
				form.arbitrary_datums = [
					{
						doc_type: "ArbitraryDatum",
						datum_id: "receipt_status",
						datum_function: "'received'",
					},
				];
			},
		});
		expect(
			read.whole?.kind,
			JSON.stringify(
				read.whole?.kind === "account"
					? [read.whole.findings, read.whole.defects]
					: read.whole?.kind,
			),
		).toBe("read");
		if (read.whole?.kind !== "read") return;
		const forms = Object.values(read.whole.draft.doc.forms);
		expect(
			forms
				.flatMap((form) => form.computedDatums ?? [])
				.map((row) => [row.key, row.value]),
		).toEqual([["receipt_status", term(literal("received"))]]);
	});
});
