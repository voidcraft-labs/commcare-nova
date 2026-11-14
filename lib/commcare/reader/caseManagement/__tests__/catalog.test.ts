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
 * Hidden Value types it. `catalogAsRead(D)` states the same catalog of a
 * Nova-born document, whatever labels, unneeded types and unread properties D's own catalog
 * holds. The plausible failures: a declared type that a writer contradicts
 * (the gate would refuse the document), a parent named where two links
 * disagree, and a canonical choice that states another catalog than the
 * reader derives, so a document and its reading would never compare equal.
 */
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
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import {
	eq,
	formField,
	literal,
	or,
	term,
} from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import { readMenusOf } from "../../menus/__tests__/menuReading";
import { catalogAsRead, noteProperty } from "../catalog";
import { readCases } from "./caseReading";

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

function patients(
	extra: Partial<Parameters<typeof buildDoc>[0]> = {},
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
		// Labels are the names, no type is declared that no reader needs, and
		// a property nothing writes or reads is gone.
		expect(patient?.properties.map((property) => property.name)).toEqual([
			"condition_level",
			"weight",
		]);
		expect(
			patient?.properties.every((property) => property.data_type === undefined),
		).toBe(true);
		expect(patient?.properties[0]?.label).toEqual(proseText("condition_level"));
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
