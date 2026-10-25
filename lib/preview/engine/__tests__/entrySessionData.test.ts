/**
 * One form entry's session map, the values `session/data/<id>` reads: each
 * selection from the running app's case map, each `uuid()` datum minted from
 * the entry key, and the worker-record and grouped-tile datums evaluated over
 * the device's cases, all keyed by the ids the wire prints.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type DocSpec,
	type FieldSpec,
	f,
	withUserSequences,
} from "@/lib/__tests__/docHelpers";
import type { CaseRow } from "@/lib/case-store";
import { tileFixture } from "@/lib/commcare/__tests__/tileFixture";
import { USERCASE_CASE_TYPE } from "@/lib/domain";
import { entryDatumCaseId } from "@/lib/domain/entryCaseIdentity";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedPreviewDoc } from "../../__tests__/fixtures/admittedDoc";
import {
	afterSubmitSessionDatums,
	entryCreatedCaseKeys,
	entrySessionData,
} from "../entrySessionData";
import type { PreviewSearchSessionValues } from "../identity";
import type { CaseDatabaseSnapshot } from "../xpathInstances";

const HOUSEHOLDS = testUuid("mod-households");
const REGISTER = testUuid("frm-register");
const UPDATE = testUuid("frm-update");
const VISIT = testUuid("frm-visit");
const ENTRY = "entry-1";

const SESSION: PreviewSearchSessionValues = {
	context: { userid: "worker-1", username: "ada" },
	user: {},
	userPropertySlugs: {},
};

const writer = (id: string, caseType: string, property: string): FieldSpec =>
	f({
		kind: "text",
		id,
		label: proseText(id),
		caseWrite: { caseType, property },
	});

function households(
	args: {
		/** The registration's patient is written only inside a repeat. */
		readonly patientsOnlyInRepeat?: boolean;
		readonly writesWorker?: boolean;
	} = {},
) {
	const spec: DocSpec = {
		appName: "Households",
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "village", label: proseText("Village") }],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [{ name: "mood", label: proseText("Mood") }],
			},
		],
		modules: [
			{
				uuid: "mod-households",
				name: "Households",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-register",
						name: "Register household",
						type: "registration",
						fields: [
							writer("case_name", "household", "case_name"),
							...(args.patientsOnlyInRepeat === true
								? []
								: [writer("patient_name", "patient", "case_name")]),
							...(args.patientsOnlyInRepeat === true
								? [
										f({
											kind: "repeat",
											id: "visitors",
											label: proseText("Visitors"),
											children: [
												writer("visitor_name", "patient", "case_name"),
											],
										}),
									]
								: []),
						],
					},
					{
						uuid: "frm-update",
						name: "Update household",
						type: "followup",
						fields: [
							writer("village", "household", "village"),
							...(args.writesWorker === true
								? [writer("region", USERCASE_CASE_TYPE, "region")]
								: []),
						],
					},
				],
			},
			{
				uuid: "mod-patients",
				name: "Patients",
				parentCaseModuleUuid: "mod-households",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-visit",
						name: "Visit",
						type: "followup",
						fields: [writer("mood", "patient", "mood")],
					},
				],
			},
		],
	};
	const doc = buildDoc(spec);
	const region = testUuid("worker-region");
	return assertAdmittedPreviewDoc(
		args.writesWorker === true
			? withUserSequences({
					...doc,
					userProperties: {
						[region]: { uuid: region, slug: "region", label: "Region" },
					},
				})
			: doc,
	);
}

function row(
	caseId: string,
	caseType: string,
	properties: Record<string, string> = {},
): CaseRow {
	return {
		case_id: caseId,
		app_id: "app",
		case_type: caseType,
		owner_id: "worker-1",
		status: "open",
		case_name: caseId,
		external_id: null,
		opened_on: null,
		closed_on: null,
		modified_on: null,
		parent_case_id: null,
		properties,
	} as unknown as CaseRow;
}

function session(
	doc: ReturnType<typeof households> | ReturnType<typeof tileFixture>,
	formUuid: string,
	args: Partial<Parameters<typeof entrySessionData>[2]> = {},
) {
	return entrySessionData(doc, formUuid as never, {
		appId: doc.appId,
		entryKey: ENTRY,
		boundCases: [],
		menuSelections: {},
		caseDatabase: null,
		session: SESSION,
		...args,
	});
}

describe("entrySessionData", () => {
	it("values a follow-up's own case datum with its bound case", () => {
		const doc = households();
		const map = session(doc, UPDATE, {
			boundCases: [{ caseId: "h1", caseName: "Smiths" }],
		});
		expect(map.data.case_id).toBe("h1");
		expect(map.values.get("case_id")).toEqual({
			value: "h1",
			caseName: "Smiths",
		});
	});

	it("holds the case list's filter text as stringquery when the worker typed one, and none otherwise", () => {
		const doc = households();
		const bound = { boundCases: [{ caseId: "h1", caseName: "Smiths" }] };
		expect(
			session(doc, UPDATE, { ...bound, caseListSearchText: "Smi" }).data,
		).toMatchObject({ case_id: "h1", stringquery: "Smi" });
		for (const caseListSearchText of [undefined, ""])
			expect(
				session(doc, UPDATE, {
					...bound,
					...(caseListSearchText === undefined ? {} : { caseListSearchText }),
				}).data,
			).not.toHaveProperty("stringquery");
	});

	it("values the parent selection by the module that chose it, and the child by the bound case", () => {
		const doc = households();
		const map = session(doc, VISIT, {
			boundCases: [{ caseId: "p1", caseName: "Ada" }],
			menuSelections: {
				[HOUSEHOLDS]: {
					caseType: "household",
					cases: [{ caseId: "h1", caseName: "Smiths" }],
				},
			},
		});
		// Under a parent selection the wire names the parent's datum
		// `parent_id` and the module's own `case_id`.
		expect([...map.values]).toEqual([
			["parent_id", { value: "h1", caseName: "Smiths" }],
			["case_id", { value: "p1", caseName: "Ada" }],
		]);
	});

	it("names a carried case from the device's row when the choice has no name", () => {
		const doc = households();
		const map = session(doc, UPDATE, {
			boundCases: [{ caseId: "h1" }],
			caseDatabase: { rows: [row("h1", "household")], indices: [] },
		});
		expect(map.values.get("case_id")).toEqual({ value: "h1", caseName: "h1" });
	});

	it("mints a registration's case and its child from the entry key", () => {
		const doc = households();
		const map = session(doc, REGISTER);
		const household = entryDatumCaseId(doc.appId, ENTRY, "new-case");
		const patient = entryDatumCaseId(
			doc.appId,
			ENTRY,
			"new-child-case:patient",
		);
		expect(map.data.case_id_new_household_0).toBe(household);
		expect(map.data.case_id_new_patient_1).toBe(patient);
		expect(map.newCaseId).toBe(household);
		expect(household).not.toBe(patient);
	});

	it("mints the same ids for the same entry and new ones for a new entry", () => {
		const doc = households();
		const first = session(doc, REGISTER);
		expect(session(doc, REGISTER).data).toEqual(first.data);
		const cleared = session(doc, REGISTER, { entryKey: "entry-2" });
		expect(cleared.data.case_id_new_household_0).not.toBe(
			first.data.case_id_new_household_0,
		);
		const otherApp = session(doc, REGISTER, { appId: "app-2" });
		expect(otherApp.data.case_id_new_household_0).not.toBe(
			first.data.case_id_new_household_0,
		);
	});

	it("mints no id for an app not saved yet, and still holds its selections", () => {
		const doc = households();
		expect(session(doc, REGISTER, { appId: undefined }).data).toEqual({});
		expect(
			session(doc, UPDATE, { appId: undefined, boundCases: [{ caseId: "h1" }] })
				.data,
		).toEqual({ case_id: "h1" });
	});

	it("names exactly the cases its submission creates with minted ids", () => {
		expect([...entryCreatedCaseKeys(households(), REGISTER)].sort()).toEqual([
			"new-case",
			"new-child-case:patient",
		]);
		// A repeat's children are minted per iteration on a device; no datum
		// names them, so the entry names none of that type.
		expect([
			...entryCreatedCaseKeys(
				households({ patientsOnlyInRepeat: true }),
				REGISTER,
			),
		]).toEqual(["new-case"]);
		expect([...entryCreatedCaseKeys(households(), UPDATE)]).toEqual([]);
	});

	it("evaluates the worker's record over the device's cases", () => {
		const doc = households({ writesWorker: true });
		const usercase = {
			...row("worker-case", USERCASE_CASE_TYPE, { hq_user_id: "worker-1" }),
			case_name: "Ada",
		} as CaseRow;
		const map = session(doc, UPDATE, {
			boundCases: [{ caseId: "h1" }],
			caseDatabase: { rows: [usercase, row("h1", "household")], indices: [] },
		});
		expect(map.data.usercase_id).toBe("worker-case");
		expect(map.values.get("usercase_id")).toEqual({
			value: "worker-case",
			caseName: "Ada",
		});
	});

	it("evaluates a grouped tile's companion over the chosen case's index", () => {
		const doc = tileFixture("grouped-one");
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const snapshot: CaseDatabaseSnapshot = {
			rows: [row("v1", "visit"), row("v2", "visit"), row("h1", "household")],
			indices: [
				{
					case_id: "v1",
					ancestor_id: "h1",
					identifier: "parent",
					relationship: "child",
					depth: 1,
					target_case_type: "household",
				},
			] as CaseDatabaseSnapshot["indices"],
		};
		const companion = Object.keys(
			session(doc, formUuid, {
				boundCases: [{ caseId: "v1" }],
				caseDatabase: snapshot,
			}).data,
		).find((id) => id.endsWith("_parent_ids"));
		expect(companion).toBeDefined();
		const chosen = session(doc, formUuid, {
			boundCases: [{ caseId: "v1" }],
			caseDatabase: snapshot,
		});
		expect(chosen.data[companion as string]).toBe("h1");
		const ungrouped = session(doc, formUuid, {
			boundCases: [{ caseId: "v2" }],
			caseDatabase: snapshot,
		});
		expect(ungrouped.data[companion as string]).toBe("");
	});

	it("values no datum of a form no module holds", () => {
		const doc = households();
		expect(session(doc, testUuid("missing-form")).values.size).toBe(0);
	});
});

describe("afterSubmitSessionDatums", () => {
	it("keeps every value and names the cases the submission saved", () => {
		const doc = households();
		const entry = session(doc, REGISTER);
		const household = entry.data.case_id_new_household_0 as string;
		const patient = entry.data.case_id_new_patient_1 as string;
		const after = afterSubmitSessionDatums(
			entry,
			{
				caseId: household,
				caseName: "Smiths",
				childCases: [{ caseId: patient, caseName: "Pat" }],
			},
			household,
		);
		expect(after.get("case_id_new_household_0")).toEqual({
			value: household,
			caseName: "Smiths",
		});
		expect(after.get("case_id_new_patient_1")).toEqual({
			value: patient,
			caseName: "Pat",
		});
	});

	it("values a replayed registration with the case its receipt saved", () => {
		const entry = session(households(), REGISTER);
		const patient = entry.data.case_id_new_patient_1 as string;
		const after = afterSubmitSessionDatums(
			entry,
			{ caseId: "saved-before-minting", caseName: "Smiths", childCases: [] },
			"saved-before-minting",
		);
		expect(after.get("case_id_new_household_0")).toEqual({
			value: "saved-before-minting",
			caseName: "Smiths",
		});
		expect(after.get("case_id_new_patient_1")).toEqual({ value: patient });
	});

	it("holds no session for an entry no running app opened", () => {
		expect(afterSubmitSessionDatums(undefined, { childCases: [] }).size).toBe(
			0,
		);
	});
});
