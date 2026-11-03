/**
 * The case list registration form's doc-layer planners: the refusals that
 * name what depends on a module's Search (`searchReadDependents.ts`) and the
 * born-valid batches that name the form and carry the answers
 * (`caseListRegistrationForm.ts`).
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	carrySearchAnswersMutations,
	caseListRegistrationFormMutations,
	caseListRegistrationMutations,
	formsReadSearchOnMutations,
	searchAnswerDefaultsOf,
	searchAnswerFields,
} from "@/lib/doc/caseListRegistrationForm";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { searchInputFormFieldDependencies } from "@/lib/doc/searchInputMutations";
import {
	planSearchInputRemovalFieldDependents,
	planSearchTakeawayDependents,
	searchAnswerFieldDependents,
} from "@/lib/doc/searchReadDependents";
import {
	fieldCaseWriteViews,
	NEW_APP_SETTINGS,
	simpleSearchInputDef,
} from "@/lib/domain";
import { input, now, term } from "@/lib/domain/expression/builders";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { assertAdmittedDoc } from "./admittedDoc";

const MODULE = testUuid("00000000-0000-4000-8000-0000000c0010");
const VISIT = testUuid("00000000-0000-4000-8000-0000000c0011");
const REGISTER = testUuid("00000000-0000-4000-8000-0000000c0012");
const NAME_INPUT = testUuid("00000000-0000-4000-8000-0000000c0001");
const TIME_INPUT = testUuid("00000000-0000-4000-8000-0000000c0002");
const NAME_FIELD = testUuid("00000000-0000-4000-8000-0000000c0020");

function fixture(
	options: {
		formsReadSearch?: boolean;
		entry?: boolean;
		register?: boolean;
		/** Drop the Visit form so the registration form is the only form. */
		visit?: boolean;
		caseListMenuItem?: boolean;
	} = {},
) {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [
		simpleSearchInputDef(
			NAME_INPUT,
			"patient_name",
			"Patient name",
			"text",
			"case_name",
		),
		{
			kind: "hidden",
			uuid: TIME_INPUT,
			name: "search_time",
			label: "Search time",
			value: now(),
		},
	];
	const hasEntry =
		options.entry !== false &&
		options.formsReadSearch !== false &&
		options.register !== false;
	const doc = buildDoc({
		appName: "Registry",
		// A case list registration form and forms that read the search run in
		// Web Apps alone, and these tests turn Forms read the search on.
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				...(options.caseListMenuItem === true && { caseListMenuItem: {} }),
				...(hasEntry && { caseListRegistrationForm: { formUuid: REGISTER } }),
				...(options.formsReadSearch === false ||
				(options.entry === false && options.register !== false)
					? {}
					: { caseSearchConfig: { formsReadSearch: true } }),
				forms: [
					...(options.visit === false
						? []
						: [
								{
									uuid: VISIT,
									name: "Visit",
									type: "followup" as const,
									fields: [
										f({ kind: "text", id: "note", label: proseText("Note") }),
									],
								},
							]),
					...(options.register === false
						? []
						: [
								{
									uuid: REGISTER,
									name: "Register patient",
									type: "registration" as const,
									fields: [
										f({
											uuid: NAME_FIELD,
											kind: "text",
											id: "case_name",
											label: proseText("Name"),
											caseWrite: { caseType: "patient", property: "case_name" },
											...(hasEntry
												? {
														default_value: term(input(NAME_INPUT)),
													}
												: {}),
										}),
									],
								},
							]),
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

describe("searchAnswerFieldDependents", () => {
	it("names every field reading a prompt's answer, with its slot", () => {
		expect(searchAnswerFieldDependents(fixture(), NAME_INPUT)).toEqual([
			{
				formUuid: REGISTER,
				formName: "Register patient",
				fieldUuid: NAME_FIELD,
				fieldId: "case_name",
				slots: ["default_value"],
			},
		]);
		expect(searchAnswerFieldDependents(fixture(), TIME_INPUT)).toEqual([]);
	});
});

describe("planSearchTakeawayDependents", () => {
	it("refuses turning Forms read the search off or removing Search while the form depends on it", () => {
		const doc = fixture();
		const off = planSearchTakeawayDependents(doc, MODULE, "forms-read-search");
		expect(off.kind).toBe("blocked");
		if (off.kind !== "blocked") throw new Error("expected a refusal");
		expect(off.message).toContain(`"Register patient" (${REGISTER})`);
		expect(off.message).toContain("update_form (case_list_registration: null)");
		expect(off.userMessage).toContain(
			'"Patients" keeps its forms reading the search',
		);

		const removal = planSearchTakeawayDependents(doc, MODULE, "search");
		expect(removal.kind).toBe("blocked");
		if (removal.kind !== "blocked") throw new Error("expected a refusal");
		expect(removal.message).toContain("remove Search from module");
	});

	it("has nothing to say when the module has no case list registration form", () => {
		expect(
			planSearchTakeawayDependents(fixture({ entry: false }), MODULE, "search"),
		).toEqual({ kind: "none" });
	});
});

describe("planSearchInputRemovalFieldDependents", () => {
	it("refuses removing a prompt a field still reads, naming the field", () => {
		const plan = planSearchInputRemovalFieldDependents(
			fixture(),
			MODULE,
			NAME_INPUT,
		);
		expect(plan.kind).toBe("blocked");
		if (plan.kind !== "blocked") throw new Error("expected a refusal");
		expect(plan.message).toContain("#search/patient_name");
		expect(plan.message).toContain(`field ${NAME_FIELD}`);
		expect(plan.message).toContain("edit_field");
		expect(plan.userMessage).toContain(
			'"case_name" in "Register patient" uses',
		);
	});

	it("lets an unread prompt go", () => {
		expect(
			planSearchInputRemovalFieldDependents(fixture(), MODULE, TIME_INPUT),
		).toEqual({ kind: "none" });
	});
});

describe("formsReadSearchOnMutations", () => {
	it("turns Forms read the search on only when it is off", () => {
		const before = fixture({ formsReadSearch: false, register: false });
		const verdict = mutationCommitVerdict(
			before,
			formsReadSearchOnMutations(before, MODULE),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		expect(verdict.nextDoc.modules[MODULE].caseSearchConfig).toEqual({
			formsReadSearch: true,
		});
		expect(formsReadSearchOnMutations(verdict.nextDoc, MODULE)).toEqual([]);
	});
});

describe("caseListRegistrationMutations", () => {
	it("names the form and turns Forms read the search on in one batch that passes the gate", () => {
		const doc = fixture({ formsReadSearch: false, entry: false });
		const mutations = caseListRegistrationMutations(doc, MODULE, REGISTER, {
			label: "Register a new patient",
		});
		expect(mutations).toEqual([
			{
				kind: "updateModule",
				uuid: MODULE,
				patch: {},
				caseSearchConfigPatch: { formsReadSearch: true },
			},
			{
				kind: "updateModule",
				uuid: MODULE,
				patch: {
					caseListRegistrationForm: {
						kind: "after-empty-search",
						formUuid: REGISTER,
						label: "Register a new patient",
					},
				},
			},
		]);
		const verdict = mutationCommitVerdict(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!verdict.ok) throw new Error(JSON.stringify(verdict, null, 1));
		expect(verdict.nextDoc.modules[MODULE]?.caseListRegistrationForm).toEqual({
			kind: "after-empty-search",
			formUuid: REGISTER,
			label: "Register a new patient",
		});
		expect(verdict.nextDoc.modules[MODULE]?.caseSearchConfig).toMatchObject({
			formsReadSearch: true,
		});
	});

	it("returns the form to the menu with Forms read the search off and the search-answer starting values removed", () => {
		const doc = fixture();
		const mutations = caseListRegistrationMutations(
			doc,
			MODULE,
			REGISTER,
			null,
		);
		expect(mutations).toEqual([
			{
				kind: "updateModule",
				uuid: MODULE,
				patch: {},
				caseSearchConfigPatch: { formsReadSearch: null },
			},
			{
				kind: "updateField",
				uuid: NAME_FIELD,
				targetKind: "text",
				patch: { default_value: null },
			},
			{
				kind: "updateModule",
				uuid: MODULE,
				patch: { caseListRegistrationForm: null },
			},
		]);
		const verdict = mutationCommitVerdict(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!verdict.ok) throw new Error(JSON.stringify(verdict, null, 1));
		expect(
			verdict.nextDoc.modules[MODULE]?.caseListRegistrationForm,
		).toBeUndefined();
		expect(verdict.nextDoc.modules[MODULE]?.caseSearchConfig).not.toMatchObject(
			{ formsReadSearch: true },
		);
		expect(verdict.nextDoc.fields[NAME_FIELD]).not.toHaveProperty(
			"default_value",
		);
	});

	it("plans nothing to clear a form the slot does not name", () => {
		expect(
			caseListRegistrationMutations(fixture(), MODULE, VISIT, null),
		).toEqual([]);
	});

	it("names the fields whose only search read is their starting value", () => {
		const doc = fixture();
		expect(
			searchAnswerDefaultsOf(doc, MODULE, REGISTER).map((reader) => [
				reader.fieldUuid,
				reader.slots,
			]),
		).toEqual([[NAME_FIELD, ["default_value"]]]);
		expect(searchAnswerDefaultsOf(doc, MODULE, VISIT)).toEqual([]);
	});

	it("gives the module its case list menu entry when its only menu form leaves the menu", () => {
		const doc = fixture({ formsReadSearch: false, entry: false, visit: false });
		const mutations = caseListRegistrationMutations(doc, MODULE, REGISTER, {});
		expect(mutations).toContainEqual({
			kind: "setCaseListMenuItem",
			uuid: MODULE,
			item: {},
		});
		const verdict = mutationCommitVerdict(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!verdict.ok) throw new Error(JSON.stringify(verdict, null, 1));
		expect(verdict.nextDoc.modules[MODULE]?.caseListMenuItem).toEqual({});
		expect(
			verdict.nextDoc.modules[MODULE]?.caseListRegistrationForm?.formUuid,
		).toBe(REGISTER);
	});

	it("keeps the case list menu entry beside the form it puts back on the menu", () => {
		const doc = fixture({ visit: false, caseListMenuItem: true });
		const mutations = caseListRegistrationMutations(
			doc,
			MODULE,
			REGISTER,
			null,
		);
		expect(
			mutations.some((mutation) => mutation.kind === "setCaseListMenuItem"),
		).toBe(false);
		const verdict = mutationCommitVerdict(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!verdict.ok) throw new Error(JSON.stringify(verdict, null, 1));
		expect(verdict.nextDoc.modules[MODULE]?.caseListMenuItem).toEqual({});
		expect(
			verdict.nextDoc.modules[MODULE]?.caseListRegistrationForm,
		).toBeUndefined();
	});
});

describe("caseListRegistrationFormMutations", () => {
	it("births a case list registration form carrying every Search field, with Forms read the search on", () => {
		const doc = fixture({ formsReadSearch: false, register: false });
		const planned = caseListRegistrationFormMutations(doc, MODULE);
		if (planned === null) throw new Error("no plan");
		expect(planned.formName).toBe("Register patient");
		const addForm = planned.mutations.find(
			(mutation) => mutation.kind === "addForm",
		);
		expect(addForm).toMatchObject({
			moduleUuid: MODULE,
			form: {
				uuid: planned.formUuid,
				name: "Register patient",
				type: "registration",
			},
		});
		expect(addForm).not.toHaveProperty("form.entry");
		const fields = planned.mutations.flatMap((mutation) =>
			mutation.kind === "addField" ? [mutation.field] : [],
		);
		// The name writer is seeded from the prompt on `case_name`; the
		// hidden search time rides beside it.
		expect(fields.map((field) => [field.kind, field.id])).toEqual([
			["text", "case_name"],
			["hidden", "search_time"],
		]);
		expect(fields[0]).toMatchObject({
			default_value: term(input(NAME_INPUT)),
		});
		expect(planned.mutations).toContainEqual({
			kind: "updateModule",
			uuid: MODULE,
			patch: {},
			caseSearchConfigPatch: { formsReadSearch: true },
		});
		expect(planned.mutations).toContainEqual({
			kind: "updateModule",
			uuid: MODULE,
			patch: {
				caseListRegistrationForm: {
					kind: "after-empty-search",
					formUuid: planned.formUuid,
				},
			},
		});
		// The whole batch passes the gate as one commit, and the new form's
		// own case is named by the name question and saves the search time.
		const verdict = mutationCommitVerdict(
			doc,
			planned.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!verdict.ok) throw new Error(JSON.stringify(verdict, null, 1));
		expect(
			fields.map((field) =>
				fieldCaseWriteViews(verdict.nextDoc, field.uuid).map((view) => [
					view.slot,
					view.property,
				]),
			),
		).toEqual([[["name", "case_name"]], [["write", "search_time"]]]);
	});

	it("declines a module without a case type", () => {
		const doc = buildDoc({
			modules: [
				{
					uuid: MODULE,
					name: "Survey",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								{ kind: "text", id: "notes", label: proseText("Notes") },
							],
						},
					],
				},
			],
		});
		assertAdmittedDoc(doc);
		expect(caseListRegistrationFormMutations(doc, MODULE)).toBeNull();
	});

	it("keeps a bare case list a bare case list, since the new form is not a menu form", () => {
		const doc = fixture({
			formsReadSearch: false,
			register: false,
			visit: false,
			caseListMenuItem: true,
		});
		const planned = caseListRegistrationFormMutations(doc, MODULE);
		if (planned === null) throw new Error("no plan");
		expect(
			planned.mutations.some(
				(mutation) => mutation.kind === "setCaseListMenuItem",
			),
		).toBe(false);
		const verdict = mutationCommitVerdict(
			doc,
			planned.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!verdict.ok) throw new Error(JSON.stringify(verdict, null, 1));
		expect(verdict.nextDoc.modules[MODULE]?.caseListMenuItem).toEqual({});
		expect(verdict.nextDoc.formOrder[MODULE]).toEqual([planned.formUuid]);
	});

	it("keeps an option token out of the name writer and skips a duplicate property writer", () => {
		const doc = fixture({ formsReadSearch: false, register: false });
		const config = doc.modules[MODULE].caseListConfig;
		if (config === undefined) throw new Error("no case list");
		config.searchInputs = [
			{
				kind: "simple",
				uuid: NAME_INPUT,
				name: "patient_name",
				label: "Patient name",
				type: "select",
				property: "case_name",
				mode: { kind: "exact" },
				options: {
					kind: "lookup",
					tableId: lookupTableIdSchema.parse(
						"01912d68-783e-7000-8000-00000000a001",
					),
					valueColumnId: lookupColumnIdSchema.parse(
						"01912d68-783e-7000-8000-00000000c001",
					),
					labelColumnId: lookupColumnIdSchema.parse(
						"01912d68-783e-7000-8000-00000000c002",
					),
				},
			},
		];
		const lookupContext: LookupValidationContext = {
			kind: "available",
			projectId: "project",
			projectRevision: parseLookupRevision("1"),
			definitions: [
				{
					id: lookupTableIdSchema.parse("01912d68-783e-7000-8000-00000000a001"),
					name: "Names",
					tag: "names",
					definitionRevision: parseLookupRevision("1"),
					columns: [
						{
							id: lookupColumnIdSchema.parse(
								"01912d68-783e-7000-8000-00000000c001",
							),
							wireName: "code",
							label: "Code",
							dataType: "text",
						},
						{
							id: lookupColumnIdSchema.parse(
								"01912d68-783e-7000-8000-00000000c002",
							),
							wireName: "name",
							label: "Name",
							dataType: "text",
						},
					],
				},
			],
		};
		assertAdmittedDoc(doc, lookupContext);
		const planned = caseListRegistrationFormMutations(doc, MODULE);
		if (planned === null) throw new Error("no plan");
		const fields = planned.mutations.flatMap((mutation) =>
			mutation.kind === "addField" ? [mutation.field] : [],
		);
		const nameWriter = fields.find((field) => field.id === "case_name");
		expect(nameWriter).not.toHaveProperty("default_value");
		// The prompt's own field is skipped too: the name writer already
		// carries `case_name`, and a choice token is not a name.
		expect(fields.map((field) => field.id)).toEqual(["case_name"]);
		const verdict = mutationCommitVerdict(
			doc,
			planned.mutations,
			lookupContext,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	});
});

describe("carrySearchAnswersMutations", () => {
	it("appends only the prompts the form does not carry yet", () => {
		const doc = fixture();
		// The fixture's form already writes `case_name` from the name prompt.
		const mutations = carrySearchAnswersMutations(doc, MODULE, REGISTER);
		expect(
			mutations.flatMap((mutation) =>
				mutation.kind === "addField"
					? [[mutation.parentUuid, mutation.field.id]]
					: [],
			),
		).toEqual([[REGISTER, "search_time"]]);
		const verdict = mutationCommitVerdict(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(true);
		if (!verdict.ok) return;
		expect(
			carrySearchAnswersMutations(verdict.nextDoc, MODULE, REGISTER),
		).toEqual([]);
	});
});

describe("searchInputFormFieldDependencies", () => {
	it("lists the form fields reading the prompt as removal dependencies", () => {
		const doc = fixture();
		expect(searchInputFormFieldDependencies(doc, MODULE, NAME_INPUT)).toEqual([
			{
				kind: "form-field",
				label: "“case_name” in “Register patient”",
				moduleUuid: MODULE,
				formUuid: REGISTER,
				fieldUuid: NAME_FIELD,
				uses: 1,
			},
		]);
		expect(searchInputFormFieldDependencies(doc, MODULE, TIME_INPUT)).toEqual(
			[],
		);
	});
});

describe("searchAnswerFields", () => {
	it("seeds one field per prompt from #search/<name>, saving to the prompt's property", () => {
		const occupied = new Set<string>(["case_name"]);
		const answers = searchAnswerFields(fixture(), MODULE, occupied);
		expect(answers.map(({ field }) => [field.kind, field.id])).toEqual([
			["text", "patient_name"],
			["hidden", "search_time"],
		]);
		expect(answers[0]).toMatchObject({
			field: {
				label: proseText("Patient name"),
				default_value: term(input(NAME_INPUT)),
			},
			savesTo: { caseType: "patient", property: "case_name" },
		});
		// A hidden value is provenance of the search, saved under its own name.
		expect(answers[1]).toMatchObject({
			field: { default_value: term(input(TIME_INPUT)) },
			savesTo: { caseType: "patient", property: "search_time" },
		});
		expect([...occupied]).toEqual(["case_name", "patient_name", "search_time"]);
	});

	it("skips a prompt whose property the form already writes", () => {
		const fields = searchAnswerFields(
			fixture(),
			MODULE,
			new Set(),
			new Set(["case_name"]),
		);
		expect(fields.map(({ field }) => field.id)).toEqual(["search_time"]);
	});

	it("keeps a hidden value off the case when its name cannot be a property", () => {
		const doc = fixture({ register: false });
		const mod = doc.modules[MODULE];
		const config = mod.caseListConfig;
		if (config === undefined) throw new Error("no case list");
		config.searchInputs = [
			{
				kind: "hidden",
				uuid: TIME_INPUT,
				name: "case_id",
				label: "Case id",
				value: now(),
			},
		];
		assertAdmittedDoc(doc);
		const [answer] = searchAnswerFields(doc, MODULE, new Set());
		expect(answer?.field).toMatchObject({ kind: "hidden", id: "case_id" });
		expect(answer).not.toHaveProperty("savesTo");
	});

	it("gives two prompts on one property a single writer", () => {
		const doc = fixture();
		const config = doc.modules[MODULE].caseListConfig;
		if (config === undefined) throw new Error("no case list");
		config.searchInputs = [
			simpleSearchInputDef(
				NAME_INPUT,
				"patient_name",
				"Patient name",
				"text",
				"case_name",
			),
			simpleSearchInputDef(
				TIME_INPUT,
				"scanned_name",
				"Scanned name",
				"barcode",
				"case_name",
			),
		];
		assertAdmittedDoc(doc);
		const occupiedProperties = new Set<string>();
		const fields = searchAnswerFields(
			doc,
			MODULE,
			new Set(),
			occupiedProperties,
		);
		expect(fields.map(({ field }) => field.id)).toEqual(["patient_name"]);
		expect([...occupiedProperties]).toEqual(["case_name"]);
	});

	it("dedupes an id the form already uses", () => {
		const fields = searchAnswerFields(
			fixture(),
			MODULE,
			new Set(["patient_name", "patient_name_2"]),
		);
		expect(fields[0]?.field.id).toBe("patient_name_3");
	});
});

it("creates a multiple-selection case list registration form only with explicit First menu", () => {
	const doc = fixture({ register: false, formsReadSearch: true });
	const config = doc.modules[MODULE].caseListConfig;
	if (!config) throw new Error("Missing case list");
	doc.modules[MODULE].caseListConfig = {
		...config,
		selection: { kind: "multiple", maximum: 5 },
	};
	assertAdmittedDoc(doc);
	const implicit = caseListRegistrationFormMutations(doc, MODULE);
	const explicit = caseListRegistrationFormMutations(doc, MODULE, {
		postSubmit: "firstMenu",
	});
	if (!implicit || !explicit) throw new Error("Missing registration plan");
	expect(
		mutationCommitVerdict(doc, implicit.mutations, LOOKUP_CONTEXT_UNAVAILABLE)
			.ok,
	).toBe(false);
	const verdict = mutationCommitVerdict(
		doc,
		explicit.mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok) throw new Error(JSON.stringify(verdict));
});
