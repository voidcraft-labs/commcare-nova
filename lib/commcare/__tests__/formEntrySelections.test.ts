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
} from "../formLinkProjection";
import { namingFromHqPages } from "../reader/__tests__/hqPageNames";
import { readCases } from "../reader/caseManagement/__tests__/caseReading";
import { serializeWire } from "../xpath/wire/serialize";
import { advancedFixture, HOUSEHOLDS } from "./advancedPlacementFixture";

describe("the supplies a worker opens a form with", () => {
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
