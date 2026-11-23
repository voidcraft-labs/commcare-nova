import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	advancedFixture,
	HOUSEHOLDS,
} from "@/lib/commcare/__tests__/advancedPlacementFixture";
import type { FormCaseSelection } from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type { PreviewEntryChoice } from "@/lib/session/types";
import { PreviewDataRefusal } from "../dataRefusal";
import { entrySessionData } from "../entrySessionData";
import { previewLookupData } from "../lookupEvaluation";
import type { CaseDatabaseSnapshot } from "../xpathInstances";

const table = lookupTableIdSchema.parse("018f0000-0000-7000-8000-000000000001");
const column = lookupColumnIdSchema.parse(
	"018f0000-0000-7000-8000-000000000002",
);
const definition = {
	id: table,
	name: "Assignments",
	tag: "assignments",
	definitionRevision: parseLookupRevision("1"),
	columns: [
		{
			id: column,
			label: "Record",
			wireName: "record",
			dataType: "text" as const,
		},
	],
};
function choicesFixture() {
	const { doc, formUuid } = advancedFixture({
		formType: "followup",
		operations: () => [],
	});
	const selection = (
		tag: string,
		source: FormCaseSelection["source"],
	): FormCaseSelection => ({
		tag,
		uuid: testUuid(tag),
		name: tag,
		caseType: "household",
		source,
	});
	const a = selection("from", { kind: "choose", module: HOUSEHOLDS });
	const b = selection("to", { kind: "choose", module: HOUSEHOLDS });
	const selections = [
		a,
		b,
		selection("raw", { kind: "expression", value: term(literal("v-1")) }),
		selection("worker_data", {
			kind: "worker-data",
			property: { kind: "session-user", field: "assignment" },
		}),
		selection("table", { kind: "table", table, column }),
		selection("connection", {
			kind: "index",
			selection: a.uuid,
			identifier: "visit",
		}),
	];
	const computedDatums = [
		{
			uuid: testUuid("destination"),
			key: "destination",
			value: term({
				kind: "session-datum",
				datum: { kind: "form-selection", selection: b.uuid },
			}),
		},
	];
	const form = {
		...doc.forms[formUuid],
		caseSelections: selections,
		computedDatums,
	};
	const app = { ...doc, forms: { ...doc.forms, [formUuid]: form } };
	const cases: CaseDatabaseSnapshot = {
		rows: ["h-1", "h-2", "h-3", "h-4", "v-1"].map((id) => ({
			case_id: id,
			app_id: "app",
			case_type: id === "v-1" ? "visit" : "household",
			owner_id: "worker",
			status: "open",
			opened_on: null,
			modified_on: null,
			closed_on: null,
			case_name: id,
			external_id: null,
			parent_case_id: null,
			properties: {},
		})),
		indices: ["h-1", "h-3"].map((id) => ({
			case_id: id,
			ancestor_id: "v-1",
			target_case_type: "visit",
			identifier: "visit",
			relationship: "extension",
			depth: 1,
		})),
	};
	const visit = (
		entryChoices: readonly PreviewEntryChoice[],
		options: {
			workerId?: string;
			fixtureValues?: readonly string[];
			cases?: CaseDatabaseSnapshot;
		} = {},
	) =>
		entrySessionData(app, formUuid, {
			appId: "app",
			entryKey: "entry",
			boundCases: [],
			menuSelections: {},
			entryChoices,
			caseDatabase: options.cases ?? cases,
			lookupData: previewLookupData({
				projectRevision: "1",
				definitions: [definition],
				rowsByTable: new Map([
					[
						table,
						(options.fixtureValues ?? ["v-1"]).map((id, index) => ({
							id: lookupRowIdSchema.parse(
								`018f0000-0000-7000-8000-0000000000a${index}`,
							),
							values: { [column]: id },
						})),
					],
				]),
			}),
			session: {
				context: { userid: "worker" },
				user: { assignment: options.workerId ?? "v-1" },
				userPropertySlugs: {},
			},
		});
	return { a, b, visit, cases };
}
describe("a worker's ordered form entry", () => {
	it("retains a later choice already carried by a form link while the worker supplies an earlier choice from that same list", () => {
		const { a, b, visit } = choicesFixture();
		const linked = { selectionUuid: b.uuid, caseId: "h-2" };
		expect(visit([linked]).nextSelection?.selectionUuid).toBe(a.uuid);
		const completed = visit([linked, { selectionUuid: a.uuid, caseId: "h-1" }]);
		expect(completed.nextSelection).toBeUndefined();
		expect(completed.data).toMatchObject({
			case_id_from: "h-1",
			case_id_to: "h-2",
			destination: "h-2",
		});
	});
	it("walks two independent choices from the same list and executes the suffix against their current identities", () => {
		const { a, b, visit } = choicesFixture();
		const id = (selection: FormCaseSelection, caseId: string) => ({
			selectionUuid: selection.uuid,
			caseId,
		});
		expect(visit([]).nextSelection?.selectionUuid).toBe(a.uuid);
		const first = visit([id(a, "h-1")]);
		expect(first.nextSelection?.selectionUuid).toBe(b.uuid);
		expect(first.nextSelection?.chosenCaseIds).toEqual({ [HOUSEHOLDS]: "h-1" });
		expect(first.data).toEqual({ case_id_from: "h-1" });
		const old = visit([id(a, "h-1"), id(b, "h-2")]);
		expect(old.nextSelection).toBeUndefined();
		// All four automatic actions expect a household. HQ tests existence,
		// so every one reaches the actual visit, including through an extension.
		expect(old.data).toEqual({
			case_id_from: "h-1",
			case_id_to: "h-2",
			case_id_raw: "v-1",
			case_id_worker_data: "v-1",
			case_id_table: "v-1",
			case_id_connection: "v-1",
			destination: "h-2",
		});
		expect(visit([id(a, "h-3")]).data).toEqual({ case_id_from: "h-3" });
		expect(visit([id(a, "h-3"), id(b, "h-4")]).data).toMatchObject({
			case_id_from: "h-3",
			case_id_to: "h-4",
			destination: "h-4",
		});
	});
	it("stops on the first automatic check that fails for this worker's snapshot", () => {
		const { a, b, visit, cases } = choicesFixture();
		const prefix = [
			{ selectionUuid: a.uuid, caseId: "h-1" },
			{ selectionUuid: b.uuid, caseId: "h-2" },
		];
		for (const [options, name] of [
			[
				{
					cases: {
						...cases,
						rows: cases.rows.filter((row) => row.case_id !== "v-1"),
					},
				},
				"raw",
			],
			[{ workerId: "" }, "worker_data"],
			[{ workerId: "outside" }, "worker_data"],
			[{ fixtureValues: [] }, "table"],
			[{ fixtureValues: ["v-1", "v-1"] }, "table"],
			[{ cases: { ...cases, indices: [] } }, "connection"],
		] as const) {
			expect(() => visit(prefix, options)).toThrow(PreviewDataRefusal);
			expect(() => visit(prefix, options)).toThrow(name);
		}
	});
});
