/**
 * After-submit destinations in the running preview (`formLinkEvaluation.ts`):
 * which frames a submission pushes, what a condition can read once the form
 * has closed, and which case each next form opens with.
 *
 * The fixture is a household registration that also creates a patient child
 * case, a household follow-up and close, a patient follow-up, and a survey:
 * enough for every kind of source datum (`case_id`, the registration's own
 * create datum, a subcase datum) and every kind of target.
 */

import { afterEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc as buildDocProduction,
	caseListConfig,
	type DocSpec,
	type FieldSpec,
	f,
	parseFixtureExpression,
	withUserSequences,
} from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type {
	FormLink,
	FormLinkDatum,
	FormLinkEntry,
	Uuid,
} from "@/lib/domain";
import { entryDatumCaseId } from "@/lib/domain/entryCaseIdentity";
import {
	eq,
	literal,
	sessionUserProperty,
	term,
} from "@/lib/domain/expression";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type {
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { webAppsDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { previewSessionValues } from "@/lib/preview/engine/identity";
import type {
	PreviewCaseChoice,
	PreviewMenuCaseSelection,
} from "@/lib/session/types";
import { assertAdmittedPreviewDoc } from "../../__tests__/fixtures/admittedDoc";
import { evaluate } from "../../xpath/evaluator";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { deserializeXPathWorkerValue } from "../../xpath/workerProjection";
import {
	afterSubmitSessionDatums,
	entrySessionData,
} from "../entrySessionData";
import {
	carriedCaseFor as carriedCaseForProduction,
	createFormLinkWorkerWorld,
	evaluateAfterSubmit,
	evaluateAfterSubmitAsync,
	evaluateLinkDatum,
	evaluateLinkDatumAsync,
	type FormLinkEvaluationInput,
	formLinkEvalContext,
	formLinkWorkerInstances,
	projectTargetCaseSelections as projectTargetCaseSelectionsProduction,
} from "../formLinkEvaluation";
import type { PreviewSearchSessionValues } from "../identity";
import { previewLookupData } from "../lookupEvaluation";

const runtimes = new Set<XPathRuntime>();
function ownedRuntime() {
	const runtime = new XPathRuntime({
		workerFactory: createInProcessXPathWorkerFactory(),
	});
	runtimes.add(runtime);
	return runtime;
}
afterEach(() => {
	for (const runtime of runtimes) runtime.dispose();
	runtimes.clear();
});
function buildDoc(input: DocSpec) {
	const role = testUuid("worker-role");
	const doc = withUserSequences({
		...buildDocProduction(input),
		userProperties: { [role]: { uuid: role, slug: "role", label: "Role" } },
	});
	/* The update form's one destination has a condition, so it may not run,
	 * and its otherwise is its module. */
	const update = doc.forms[UPDATE];
	if (update?.formLinks !== undefined)
		update.otherwise = { kind: "destination", destination: "module" };

	return assertAdmittedPreviewDoc(doc);
}
const ENTRY_KEY = "entry-1";

/** The id entry `ENTRY_KEY` minted for the case `key` names. */
function minted(doc: ReturnType<typeof buildDoc>, key: string): string {
	return entryDatumCaseId(doc.appId, ENTRY_KEY, key);
}

/** The session an entry of `formUuid` holds once its submission landed:
 *  its bound case, the menu's choices, and the names of the cases it saved. */
function submittedSession(
	doc: ReturnType<typeof buildDoc>,
	formUuid: Uuid,
	args: {
		readonly bound?: PreviewCaseChoice;
		readonly selections?: Readonly<Record<string, PreviewMenuCaseSelection>>;
		readonly savedNames?: Readonly<Record<string, string>>;
	} = {},
) {
	const entry = entrySessionData(doc, formUuid, {
		appId: doc.appId,
		entryKey: ENTRY_KEY,
		boundCases: args.bound === undefined ? [] : [args.bound],
		menuSelections: args.selections ?? {},
		caseDatabase: null,
		session: previewSessionValues(null, webAppsDevice()),
	});
	return afterSubmitSessionDatums(entry, {
		childCases: Object.entries(args.savedNames ?? {}).map(
			([caseId, caseName]) => ({ caseId, caseName }),
		),
	});
}

function followupSession(
	doc: ReturnType<typeof buildDoc>,
	formUuid: Uuid,
	caseId: string,
) {
	return submittedSession(doc, formUuid, { bound: { caseId } });
}

const HOUSEHOLDS = testUuid("mod-households");
const PATIENTS = testUuid("mod-patients");
const REGISTER = testUuid("frm-register");
const UPDATE = testUuid("frm-update");
const CLOSE = testUuid("frm-close");
const VISIT = testUuid("frm-visit");
const FEEDBACK = testUuid("frm-feedback");
const LINK_VISIT = testUuid("lnk-visit");
const LINK_PATIENTS = testUuid("lnk-patients");
const LINK_CLOSE = testUuid("lnk-close");

const SESSION: PreviewSearchSessionValues = {
	context: { userid: "u1", username: "ada" },
	user: { role: "supervisor" },
	userPropertySlugs: {},
};

const writer = (
	id: string,
	caseType: string,
	property: string,
	kind: FieldSpec["kind"] = "text",
): FieldSpec =>
	f({
		kind,
		id,
		label: proseText(id),
		caseWrite: { caseType, property },
	});

function spec(args: { readonly patientsInRepeat?: boolean } = {}): DocSpec {
	return {
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
						formLinks: [
							{
								uuid: "lnk-visit",
								condition: eq(
									{
										...sessionUserProperty(testUuid("worker-role")),
										source: "worker-record",
									},
									literal("supervisor"),
								),
								target: { type: "form", moduleUuid: PATIENTS, formUuid: VISIT },
							},
							{
								uuid: "lnk-patients",
								target: { type: "module", moduleUuid: PATIENTS },
							},
						],
						fields: [
							writer("case_name", "household", "case_name"),
							writer("patient_name", "patient", "case_name"),
							...(args.patientsInRepeat === true
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
						formLinks: [
							{
								uuid: "lnk-close",
								condition: "#household/village = 'north'",
								target: {
									type: "form",
									moduleUuid: HOUSEHOLDS,
									formUuid: CLOSE,
								},
							},
						],
						fields: [writer("village", "household", "village")],
					},
					{
						uuid: "frm-close",
						name: "Close household",
						type: "close",
						fields: [writer("village", "household", "village")],
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
			{
				uuid: "mod-surveys",
				name: "Surveys",
				forms: [
					{
						uuid: "frm-feedback",
						name: "Feedback",
						type: "survey",
						formLinks: [
							{
								uuid: "lnk-survey",
								target: { type: "form", moduleUuid: PATIENTS, formUuid: VISIT },
								datums: [
									{
										name: { kind: "selected-case", module: PATIENTS },
										xpath: "'p-manual'",
									},
									{
										name: { kind: "selected-case", module: HOUSEHOLDS },
										xpath: "'h-manual'",
									},
								],
							},
						],
						fields: [
							f({ kind: "text", id: "comment", label: proseText("Comment") }),
						],
					},
				],
			},
		],
	};
}

function inputFor(
	doc: ReturnType<typeof buildDoc>,
	overrides: Partial<FormLinkEvaluationInput> = {},
): FormLinkEvaluationInput {
	assertAdmittedPreviewDoc(doc);
	return {
		doc,
		formUuid: REGISTER,
		session: SESSION,
		usercase: { role: "supervisor" },
		sessionDatums: new Map(),
		...overrides,
	};
}

function nestedPatientDoc(): ReturnType<typeof buildDoc> {
	const doc = buildDoc(spec());
	doc.modules[PATIENTS].parentModuleUuid = HOUSEHOLDS;
	// HQ aligns a child entry against the root module's first form. Put a
	// case-loading form first so the patient's ordinary `case_id` collides
	// with the root selection and becomes `case_id_patient`.
	doc.formOrder[HOUSEHOLDS] = [UPDATE, REGISTER, CLOSE];
	/* HQ's settings page offers no submenu as a link target from a root
	 * menu's form (`views/forms.py::_get_linkable_forms_context`). */
	doc.forms[REGISTER].formLinks = doc.forms[REGISTER].formLinks?.filter(
		(link) => link.uuid !== LINK_PATIENTS,
	);
	const surveyLink = doc.forms[FEEDBACK].formLinks?.[0];
	if (surveyLink)
		surveyLink.datums = [
			{
				name: { kind: "selected-case", module: HOUSEHOLDS },
				xpath: term(literal("h-manual")),
			},
			{
				name: { kind: "selected-case", module: PATIENTS },
				xpath: term(literal("p-manual")),
			},
		];
	return assertAdmittedPreviewDoc(doc);
}

function linksOf(doc: ReturnType<typeof buildDoc>, formUuid: string) {
	const links = doc.forms[testUuid(formUuid)]?.formLinks;
	if (links === undefined) throw new Error(`${formUuid} has no links`);
	return links;
}

function linkNamed(
	doc: ReturnType<typeof buildDoc>,
	formUuid: string,
	linkUuid: string,
): FormLink {
	const link = linksOf(doc, formUuid).find(
		(candidate) => candidate.uuid === testUuid(linkUuid),
	);
	if (link === undefined) throw new Error(`${linkUuid} is not on ${formUuid}`);
	return link;
}

describe("form-link worker instances", () => {
	it("evaluates a submitted case property after the request is structured-cloned", async () => {
		const doc = buildDoc(spec());
		const caseId = "household-1";
		const input = inputFor(doc, {
			formUuid: UPDATE,
			sessionDatums: followupSession(doc, UPDATE, caseId),
			caseDatabase: {
				rows: [
					{
						case_id: caseId,
						app_id: doc.appId,
						case_type: "household",
						owner_id: "u1",
						status: "open",
						opened_on: new Date("2026-08-01T00:00:00.000Z"),
						modified_on: new Date("2026-08-02T00:00:00.000Z"),
						closed_on: null,
						case_name: "Household",
						external_id: null,
						parent_case_id: null,
						properties: { village: "north" },
					},
				],
				indices: [],
			},
		});
		const runtime = ownedRuntime();
		const world = createFormLinkWorkerWorld(input, "submission-world");
		const choices = await evaluateAfterSubmitAsync({
			input,
			world,
			evaluate: async (source, instances) => {
				const result = await runtime.request({
					dayNumberEpoch: "device-zone",
					entryKey: "entry",
					revision: 1,
					profile: "form-link",
					source,
					instances,
				});
				if (!result.ok) throw new Error(result.error.code);
				return deserializeXPathWorkerValue(result.value);
			},
		});

		expect(choices).toMatchObject([
			{ kind: "destination", link: { uuid: LINK_CLOSE } },
		]);
		runtime.dispose();
	});

	it("resolves both the suite fixture id and XForm tag for a declared lookup", async () => {
		const tableId = lookupTableIdSchema.parse(
			"018f0000-0000-7000-8000-000000000001",
		);
		const columnId = lookupColumnIdSchema.parse(
			"018f0000-0000-7000-8000-0000000000c1",
		);
		const definition: LookupTableDefinition = {
			id: tableId,
			name: "Clinics",
			tag: "clinics",
			definitionRevision: parseLookupRevision("1"),
			columns: [
				{ id: columnId, wireName: "code", label: "Code", dataType: "text" },
			],
		};
		const row: LookupFixtureRow = {
			id: lookupRowIdSchema.parse("018f0000-0000-7000-8000-0000000000a1"),
			values: { [columnId]: "north" },
		};
		const lookupData = previewLookupData({
			projectRevision: "1",
			definitions: [definition],
			rowsByTable: new Map([[tableId, [row]]]),
		});
		const naming = lookupData.naming.tables[0];
		if (naming === undefined) throw new Error("Expected lookup naming");
		const input = inputFor(buildDoc(spec()), {
			lookupData,
			caseDatabase: { rows: [], indices: [] },
		});
		const runtime = ownedRuntime();
		for (const instanceId of [naming.xformInstanceId, naming.fixtureId]) {
			const source = `instance('${instanceId}')/${naming.listElementName}/${naming.rowElementName}/${naming.columns[0]?.wireName}`;
			expect(evaluate(source, formLinkEvalContext(input))).toBe("north");
			await expect(
				runtime.request({
					dayNumberEpoch: "device-zone",
					entryKey: "entry",
					revision: 1,
					profile: "form-link",
					source,
					instances: formLinkWorkerInstances(input),
				}),
			).resolves.toMatchObject({ ok: true, value: "north" });
		}
		runtime.dispose();
	});
});

function householdRow(
	doc: ReturnType<typeof buildDoc>,
	caseId: string,
	properties: Readonly<Record<string, string>>,
) {
	return {
		case_id: caseId,
		app_id: doc.appId,
		case_type: "household",
		owner_id: "u1",
		status: "open",
		opened_on: null,
		modified_on: null,
		closed_on: null,
		case_name: "Household",
		external_id: null,
		parent_case_id: null,
		properties,
	};
}

function patientRow(doc: ReturnType<typeof buildDoc>, caseId: string) {
	return {
		...householdRow(doc, caseId, {}),
		case_type: "patient",
		case_name: "Patient",
	};
}

describe("evaluateAfterSubmit", () => {
	it("pushes every destination that holds, the author's first on top", () => {
		const doc = buildDoc(spec());
		const choices = evaluateAfterSubmit({ input: inputFor(doc) });
		/* Emitted in reverse author order, so the last pushed, which runs
		 * first, is the author's first destination. */
		expect(choices).toMatchObject([
			{ kind: "destination", index: 1, link: { uuid: LINK_PATIENTS } },
			{ kind: "destination", index: 0, link: { uuid: LINK_VISIT } },
		]);
	});

	it("leaves out a destination whose condition does not hold", () => {
		const doc = buildDoc(spec());
		const choices = evaluateAfterSubmit({
			input: inputFor(doc, { usercase: { role: "nurse" } }),
		});
		expect(choices).toMatchObject([
			{ kind: "destination", index: 1, link: { uuid: LINK_PATIENTS } },
		]);
	});

	it("reads case properties as they are after the submission, and runs the otherwise when no destination that may not run holds", () => {
		const doc = buildDoc(spec());
		const submittedHousehold = (village: string) =>
			inputFor(doc, {
				formUuid: UPDATE,
				sessionDatums: followupSession(doc, UPDATE, "household-1"),
				caseDatabase: {
					rows: [householdRow(doc, "household-1", { village })],
					indices: [],
				},
			});
		expect(
			evaluateAfterSubmit({ input: submittedHousehold("north") }),
		).toMatchObject([{ kind: "destination", link: { uuid: LINK_CLOSE } }]);
		expect(evaluateAfterSubmit({ input: submittedHousehold("south") })).toEqual(
			[{ kind: "otherwise", destination: "module" }],
		);
	});

	it("reads an absent case property as blank, the device's missing node", () => {
		const doc = buildDoc(spec());
		expect(
			evaluateAfterSubmit({ input: inputFor(doc, { formUuid: UPDATE }) }),
		).toEqual([{ kind: "otherwise", destination: "module" }]);
	});

	it("pushes a destination without a condition every time, and no fallback beside it", () => {
		const doc = buildDoc(spec());
		const [first] = linksOf(doc, "frm-update");
		if (first === undefined) throw new Error("fixture has no link");
		doc.forms[UPDATE].formLinks = [{ ...first, condition: undefined }];
		delete doc.forms[UPDATE].otherwise;
		expect(
			evaluateAfterSubmit({ input: inputFor(doc, { formUuid: UPDATE }) }),
		).toMatchObject([{ kind: "destination", index: 0 }]);
	});

	it("holds a carried case to the device: a destination whose case is missing is not pushed, and the otherwise runs", () => {
		const doc = buildDoc(spec());
		doc.forms[FEEDBACK].otherwise = {
			kind: "destination",
			destination: "firstMenu",
		};
		assertAdmittedPreviewDoc(doc);
		const withCases = (rows: ReturnType<typeof householdRow>[]) =>
			inputFor(doc, {
				formUuid: FEEDBACK,
				caseDatabase: { rows, indices: [] },
			});
		expect(evaluateAfterSubmit({ input: withCases([]) })).toEqual([
			{ kind: "otherwise", destination: "firstMenu" },
		]);
		/* Each carried value is its own guard: one case on the device is not
		 * enough. */
		expect(
			evaluateAfterSubmit({ input: withCases([patientRow(doc, "p-manual")]) }),
		).toEqual([{ kind: "otherwise", destination: "firstMenu" }]);
		/* A case of another type under the carried id is not the case. */
		expect(
			evaluateAfterSubmit({
				input: withCases([
					householdRow(doc, "p-manual", {}),
					householdRow(doc, "h-manual", {}),
				]),
			}),
		).toEqual([{ kind: "otherwise", destination: "firstMenu" }]);
		expect(
			evaluateAfterSubmit({
				input: withCases([
					patientRow(doc, "p-manual"),
					householdRow(doc, "h-manual", {}),
				]),
			}),
		).toMatchObject([
			{ kind: "destination", link: { uuid: testUuid("lnk-survey") } },
		]);
	});

	it("follows an otherwise link where no destination that may not run holds", () => {
		const doc = buildDoc(spec());
		const otherwiseUuid = testUuid("lnk-otherwise");
		doc.forms[UPDATE].otherwise = {
			kind: "link",
			uuid: otherwiseUuid,
			target: { type: "this-form" },
		};
		assertAdmittedPreviewDoc(doc);
		const choices = evaluateAfterSubmit({
			input: inputFor(doc, {
				formUuid: UPDATE,
				sessionDatums: followupSession(doc, UPDATE, "household-1"),
				caseDatabase: {
					rows: [householdRow(doc, "household-1", { village: "south" })],
					indices: [],
				},
			}),
		});
		expect(choices).toMatchObject([
			{ kind: "otherwise-link", link: { uuid: otherwiseUuid } },
		]);
	});

	it("pushes a form without destinations its own after-submit frame, and none for the app home", () => {
		const doc = buildDoc(spec());
		doc.forms[CLOSE].postSubmit = "module";
		expect(
			evaluateAfterSubmit({ input: inputFor(doc, { formUuid: CLOSE }) }),
		).toEqual([{ kind: "post-submit", destination: "module" }]);
		doc.forms[CLOSE].postSubmit = "app_home";
		expect(
			evaluateAfterSubmit({ input: inputFor(doc, { formUuid: CLOSE }) }),
		).toEqual([]);
	});

	it("evaluates every frame in one post-submit world", async () => {
		const doc = buildDoc(spec());
		const input = inputFor(doc);
		const world = createFormLinkWorkerWorld(input, "one-world");
		const requests: Parameters<
			Parameters<typeof evaluateAfterSubmitAsync>[0]["evaluate"]
		>[1][] = [];
		const choices = await evaluateAfterSubmitAsync({
			input,
			world,
			evaluate: async (source, instances) => {
				requests.push(instances);
				return evaluate(source, formLinkEvalContext(input));
			},
		});
		/* Only the conditional destination needs evaluating; it and every
		 * later read share the world the first request opened. */
		expect(choices).toHaveLength(2);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			worldKey: "one-world",
			initializeWorld: true,
		});
		expect(formLinkWorkerInstances(input, world)).toMatchObject({
			worldKey: "one-world",
			initializeWorld: false,
		});
	});

	it("propagates an async condition failure instead of selecting the otherwise", async () => {
		const doc = buildDoc(spec());
		await expect(
			evaluateAfterSubmitAsync({
				input: inputFor(doc, { formUuid: UPDATE }),
				evaluate: async () => {
					throw new Error("worker failed");
				},
			}),
		).rejects.toThrow("worker failed");
	});

	it("propagates an async manual-datum failure instead of returning blank", async () => {
		const doc = buildDoc(spec());
		const datum: FormLinkDatum = {
			name: { kind: "selected-case", module: PATIENTS },
			xpath: term(literal("patient-1")),
		};
		const link = linkNamed(doc, "frm-feedback", "lnk-survey");
		const input = withFixtureLink(inputFor(doc), FEEDBACK, {
			...link,
			datums: [datum],
		});
		await expect(
			evaluateLinkDatumAsync(datum, input, link.uuid, async () => {
				throw new Error("worker failed");
			}),
		).rejects.toThrow("worker failed");
	});
});

describe("formLinkEvalContext", () => {
	it("serves session context and the source entry's own datums", () => {
		const doc = buildDoc(spec());
		const ctx = formLinkEvalContext(
			inputFor(doc, {
				sessionDatums: new Map([["case_id", { value: "h1" }]]),
			}),
		);
		expect(
			evaluate("instance('commcaresession')/session/context/username", ctx),
		).toBe("ada");
		expect(
			evaluate("instance('commcaresession')/session/data/case_id", ctx),
		).toBe("h1");
		// A datum nothing filled is an absent node, not an error.
		expect(
			evaluate("instance('commcaresession')/session/data/usercase_id", ctx),
		).toBe("");
		expect(ctx.resolveXPathInstance?.("casedb")).toBeDefined();
	});

	it("evaluates functions over named session values after close", () => {
		const doc = buildDoc(spec());
		const input = inputFor(doc, {
			sessionDatums: new Map([
				["case_id_new_household_0", { value: "h1" }],
				["case_id_new_patient_1", { value: "p1" }],
			]),
		});
		const [link] = linksOf(doc, "frm-register");
		if (link === undefined) throw new Error("fixture has no link");
		const candidate = withFixtureLink(input, REGISTER, link);
		link.condition = parseFixtureExpression(
			candidate.doc,
			{
				entity: "form",
				uuid: REGISTER,
				slot: "form_link_condition",
				member: { linkUuid: link.uuid },
			},
			"count(instance('commcaresession')/session/data/case_id_new_patient_1) = 1 and starts-with(instance('commcaresession')/session/data/case_id_new_patient_1, 'p')",
		);
		expect(evaluateAfterSubmit({ input: candidate })).toMatchObject([
			{ kind: "destination", index: 0 },
		]);
	});

	it("refuses to read the closed form", () => {
		const doc = buildDoc(spec());
		const ctx = formLinkEvalContext(inputFor(doc));
		expect(() => ctx.getValue("/data/village")).toThrow(
			/cannot read "\/data\/village"/,
		);
	});
});

describe("carriedCaseFor", () => {
	it("carries the selected ancestor from a child source into an ancestor form", () => {
		const doc = nestedPatientDoc();
		const sessionDatums = submittedSession(doc, VISIT, {
			bound: { caseId: "p1", caseName: "Ada" },
			selections: {
				[HOUSEHOLDS]: {
					caseType: "household",
					cases: [{ caseId: "h1", caseName: "Smith household" }],
				},
			},
		});
		expect([...sessionDatums]).toEqual([
			["case_id", { value: "h1", caseName: "Smith household" }],
			["case_id_patient", { value: "p1", caseName: "Ada" }],
		]);
		const ancestorTarget: FormLink = {
			uuid: testUuid("nested-ancestor-link"),
			target: { type: "form", moduleUuid: HOUSEHOLDS, formUuid: UPDATE },
		};
		expect(
			carriedCaseFor(inputFor(doc, { sessionDatums }), VISIT, ancestorTarget),
		).toEqual({
			kind: "carried",
			caseId: "h1",
			caseName: "Smith household",
		});
	});

	it("carries a nested target through its renamed selected-case datum", () => {
		const doc = nestedPatientDoc();
		const sessionDatums = submittedSession(doc, VISIT, {
			bound: { caseId: "p1", caseName: "Ada" },
		});
		const automatic: FormLink = {
			uuid: testUuid("nested-auto-link"),
			target: { type: "form", moduleUuid: PATIENTS, formUuid: VISIT },
		};
		const input = inputFor(doc, { sessionDatums });
		expect(carriedCaseFor(input, VISIT, automatic)).toEqual({
			kind: "carried",
			caseId: "p1",
			caseName: "Ada",
		});

		const manual: FormLink = {
			...automatic,
			uuid: testUuid("nested-manual-link"),
			datums: [
				{
					name: { kind: "selected-case", module: PATIENTS },
					xpath: term(literal("p-manual")),
				},
			],
		};
		expect(carriedCaseFor(input, VISIT, manual)).toEqual({
			kind: "carried",
			caseId: "p-manual",
		});
	});

	it("carries nothing into a module target", () => {
		const doc = buildDoc(spec());
		expect(
			carriedCaseFor(
				inputFor(doc),
				REGISTER,
				linkNamed(doc, "frm-register", "lnk-patients"),
			),
		).toEqual({ kind: "none" });
	});

	it("carries the created child into a follow-up on the child's type", () => {
		const doc = buildDoc(spec());
		const child = minted(doc, "new-child-case:patient");
		const input = inputFor(doc, {
			sessionDatums: submittedSession(doc, REGISTER, {
				savedNames: { [child]: "Pat" },
			}),
		});
		expect(
			carriedCaseFor(
				input,
				REGISTER,
				linkNamed(doc, "frm-register", "lnk-visit"),
			),
		).toEqual({ kind: "carried", caseId: child, caseName: "Pat" });
	});

	it("carries the child's session id even when the form saved no such case", () => {
		// A `uuid()` datum is valued when the session reaches it, whatever the
		// form then creates, so the link carries the id the session holds.
		const doc = buildDoc(spec());
		const input = inputFor(doc, {
			sessionDatums: submittedSession(doc, REGISTER),
		});
		expect(
			carriedCaseFor(
				input,
				REGISTER,
				linkNamed(doc, "frm-register", "lnk-visit"),
			),
		).toEqual({
			kind: "carried",
			caseId: minted(doc, "new-child-case:patient"),
		});
	});

	it("carries the loaded case from a follow-up into another form of its module", () => {
		const doc = buildDoc(spec());
		const input = inputFor(doc, {
			sessionDatums: submittedSession(doc, UPDATE, {
				bound: { caseId: "h1", caseName: "Smith" },
			}),
		});
		expect(
			carriedCaseFor(input, UPDATE, linkNamed(doc, "frm-update", "lnk-close")),
		).toEqual({ kind: "carried", caseId: "h1", caseName: "Smith" });
	});

	it("starts this form again on the case it loaded", () => {
		const doc = buildDoc(spec());
		const input = inputFor(doc, {
			formUuid: UPDATE,
			sessionDatums: submittedSession(doc, UPDATE, {
				bound: { caseId: "h1", caseName: "Smith" },
			}),
		});
		expect(
			carriedCaseFor(input, UPDATE, {
				uuid: testUuid("lnk-again"),
				target: { type: "this-form" },
			}),
		).toEqual({ kind: "carried", caseId: "h1", caseName: "Smith" });
	});

	it("carries the case of an otherwise link as it carries a destination's", () => {
		const doc = buildDoc(spec());
		const input = inputFor(doc, {
			formUuid: UPDATE,
			sessionDatums: submittedSession(doc, UPDATE, {
				bound: { caseId: "h1", caseName: "Smith" },
			}),
		});
		expect(
			carriedCaseForProduction(input, UPDATE, {
				role: "otherwise",
				link: {
					uuid: testUuid("lnk-otherwise"),
					target: { type: "form", moduleUuid: HOUSEHOLDS, formUuid: CLOSE },
				},
			}),
		).toEqual({ kind: "carried", caseId: "h1", caseName: "Smith" });
	});

	it("carries the registered case into a follow-up of the same type", () => {
		const doc = buildDoc(spec());
		const link: FormLink = {
			uuid: testUuid("lnk-update"),
			target: { type: "form", moduleUuid: HOUSEHOLDS, formUuid: UPDATE },
		};
		const household = minted(doc, "new-case");
		const input = inputFor(doc, {
			sessionDatums: submittedSession(doc, REGISTER, {
				savedNames: { [household]: "Smiths" },
			}),
		});
		expect(carriedCaseFor(input, REGISTER, link)).toEqual({
			kind: "carried",
			caseId: household,
			caseName: "Smiths",
		});
	});

	it("evaluates a manual case_id datum, and reads a missing one as blank", () => {
		const doc = buildDoc(spec());
		const manual = linkNamed(doc, "frm-feedback", "lnk-survey");
		expect(carriedCaseFor(inputFor(doc), FEEDBACK, manual)).toEqual({
			kind: "carried",
			caseId: "p-manual",
		});
		const unnamed: FormLink = {
			...manual,
			datums: [
				{
					name: {
						kind: "selected-case",
						module: testUuid("unmatched-selection"),
					},
					xpath: term(literal("x")),
				},
			],
		};
		expect(carriedCaseFor(inputFor(doc), FEEDBACK, unnamed)).toEqual({
			kind: "carried",
			caseId: "",
		});
	});

	it("lets a manual datum read the source entry's own session datums", () => {
		const doc = buildDoc(spec());
		const input = inputFor(doc, {
			sessionDatums: submittedSession(doc, REGISTER),
		});
		const link = linkNamed(doc, "frm-register", "lnk-visit");
		const datum: FormLinkDatum = {
			name: { kind: "selected-case", module: PATIENTS },
			xpath: term(literal("")),
		};
		const candidate = withFixtureLink(input, REGISTER, {
			...link,
			datums: [datum],
		});
		datum.xpath = parseFixtureExpression(
			candidate.doc,
			{
				entity: "form",
				uuid: REGISTER,
				slot: "form_link_datum_xpath",
				member: { linkUuid: link.uuid, datum: datum.name },
			},
			"instance('commcaresession')/session/data/case_id_new_patient_1",
		);
		expect(evaluateLinkDatum(datum, candidate, link.uuid)).toBe(
			minted(doc, "new-child-case:patient"),
		);
	});

	it("lets a manual datum aggregate named session values", () => {
		const doc = buildDoc(spec());
		const input = inputFor(doc, {
			sessionDatums: new Map([
				["case_id_new_household_0", { value: "h9" }],
				["case_id_new_patient_1", { value: "p1" }],
			]),
		});
		const link = linkNamed(doc, "frm-register", "lnk-visit");
		const datum: FormLinkDatum = {
			name: { kind: "selected-case", module: PATIENTS },
			xpath: term(literal("")),
		};
		const candidate = withFixtureLink(input, REGISTER, {
			...link,
			datums: [datum],
		});
		datum.xpath = parseFixtureExpression(
			candidate.doc,
			{
				entity: "form",
				uuid: REGISTER,
				slot: "form_link_datum_xpath",
				member: { linkUuid: link.uuid, datum: datum.name },
			},
			"concat(instance('commcaresession')/session/data/case_id_new_household_0, '-', count(instance('commcaresession')/session/data/case_id_new_household_0) + count(instance('commcaresession')/session/data/case_id_new_patient_1))",
		);
		expect(evaluateLinkDatum(datum, candidate, link.uuid)).toBe("h9-2");
	});
});

describe("projectTargetCaseSelections", () => {
	it("projects the ancestor selection carried by a nested module target", () => {
		let doc = nestedPatientDoc();
		/* A module target carries the structural parent's common selection
		 * prefix. Keep only the two household case-loading entries so that
		 * `case_id` is common, while the survey remains the link source. */
		const removed = mutationCommitVerdict(
			doc,
			[{ kind: "removeForm", uuid: REGISTER }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!removed.ok) throw new Error(JSON.stringify(removed.findings));
		doc = removed.nextDoc;
		const link: FormLink = {
			uuid: testUuid("nested-module-manual-link"),
			target: { type: "module", moduleUuid: PATIENTS },
			datums: [
				{
					name: { kind: "selected-case", module: HOUSEHOLDS },
					xpath: term(literal("h-manual")),
				},
			],
		};

		expect(projectTargetCaseSelections(inputFor(doc), FEEDBACK, link)).toEqual([
			{
				datumId: "case_id",
				moduleUuid: HOUSEHOLDS,
				caseType: "household",
				caseId: "h-manual",
			},
		]);
	});

	it("maps every automatic nested target selection to its owning module", () => {
		const doc = nestedPatientDoc();
		const household = minted(doc, "new-case");
		const patient = minted(doc, "new-child-case:patient");
		const input = inputFor(doc, {
			sessionDatums: submittedSession(doc, REGISTER, {
				savedNames: { [household]: "Smiths", [patient]: "Pat" },
			}),
		});
		const link: FormLink = {
			uuid: testUuid("nested-created-cases-link"),
			target: { type: "form", moduleUuid: PATIENTS, formUuid: VISIT },
		};

		expect(projectTargetCaseSelections(input, REGISTER, link)).toEqual([
			{
				datumId: "case_id",
				moduleUuid: HOUSEHOLDS,
				caseType: "household",
				caseId: household,
				caseName: "Smiths",
			},
			{
				datumId: "case_id_patient",
				moduleUuid: PATIENTS,
				caseType: "patient",
				caseId: patient,
				caseName: "Pat",
			},
		]);
	});

	it("maps every manual nested target datum, including its parent", () => {
		const doc = nestedPatientDoc();
		const input = inputFor(doc);
		const link: FormLink = {
			uuid: testUuid("nested-manual-cases-link"),
			target: { type: "form", moduleUuid: PATIENTS, formUuid: VISIT },
			datums: [
				{
					name: { kind: "selected-case", module: HOUSEHOLDS },
					xpath: term(literal("h-manual")),
				},
				{
					name: { kind: "selected-case", module: PATIENTS },
					xpath: term(literal("p-manual")),
				},
			],
		};

		expect(projectTargetCaseSelections(input, FEEDBACK, link)).toEqual([
			{
				datumId: "case_id",
				moduleUuid: HOUSEHOLDS,
				caseType: "household",
				caseId: "h-manual",
			},
			{
				datumId: "case_id_patient",
				moduleUuid: PATIENTS,
				caseType: "patient",
				caseId: "p-manual",
			},
		]);
	});
});

/** Hand-authored projection scenarios include deliberately missing selections.
 * Install the candidate link in the actual form without claiming whole-app admission. */
function withFixtureLink(
	input: FormLinkEvaluationInput,
	formUuid: Uuid,
	link: FormLink,
): FormLinkEvaluationInput {
	const doc = {
		...input.doc,
		forms: {
			...input.doc.forms,
			[formUuid]: { ...input.doc.forms[formUuid], formLinks: [link] },
		},
	};
	return { ...input, doc, formUuid };
}
function destination(link: FormLink): FormLinkEntry {
	return { role: "destination", link, index: 0 };
}
function carriedCaseFor(
	input: FormLinkEvaluationInput,
	formUuid: Uuid,
	link: FormLink,
) {
	return carriedCaseForProduction(
		withFixtureLink(input, formUuid, link),
		formUuid,
		destination(link),
	);
}
function projectTargetCaseSelections(
	input: FormLinkEvaluationInput,
	formUuid: Uuid,
	link: FormLink,
) {
	return projectTargetCaseSelectionsProduction(
		withFixtureLink(input, formUuid, link),
		formUuid,
		destination(link),
	);
}
