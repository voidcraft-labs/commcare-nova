/**
 * The questions a form's case names and external ids come from, and how
 * each is checked.
 */
import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	caseCreateNameFields,
	caseScalarTextGuards,
	proseText,
	type Uuid,
} from "@/lib/domain";

const write = (property: string, caseType = "patient") => ({
	caseWrite: { caseType, property },
});

function app(type: "registration" | "followup") {
	return buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: ["case_name", "external_id", "note"].map((name) => ({
					name,
					label: proseText(name),
				})),
			},
			{
				name: "visit",
				parent_type: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Record",
						type,
						fields: [
							f({ kind: "text", id: "name", ...write("case_name") }),
							f({ kind: "text", id: "external", ...write("external_id") }),
							f({ kind: "text", id: "note", ...write("note") }),
							f({
								kind: "repeat",
								id: "visits",
								repeat_mode: "user_controlled",
								children: [
									f({
										kind: "text",
										id: "visit_name",
										...write("case_name", "visit"),
									}),
								],
							}),
							f({
								kind: "hidden",
								id: "computed_name",
								calculate: "'Visit'",
							}),
						],
					},
				],
			},
		],
	});
}

function byId(doc: BlueprintDoc, map: ReadonlyMap<Uuid, string>) {
	return Object.fromEntries(
		[...map].map(([uuid, guard]) => [doc.fields[uuid]?.id, guard]),
	);
}

it("checks a create name, an external id and a child's name in a repeat", () => {
	const doc = app("registration");
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	expect(byId(doc, caseScalarTextGuards(doc, formUuid))).toEqual({
		name: "reject",
		external: "allow",
		visit_name: "reject",
	});
	expect(
		[...caseCreateNameFields(doc, formUuid)].map(
			(uuid) => doc.fields[uuid]?.id,
		),
	).toEqual(["name", "visit_name"]);
});

it("checks a rename but does not count it as a create name", () => {
	const doc = app("followup");
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	expect(byId(doc, caseScalarTextGuards(doc, formUuid))).toMatchObject({
		name: "reject",
	});
	expect(
		[...caseCreateNameFields(doc, formUuid)].map(
			(uuid) => doc.fields[uuid]?.id,
		),
	).toEqual(["visit_name"]);
});

it("includes a Hidden Value source, which takes the trimmed sibling", () => {
	const doc = app("registration");
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const hidden = Object.values(doc.fields).find(
		(field) => field.id === "computed_name",
	);
	const name = Object.values(doc.fields).find((field) => field.id === "name");
	if (hidden === undefined || name === undefined)
		throw new Error("Missing fixture field");
	Object.assign(hidden, {
		caseWrite: { caseType: "patient", property: "case_name" },
	});
	Object.assign(name, { caseWrite: undefined });
	expect(byId(doc, caseScalarTextGuards(doc, formUuid))).toMatchObject({
		computed_name: "reject",
	});
});
