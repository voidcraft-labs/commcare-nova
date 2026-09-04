/**
 * The no-matches registration form's doc-layer planners: the refusals that
 * name what depends on a module's Search (`searchNoMatchesDependents.ts`)
 * and the born-valid batches that set the entry and carry the answers
 * (`searchNoMatchesForm.ts`).
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { searchInputRemovalDependenciesInDoc } from "@/lib/doc/searchInputMutations";
import {
	planSearchInputRemovalFieldDependents,
	planSearchTakeawayDependents,
	searchAnswerFieldDependents,
} from "@/lib/doc/searchNoMatchesDependents";
import {
	carrySearchAnswersMutations,
	noMatchesFormEntryMutations,
	noMatchesRegistrationFormMutations,
	searchAnswerFields,
	searchFirstOnMutations,
} from "@/lib/doc/searchNoMatchesForm";
import { simpleSearchInputDef } from "@/lib/domain";
import { now } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

const MODULE = testUuid("00000000-0000-4000-8000-0000000c0010");
const VISIT = testUuid("00000000-0000-4000-8000-0000000c0011");
const REGISTER = testUuid("00000000-0000-4000-8000-0000000c0012");
const NAME_INPUT = testUuid("00000000-0000-4000-8000-0000000c0001");
const TIME_INPUT = testUuid("00000000-0000-4000-8000-0000000c0002");
const NAME_FIELD = testUuid("00000000-0000-4000-8000-0000000c0020");

function fixture(
	options: { searchFirst?: boolean; entry?: boolean; register?: boolean } = {},
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
	return buildDoc({
		appName: "Registry",
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				...(options.searchFirst === false
					? {}
					: { caseSearchConfig: { searchFirst: true } }),
				forms: [
					{
						uuid: VISIT,
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
					...(options.register === false
						? []
						: [
								{
									uuid: REGISTER,
									name: "Register patient",
									type: "registration" as const,
									...(options.entry === false
										? {}
										: { entry: { kind: "search-no-matches" as const } }),
									fields: [
										f({
											uuid: NAME_FIELD,
											kind: "text",
											id: "case_name",
											label: proseText("Name"),
											caseWrite: { caseType: "patient", property: "case_name" },
											default_value: {
												parts: [
													{
														kind: "search-answer-ref",
														searchInputUuid: NAME_INPUT,
													},
												],
											},
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
	it("refuses turning Search first off or removing Search while the form depends on it", () => {
		const doc = fixture();
		const off = planSearchTakeawayDependents(doc, MODULE, "search-first");
		expect(off.kind).toBe("blocked");
		if (off.kind !== "blocked") throw new Error("expected a refusal");
		expect(off.message).toContain(`"Register patient" (${REGISTER})`);
		expect(off.message).toContain("update_form (entry: null)");
		expect(off.userMessage).toContain('"Patients" keeps opening on Search');

		const removal = planSearchTakeawayDependents(doc, MODULE, "search");
		expect(removal.kind).toBe("blocked");
		if (removal.kind !== "blocked") throw new Error("expected a refusal");
		expect(removal.message).toContain("remove Search from module");
	});

	it("has nothing to say when the module has no no-matches form", () => {
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

describe("searchFirstOnMutations", () => {
	it("turns Search first on only when it is off", () => {
		expect(searchFirstOnMutations(fixture(), MODULE)).toEqual([]);
		expect(
			searchFirstOnMutations(fixture({ searchFirst: false }), MODULE),
		).toEqual([
			{
				kind: "updateModule",
				uuid: MODULE,
				patch: {},
				caseSearchConfigPatch: { searchFirst: true },
			},
		]);
	});
});

describe("noMatchesFormEntryMutations", () => {
	it("sets the entry and opens the module on Search in one batch that passes the gate", () => {
		const doc = fixture({ searchFirst: false, entry: false });
		const mutations = noMatchesFormEntryMutations(doc, MODULE, REGISTER, {
			kind: "search-no-matches",
		});
		expect(mutations.map((mutation) => mutation.kind)).toEqual([
			"updateModule",
			"updateForm",
		]);
		const verdict = mutationCommitVerdict(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(true);
		if (!verdict.ok) return;
		expect(verdict.nextDoc.forms[REGISTER]?.entry).toEqual({
			kind: "search-no-matches",
		});
		expect(verdict.nextDoc.modules[MODULE]?.caseSearchConfig).toMatchObject({
			searchFirst: true,
		});
	});

	it("clears the entry without touching the module's Search", () => {
		expect(
			noMatchesFormEntryMutations(fixture(), MODULE, REGISTER, null),
		).toEqual([{ kind: "updateForm", uuid: REGISTER, patch: { entry: null } }]);
	});
});

describe("noMatchesRegistrationFormMutations", () => {
	it("births a no-matches registration form carrying every prompt, with Search first on", () => {
		const doc = fixture({ searchFirst: false, register: false });
		const planned = noMatchesRegistrationFormMutations(doc, MODULE);
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
				entry: { kind: "search-no-matches" },
			},
		});
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
			caseWrite: { caseType: "patient", property: "case_name" },
			default_value: {
				parts: [{ kind: "search-answer-ref", searchInputUuid: NAME_INPUT }],
			},
		});
		expect(planned.mutations).toContainEqual({
			kind: "updateModule",
			uuid: MODULE,
			patch: {},
			caseSearchConfigPatch: { searchFirst: true },
		});
		// The whole batch passes the gate as one commit.
		const verdict = mutationCommitVerdict(
			doc,
			planned.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!verdict.ok) throw new Error(JSON.stringify(verdict, null, 1));
	});

	it("declines a module without a case type", () => {
		const doc = fixture();
		const mod = doc.modules[MODULE];
		expect(
			noMatchesRegistrationFormMutations(
				{ ...doc, modules: { [MODULE]: { ...mod, caseType: undefined } } },
				MODULE,
			),
		).toBeNull();
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

describe("searchInputRemovalDependenciesInDoc", () => {
	it("lists the form fields reading the prompt beside the config's own dependencies", () => {
		const doc = fixture();
		expect(
			searchInputRemovalDependenciesInDoc(doc, MODULE, NAME_INPUT),
		).toEqual([
			{
				kind: "form-field",
				label: "“case_name” in “Register patient”",
				moduleUuid: MODULE,
				formUuid: REGISTER,
				fieldUuid: NAME_FIELD,
				uses: 1,
			},
		]);
		expect(
			searchInputRemovalDependenciesInDoc(doc, MODULE, TIME_INPUT),
		).toEqual([]);
	});
});

describe("searchAnswerFields", () => {
	it("seeds one field per prompt from #search/<name>, saving to the prompt's property", () => {
		const occupied = new Set<string>(["case_name"]);
		const fields = searchAnswerFields(fixture(), MODULE, occupied);
		expect(fields.map((field) => [field.kind, field.id])).toEqual([
			["text", "patient_name"],
			["hidden", "search_time"],
		]);
		expect(fields[0]).toMatchObject({
			label: proseText("Patient name"),
			caseWrite: { caseType: "patient", property: "case_name" },
			default_value: {
				parts: [{ kind: "search-answer-ref", searchInputUuid: NAME_INPUT }],
			},
		});
		// A hidden value is provenance of the search, saved under its own name.
		expect(fields[1]).toMatchObject({
			caseWrite: { caseType: "patient", property: "search_time" },
			default_value: {
				parts: [{ kind: "search-answer-ref", searchInputUuid: TIME_INPUT }],
			},
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
		expect(fields.map((field) => field.id)).toEqual(["search_time"]);
	});

	it("keeps a hidden value off the case when its name cannot be a property", () => {
		const doc = fixture();
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
		const [field] = searchAnswerFields(doc, MODULE, new Set());
		expect(field).toMatchObject({ kind: "hidden", id: "case_id" });
		expect(field).not.toHaveProperty("caseWrite");
	});

	it("dedupes an id the form already uses", () => {
		const fields = searchAnswerFields(
			fixture(),
			MODULE,
			new Set(["patient_name", "patient_name_2"]),
		);
		expect(fields[0]?.id).toBe("patient_name_3");
	});
});
