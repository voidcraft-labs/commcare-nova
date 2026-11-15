/**
 * The case catalog a reading writes, and the canonical catalog of a document.
 *
 * Contract: `readCaseCatalog` (run by the case management stage) declares the
 * case types of the app's menus, child cases and Save to Case blocks in menu
 * order, a child type's parent where every `parent` link out of it agrees,
 * one property per name the app writes, labelled by its name, and a
 * property's choices from the select questions that write it, first label
 * kept; a property written through the date-and-time join is declared with
 * no type and reads `datetime` through `effectiveCaseTypes`, as the join's
 * Hidden Value types it. Writers of one property whose types agree on one
 * stored type (`int` with `decimal`, `text` with a single choice) read with
 * no finding, and a pair no type joins raises its manifest row.
 * `catalogAsRead(D)` states the same catalog of a
 * Nova-born document, whatever labels, unneeded types and unread properties D's own catalog
 * holds. The plausible failures: a declared type that a writer contradicts
 * (the gate would refuse the document), a parent named where two links
 * disagree, and a canonical choice that states another catalog than the
 * reader derives, so a document and its reading would never compare equal.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { datetimeSplitOriginal } from "@/lib/doc/__tests__/datetimeSplitFixture";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { planDatetimeSplits } from "@/lib/doc/datetimeSplit";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type CaseOperation,
	type Column,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import {
	ancestorPath,
	eq,
	formField,
	literal,
	or,
	prop,
	relationStep,
	term,
} from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import { expandDoc } from "../../../expander";
import { runValidation } from "../../../validator/runner";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { readMenusOf } from "../../menus/__tests__/menuReading";
import { catalogAsRead, noteProperty } from "../catalog";
import { knownCaseTypesOf } from "../knownCaseTypes";
import { findingCodes, readCases } from "./caseReading";
import { readHqApp } from "./heldReading";

const STATUS = testUuid("catalog-status");

function caseListConfigOf(columns: Column[]) {
	const order = columns.map((column) => column.uuid);
	return {
		columns,
		listColumnOrder: order,
		detailColumnOrder: [...order],
		searchInputs: [],
	};
}
const AGAIN = testUuid("catalog-status-again");

/**
 * Two follow-ups whose choice questions save one property under choices that
 * differ. Each opens blank: a choice question that started on the case's value
 * would start on a value the other question saves and this one does not offer,
 * which the gate refuses (`SELECT_PRELOAD_WRITE_NOT_AN_OPTION`).
 */
function patients(
	extra: Partial<Parameters<typeof buildDoc>[0]> = {},
): BlueprintDoc {
	return withoutSelectStartingValues(patientsAsBuilt(extra));
}

/** The two follow-ups as `buildDoc` builds them, each choice question
 *  opening on its case's value. */
function patientsAsBuilt(
	extra: Partial<Parameters<typeof buildDoc>[0]>,
): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "condition_level", label: proseText("Patient status") },
					{ name: "weight", label: proseText("Weight"), data_type: "decimal" },
					{ name: "never_written", label: proseText("Nothing writes this") },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "single_select",
								id: "condition_level",
								uuid: STATUS,
								optionsSource: {
									kind: "inline",
									options: [
										{
											value: "well",
											label: proseText("Well"),
											uuid: testUuid("o-well"),
										},
										{
											value: "sick",
											label: proseText("Sick"),
											uuid: testUuid("o-sick"),
										},
									],
								},
								caseWrite: { caseType: "patient", property: "condition_level" },
							}),
							f({
								kind: "decimal",
								id: "weight",
								caseWrite: { caseType: "patient", property: "weight" },
							}),
						],
					},
					{
						name: "Check",
						type: "followup",
						fields: [
							f({
								kind: "single_select",
								id: "condition_level_again",
								uuid: AGAIN,
								optionsSource: {
									kind: "inline",
									options: [
										{
											value: "sick",
											label: proseText("Unwell"),
											uuid: testUuid("o-sick2"),
										},
										{
											value: "gone",
											label: proseText("Moved away"),
											uuid: testUuid("o-gone"),
										},
									],
								},
								caseWrite: { caseType: "patient", property: "condition_level" },
							}),
						],
					},
				],
			},
		],
		...extra,
	});
}

/** `doc` with no choice question opening on its case's value. */
function withoutSelectStartingValues(doc: BlueprintDoc): BlueprintDoc {
	return produce(doc, (draft) => {
		for (const field of Object.values(draft.fields))
			if (field.kind === "single_select" && "default_value" in field)
				delete (field as { default_value?: unknown }).default_value;
	});
}

/** A catalog with its labels as plain text, for a comparison by eye. */
function plain(catalog: NonNullable<BlueprintDoc["caseTypes"]> | null) {
	return (catalog ?? []).map((type) => ({
		...type,
		properties: type.properties.map((property) => ({
			...property,
			label: JSON.stringify(property.label),
			...(property.options !== undefined && {
				options: property.options.map(
					(option) => `${option.value}=${JSON.stringify(option.label)}`,
				),
			}),
		})),
	}));
}

describe("the case catalog of a reading", () => {
	it("is the catalog catalogAsRead states of the Nova-born document it was emitted from", async () => {
		const doc = patients();
		const reading = await readCases(doc);
		const read = reading.ctx.draft.caseTypes;
		expect(plain(read)).toEqual(plain(catalogAsRead(doc)));
		const patient = read?.find((type) => type.name === "patient");
		// Labels are the names, a property select questions alone write takes
		// their type, no other type is declared that no reader needs, and a
		// property nothing writes or reads is gone.
		expect(
			patient?.properties.map((property) => [
				property.name,
				property.data_type,
			]),
		).toEqual([
			["condition_level", "single_select"],
			["weight", undefined],
		]);
		expect(patient?.properties[0]?.label).toEqual(proseText("condition_level"));
	});

	it("types a property select questions alone write, so a case list that shows its choices emits and reads back", async () => {
		const base = patients();
		const moduleUuid = base.moduleOrder[0] as Uuid;
		const module = base.modules[moduleUuid];
		if (module === undefined) throw new Error("The app holds a menu.");
		const doc: BlueprintDoc = {
			...base,
			modules: {
				...base.modules,
				[moduleUuid]: {
					...module,
					caseListConfig: caseListConfigOf([
						plainColumn(
							testUuid("catalog-status-column"),
							"condition_level",
							"Status",
						),
					]),
				},
			},
		};
		// The canonical catalog is one Nova emits: the column's choice labels
		// are keyed by the property's declared select type.
		expect(() =>
			expandDoc({ ...doc, caseTypes: catalogAsRead(doc) }),
		).not.toThrow();
		// The reading's own emission of its catalog is total, and the column
		// reads as the choices it shows: no finding at all (an emission that
		// threw would name `expandDoc`).
		const outcome = readHqApp(await inputFor(exportedBody(doc)));
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		expect(
			outcome.draft.doc.caseTypes
				?.find((type) => type.name === "patient")
				?.properties.find((one) => one.name === "condition_level")?.data_type,
		).toBe("single_select");
	});

	it("merges the choices of every select that writes a property, the first label kept", () => {
		const status = catalogAsRead(patients())[0]?.properties.find(
			(one) => one.name === "condition_level",
		);
		expect(status?.options?.map((option) => option.value)).toEqual([
			"well",
			"sick",
			"gone",
		]);
		expect(status?.options?.[1]?.label).toEqual(proseText("Sick"));
	});

	it("names a child type's parent where its links agree, and none where they disagree", () => {
		const link = (target: string): CaseOperation => ({
			uuid: testUuid(`create-${target}`),
			id: `make_${target}`,
			action: "create",
			caseType: "visit",
			target: { kind: "new" },
			name: term(formField(testUuid("visit-name"))),
			links: [
				{
					identifier: "parent",
					targetType: target,
					target: { kind: "session" },
					relationship: "child",
				},
			],
		});
		const withLinks = (targets: readonly string[]) =>
			buildDoc(
				{
					caseTypes: [
						{ name: "patient", properties: [] },
						{ name: "household", properties: [] },
						{ name: "visit", properties: [] },
					],
					modules: [
						{
							name: "Patients",
							caseType: "patient",
							forms: [
								{
									uuid: "catalog-visit-form",
									name: "Visit",
									type: "followup",
									fields: [
										f({
											kind: "text",
											id: "visit_name",
											uuid: testUuid("visit-name"),
										}),
									],
								},
							],
						},
						{ name: "Households", caseType: "household", forms: [] },
					],
				},
				(built) => {
					const form = Object.keys(built.forms)[0] as keyof typeof built.forms;
					built.forms[form] = {
						...built.forms[form],
						caseOperations: targets.map(link),
					} as never;
				},
			);
		const agreeing = catalogAsRead(withLinks(["patient"])).find(
			(type) => type.name === "visit",
		);
		expect(agreeing).toMatchObject({
			parent_type: "patient",
			relationship: "child",
		});
		const disagreeing = catalogAsRead(withLinks(["patient", "household"])).find(
			(type) => type.name === "visit",
		);
		expect(disagreeing?.parent_type).toBeUndefined();
		expect(disagreeing?.relationship).toBeUndefined();
	});

	it("keeps a declared number type a sorted column needs where no writer types the property", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "rank", label: proseText("Rank"), data_type: "int" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfigOf([
						plainColumn(testUuid("rank-column"), "rank", "Rank", {
							sort: { direction: "asc", priority: 1 },
						}),
					]),
					forms: [],
				},
			],
		});
		const rank = catalogAsRead(doc)[0]?.properties.find(
			(one) => one.name === "rank",
		);
		expect(rank?.data_type).toBe("int");
	});

	// The sort element names one `date` comparison for every type of the date
	// class (`hqJson/caseList.ts::sortElementType`), and another for an untyped
	// property: the canonical catalog keeps the class, as the date class's one
	// type, so the document and its canonical member print one export, which
	// a whole reading gives back.
	it.each(["date", "datetime", "time"] as const)(
		"keeps the date class a sorted column's element names for a property only the catalog types %s",
		async (dataType) => {
			const doc = buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: proseText("Name") },
							{ name: "seen", label: proseText("Seen"), data_type: dataType },
						],
					},
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListConfig: caseListConfigOf([
							plainColumn(testUuid("seen-name"), "case_name", "Name"),
							plainColumn(testUuid("seen-column"), "seen", "Seen", {
								sort: { direction: "desc", priority: 1 },
							}),
						]),
						forms: [
							{
								name: "Visit",
								type: "followup",
								fields: [f({ kind: "text", id: "note" })],
							},
						],
					},
				],
			});
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
			const canonical = READER_CANONICAL_CHOICES.reduce(
				(current, choice) => choice.apply(current),
				doc,
			);
			const typeOf = (one: BlueprintDoc) =>
				one.caseTypes
					?.find((type) => type.name === "patient")
					?.properties.find((property) => property.name === "seen")?.data_type;
			expect(typeOf(canonical)).toBe("date");
			expect(expandDoc(canonical)).toEqual(expandDoc(doc));
			const outcome = readHqApp(await inputFor(exportedBody(doc)));
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			if (outcome.kind !== "read") throw new Error("The export did not read.");
			expect(plain(outcome.draft.doc.caseTypes ?? null)).toEqual(
				plain(canonical.caseTypes ?? null),
			);
		},
	);
});

describe("the writers of one property", () => {
	/** A menu of `patient` whose registration forms each save a name and one
	 *  question to a property. */
	function writers(
		pairs: readonly {
			kind: "int" | "decimal" | "text" | "single_select" | "multi_select";
			property: string;
		}[],
	): BlueprintDoc {
		return buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfigOf([
						plainColumn(testUuid("writers-name"), "case_name", "Name"),
					]),
					forms: pairs.map((pair, index) => ({
						name: `Register ${index + 1}`,
						type: "registration" as const,
						fields: [
							f({
								kind: "text",
								id: `name_${index + 1}`,
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: pair.kind,
								id: `answer_${index + 1}`,
								...((pair.kind === "single_select" ||
									pair.kind === "multi_select") && {
									optionsSource: {
										kind: "inline",
										options: [
											{
												value: "well",
												label: proseText("Well"),
												uuid: testUuid(`writer-well-${index}`),
											},
										],
									},
								}),
								caseWrite: { caseType: "patient", property: pair.property },
							}),
						],
					})),
				},
			],
		});
	}
	const WRITER_ENTRIES = new Set([
		"forms-and-case-writes/writers-single-select-multi-select",
		"forms-and-case-writes/any-other-mixed-writer-pair",
	]);
	const writerFindings = (reading: { findings: readonly { code: string }[] }) =>
		reading.findings
			.map((finding) => finding.code)
			.filter((code) => WRITER_ENTRIES.has(code));

	it("holds writers that agree on one stored type, int with decimal and text with a single choice, with no finding", async () => {
		const doc = writers([
			{ kind: "int", property: "weight" },
			{ kind: "decimal", property: "weight" },
			{ kind: "text", property: "level" },
			{ kind: "single_select", property: "level" },
		]);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const reading = await readMenusOf(doc);
		expect(reading.findings).toEqual([]);
		if (reading.doc === undefined)
			throw new Error("The writers read into a document.");
		const patient = effectiveCaseTypes(reading.doc).find(
			(type) => type.name === "patient",
		);
		const typeOf = (name: string) =>
			patient?.properties.find((one) => one.name === name)?.data_type;
		expect(typeOf("weight")).toBe("decimal");
		expect(typeOf("level")).toBe("text");
	});

	it("raises the row for a pair no one stored type joins: a single with a multiple choice, and any other", async () => {
		const reading = await readMenusOf(
			writers([
				{ kind: "single_select", property: "level" },
				{ kind: "multi_select", property: "level" },
				{ kind: "int", property: "weight" },
				{ kind: "text", property: "weight" },
			]),
		);
		expect(writerFindings(reading).sort()).toEqual([
			"forms-and-case-writes/any-other-mixed-writer-pair",
			"forms-and-case-writes/writers-single-select-multi-select",
		]);
	});
});

describe("the choices a Save to Case write gives", () => {
	it("gives a property a block saves a select's answer to that select's choices, as catalogAsRead states them", async () => {
		const doc = patients({
			caseTypes: [
				{ name: "patient", properties: [] },
				{ name: "visit", properties: [] },
			],
		});
		const visitForm = Object.keys(doc.forms)[0] as keyof typeof doc.forms;
		// A condition of two comparisons is no condition Case Management states,
		// so the create takes a Save to Case block.
		const create: CaseOperation = {
			uuid: testUuid("catalog-visit"),
			id: "visit",
			action: "create",
			caseType: "visit",
			target: { kind: "new" },
			name: term(formField(STATUS)),
			writes: [{ property: "level", value: term(formField(STATUS)) }],
			condition: or(
				eq(term(formField(STATUS)), literal("well")),
				eq(term(formField(STATUS)), literal("sick")),
			),
		};
		const withBlock: BlueprintDoc = {
			...doc,
			forms: {
				...doc.forms,
				[visitForm]: {
					...doc.forms[visitForm],
					caseOperations: [
						...(doc.forms[visitForm]?.caseOperations ?? []),
						create,
					],
				} as never,
			},
		};
		const reading = await readCases(withBlock);
		const visit = (catalog: NonNullable<BlueprintDoc["caseTypes"]> | null) =>
			plain(catalog).find((type) => type.name === "visit");
		expect(visit(reading.ctx.draft.caseTypes)).toEqual(
			visit(catalogAsRead(withBlock)),
		);
		expect(
			reading.ctx.draft.caseTypes
				?.find((type) => type.name === "visit")
				?.properties.find((one) => one.name === "level")
				?.options?.map((option) => option.value),
		).toEqual(["well", "sick"]);
	});
});

describe("the date-and-time join", () => {
	it("types the property a write through the join saves as a date and time, with no declaration", async () => {
		const original = datetimeSplitOriginal();
		const plan = planDatetimeSplits(original);
		if (!plan.ok) throw new Error(plan.message);
		const verdict = mutationCommitVerdict(
			original,
			plan.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!verdict.ok) throw new Error("The split is admitted.");
		const reading = await readMenusOf(verdict.nextDoc);
		expect(reading.findings).toEqual([]);
		const doc = reading.doc;
		if (doc === undefined) throw new Error("The split reads into a document.");
		const declared = doc.caseTypes
			?.find((type) => type.name === "visit")
			?.properties.find((one) => one.name === "seen_at");
		expect(declared).toBeDefined();
		expect(declared?.data_type).toBeUndefined();
		const effective = effectiveCaseTypes(doc)
			.find((type) => type.name === "visit")
			?.properties.find((one) => one.name === "seen_at");
		expect(effective?.data_type).toBe("datetime");
	});
});

/** A follow-up of patients that saves the district of the patient's parent (an update key
 *  `parent/district`), its catalog naming the parent `household` while nothing in the app does:
 *  no form opens a patient under a household and no menu chooses a household first. With
 *  `clinics`, a menu of clinics whose form opens a patient as a clinic's child, and the catalog
 *  names that parent. */
function parentWrite(clinics = false): BlueprintDoc {
	const parent = clinics ? "clinic" : "household";
	const nameColumn = (key: string) =>
		caseListConfigOf([
			plainColumn(testUuid(`${key}-name`), "case_name", "Name"),
		]);
	return buildDoc(
		{
			caseTypes: [
				{
					name: parent,
					properties: [
						{
							name: "district",
							label: proseText("District"),
							data_type: "text",
						},
					],
				},
				{
					name: "patient",
					parent_type: parent,
					relationship: "child",
					properties: [],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: nameColumn("patients"),
					forms: [
						{
							uuid: "parent-write-check",
							name: "Check",
							type: "followup",
							fields: [
								f({ kind: "text", id: "district", uuid: testUuid("district") }),
							],
						},
					],
				},
				{
					name: clinics ? "Clinics" : "Households",
					caseType: parent,
					caseListConfig: nameColumn(parent),
					forms: clinics
						? [
								{
									uuid: "parent-write-enrol",
									name: "Enrol",
									type: "followup",
									fields: [
										f({
											kind: "text",
											id: "patient_name",
											uuid: testUuid("patient-name"),
										}),
									],
								},
							]
						: [],
					...(!clinics && { caseListMenuItem: {} }),
				},
			],
		},
		(built) => {
			const forms = Object.values(built.forms);
			const check = forms.find((form) => form.name === "Check");
			if (check !== undefined)
				check.caseOperations = [
					{
						uuid: testUuid("parent-write-own"),
						id: "patient",
						action: "own",
						writes: [
							{
								property: "district",
								value: term(formField(testUuid("district"))),
								via: [{ identifier: "parent" }],
							},
						],
					},
				];
			const enrol = forms.find((form) => form.name === "Enrol");
			if (enrol !== undefined)
				enrol.caseOperations = [
					{
						uuid: testUuid("parent-write-enrol-patient"),
						id: "patient",
						action: "create",
						caseType: "patient",
						target: { kind: "new" },
						name: term(formField(testUuid("patient-name"))),
						links: [
							{
								identifier: "parent",
								targetType: "clinic",
								target: { kind: "session" },
								relationship: "child",
							},
						],
					},
				];
		},
	);
}

const ANCESTOR_UNKNOWN =
	"forms-and-case-writes/index-path-through-a-case-type-the-app-does-not-fix";

/** The steps of the patient's `district` write a reading gives. */
function districtVia(reading: Awaited<ReturnType<typeof readCases>>) {
	for (const form of reading.forms)
		for (const operation of form.form.caseOperations ?? [])
			for (const write of operation.writes ?? [])
				if (write.property === "district") return write.via;
	return undefined;
}

describe("a parent Nova holds that no export carries", () => {
	it("is the finding on a first reading, which is told no parent", async () => {
		const doc = parentWrite();
		const outcome = readHqApp(await inputFor(exportedBody(doc)));
		expect(
			(outcome.kind === "account" ? outcome.findings : []).map(
				(finding) => finding.code,
			),
		).toContain(ANCESTOR_UNKNOWN);
	});

	it("reads back the write through it when the reading is told the document's parents", async () => {
		const doc = parentWrite();
		const outcome = readHqApp(
			await inputFor(exportedBody(doc), {
				knownCaseTypes: knownCaseTypesOf(doc),
			}),
		);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const patient = outcome.draft.doc.caseTypes?.find(
			(type) => type.name === "patient",
		);
		expect(patient).toMatchObject({
			parent_type: "household",
			relationship: "child",
		});
		expect(plain(outcome.draft.doc.caseTypes)).toEqual(
			plain(catalogAsRead(doc)),
		);
		const reading = await readCases(doc);
		expect(districtVia(reading)).toEqual([
			{ identifier: "parent", throughCaseType: "household" },
		]);
	});

	it("never overrides the parent a link of the app names", async () => {
		const doc = parentWrite(true);
		const reading = await readCases(doc, {
			input: (read) => ({
				...read,
				knownCaseTypes: {
					targetOf: (caseType, identifier) =>
						caseType === "patient" && identifier === "parent"
							? { caseType: "household", relationship: "child" }
							: undefined,
				},
			}),
		});
		expect(findingCodes(reading)).not.toContain(ANCESTOR_UNKNOWN);
		expect(
			reading.ctx.draft.caseTypes?.find((type) => type.name === "patient"),
		).toMatchObject({ parent_type: "clinic", relationship: "child" });
		expect(
			reading.ctx.draft.caseTypes?.some((type) => type.name === "household"),
		).toBe(false);
		expect(districtVia(reading)).toEqual([
			{ identifier: "parent", throughCaseType: "clinic" },
		]);
	});
});

/** `parentWrite` with the patient's `district` saved through its `host` index
 *  instead, typed `household` in the step itself, and no parent in the
 *  catalog. With `alsoRead`, a Hidden Value of the form reads a household
 *  property through the patient's index named so, typed by its own step. */
function hostWrite(alsoRead?: {
	readonly identifier: string;
	readonly reaches: string;
}): BlueprintDoc {
	const doc = parentWrite();
	const check = Object.values(doc.forms).find((form) => form.name === "Check");
	if (check === undefined) throw new Error("The app holds Check.");
	const caseTypes = (doc.caseTypes ?? []).map((type) =>
		type.name === "patient"
			? { name: type.name, properties: type.properties }
			: type,
	);
	return {
		...doc,
		caseTypes,
		forms: {
			...doc.forms,
			[check.uuid]: {
				...check,
				caseOperations: [
					{
						uuid: testUuid("parent-write-own"),
						id: "patient",
						action: "own",
						writes: [
							{
								property: "district",
								value: term(formField(testUuid("district"))),
								via: [relationStep("host", "household")],
							},
						],
					},
				],
			},
		},
		...(alsoRead !== undefined && {
			fields: {
				...doc.fields,
				[testUuid("district")]: {
					...(doc.fields[
						testUuid("district")
					] as BlueprintDoc["fields"][string]),
					default_value: term(
						prop(
							"patient",
							"district",
							ancestorPath(relationStep(alsoRead.identifier, alsoRead.reaches)),
						),
					),
				} as BlueprintDoc["fields"][string],
			},
		}),
	};
}

describe("an index Nova types in a step that no export carries", () => {
	it("is the finding on a first reading of a save through host, and reads back when told the document's steps", async () => {
		const doc = hostWrite();
		const first = readHqApp(await inputFor(exportedBody(doc)));
		expect(
			(first.kind === "account" ? first.findings : []).map(
				(finding) => finding.code,
			),
		).toContain(ANCESTOR_UNKNOWN);
		expect(knownCaseTypesOf(doc).targetOf("patient", "host")).toEqual({
			caseType: "household",
		});
		const reading = await readCases(doc);
		expect(findingCodes(reading)).not.toContain(ANCESTOR_UNKNOWN);
		expect(districtVia(reading)).toEqual([
			{ identifier: "host", throughCaseType: "household" },
		]);
	});

	it("answers a custom index by the type the step reading through it names, and nothing for parent beyond the catalog", () => {
		const known = knownCaseTypesOf(
			hostWrite({ identifier: "clinic_link", reaches: "household" }),
		);
		expect(known.targetOf("patient", "clinic_link")).toEqual({
			caseType: "household",
		});
		expect(known.targetOf("patient", "parent")).toBeUndefined();
		expect(known.targetOf("household", "host")).toBeUndefined();
	});

	it("answers nothing where two steps through one index disagree, and the reading keeps its finding", async () => {
		const known = knownCaseTypesOf(
			hostWrite({ identifier: "host", reaches: "clinic" }),
		);
		expect(known.targetOf("patient", "host")).toBeUndefined();
		const reading = await readCases(hostWrite(), {
			input: (read) => ({ ...read, knownCaseTypes: known }),
		});
		expect(findingCodes(reading)).toContain(ANCESTOR_UNKNOWN);
	});
});

/** A follow-up whose Hidden Value `seen`, calculated by `calculate`, is the one writer of the
 *  patient's `seen_at`, which the catalog declares a date and time. */
function hiddenSeen(calculate: string): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "seen_at", label: proseText("Seen"), data_type: "datetime" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfigOf([
					plainColumn(testUuid("seen-name"), "case_name", "Name"),
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "hidden",
								id: "seen",
								calculate,
								caseWrite: { caseType: "patient", property: "seen_at" },
							}),
						],
					},
				],
			},
		],
	});
}

describe("a Hidden Value bound as a date and time", () => {
	it("types the property it alone writes from its bind, where its value gives no type", async () => {
		const doc = hiddenSeen("#patient/seen_at");
		const outcome = readHqApp(await inputFor(exportedBody(doc)));
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const seen = outcome.draft.doc.caseTypes
			?.find((type) => type.name === "patient")
			?.properties.find((one) => one.name === "seen_at");
		expect(seen?.data_type).toBe("datetime");
		expect(plain(outcome.draft.doc.caseTypes)).toEqual(
			plain(catalogAsRead(doc)),
		);
	});

	it("declares nothing where its value types the property", async () => {
		const doc = hiddenSeen("now()");
		const outcome = readHqApp(await inputFor(exportedBody(doc)));
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const seen = outcome.draft.doc.caseTypes
			?.find((type) => type.name === "patient")
			?.properties.find((one) => one.name === "seen_at");
		expect(seen).toBeDefined();
		expect(seen?.data_type).toBeUndefined();
		expect(plain(outcome.draft.doc.caseTypes)).toEqual(
			plain(catalogAsRead(doc)),
		);
	});
});

describe("noteProperty", () => {
	it("places a property in name order, once, and leaves out a standard one and an unknown type", () => {
		const catalog: NonNullable<BlueprintDoc["caseTypes"]> = [
			{ name: "patient", properties: [] },
		];
		noteProperty(catalog, "patient", "weight");
		noteProperty(catalog, "patient", "age");
		noteProperty(catalog, "patient", "weight");
		noteProperty(catalog, "patient", "case_name");
		noteProperty(catalog, "household", "size");
		expect(catalog).toEqual([
			{
				name: "patient",
				properties: [
					{ name: "age", label: proseText("age") },
					{ name: "weight", label: proseText("weight") },
				],
			},
		]);
	});
});

/**
 * A simple Search field that reads a property of a related case. Contract:
 * the property is a property of the case type the field's relation reaches,
 * which the search's own filter prints a read of, so the canonical catalog
 * names it there, as the reading does, with the type a date field's
 * derivation prints by. The plausible failures: the canonical catalog left
 * without the property while a reading of the export holds it, so the
 * document and its reading never compare equal; and a date field's related
 * property left untyped, so the canonical member cannot be printed at all.
 */
describe("a Search field that reads a related case", () => {
	/** A patient menu whose Search field reads the household's `village`,
	 *  a text field, or a date field over a property of `dataType`. */
	function villageSearch(dataType?: "date" | "datetime"): BlueprintDoc {
		return buildDoc({
			caseTypes: [
				{
					name: "household",
					properties: [
						{
							name: "village",
							label: proseText("Village"),
							...(dataType !== undefined && { data_type: dataType }),
						},
					],
				},
				{
					name: "patient",
					parent_type: "household",
					relationship: "child",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					uuid: testUuid("village-menu"),
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						...caseListConfigOf([
							plainColumn(testUuid("village-name"), "case_name", "Name"),
						]),
						searchInputs: [
							{
								uuid: testUuid("village-input"),
								name: "village",
								label: "Village",
								kind: "simple",
								type: dataType === undefined ? "text" : "date",
								property: "village",
								via: ancestorPath(relationStep("parent", "household")),
							},
						],
					},
					caseSearchConfig: {},
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});
	}

	/** The canonical member of `doc` holds `village` as `expected` states it,
	 *  the gate admits it, both print one export, and a whole reading of the
	 *  export gives the canonical catalog with no finding. */
	async function holdsAsRead(
		doc: BlueprintDoc,
		expected: NonNullable<BlueprintDoc["caseTypes"]>[number]["properties"],
	) {
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const canonical = READER_CANONICAL_CHOICES.reduce(
			(current, choice) => choice.apply(current),
			doc,
		);
		expect(
			canonical.caseTypes?.find((type) => type.name === "household")
				?.properties,
		).toEqual(expected);
		expect(runValidation(canonical, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(expandDoc(canonical)).toEqual(expandDoc(doc));
		const outcome = readHqApp(
			await inputFor(exportedBody(doc), {
				knownCaseTypes: knownCaseTypesOf(doc),
			}),
		);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		expect(plain(outcome.draft.doc.caseTypes ?? null)).toEqual(
			plain(canonical.caseTypes ?? null),
		);
	}

	it("names the property on the type the relation reaches, as a reading of the export does", async () => {
		// The label reaches no export, so the canonical member labels the
		// property by its name.
		await holdsAsRead(villageSearch(), [
			{ name: "village", label: proseText("village") },
		]);
	});

	// A date field's derivation prints the boundaries the related property's
	// type gives (`dateSearch.ts::exactDateSearchPredicate`), so the canonical
	// member keeps that type, which a reading declares too.
	it.each(["date", "datetime"] as const)(
		"keeps the %s type of the related property a date field reads",
		async (dataType) => {
			await holdsAsRead(villageSearch(dataType), [
				{ name: "village", label: proseText("village"), data_type: dataType },
			]);
		},
	);
});
