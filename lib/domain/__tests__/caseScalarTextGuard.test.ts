/**
 * The questions a form's case names and external ids come from, and how
 * each is checked.
 */
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOperation,
	caseCreateNameFields,
	caseOperationSchema,
	caseScalarTextGuards,
	proseText,
	type Uuid,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";

const FORM = testUuid("guard-form");
const OWN = testUuid("guard-own");
const VISIT = testUuid("guard-visit");
const WORKER = testUuid("guard-worker");
const NAME = testUuid("guard-name");
const EXTERNAL = testUuid("guard-external");
const NOTE = testUuid("guard-note");
const VISITS = testUuid("guard-visits");
const VISIT_NAME = testUuid("guard-visit-name");
const COMPUTED = testUuid("guard-computed");

const read = (uuid: Uuid): Expression => ({
	kind: "term",
	term: { kind: "field", uuid },
});

function app(
	type: "registration" | "followup",
	ownName: Uuid = NAME,
): BlueprintDoc {
	const operations: CaseOperation[] = [
		{
			uuid: OWN,
			id: "patient",
			action: "own",
			name: read(ownName),
			writes: [
				{ property: "external_id", value: read(EXTERNAL) },
				{ property: "note", value: read(NOTE) },
			],
		},
		{
			uuid: VISIT,
			id: "visit",
			action: "create",
			caseType: "visit",
			target: { kind: "new" },
			forEach: { repeat: VISITS },
			name: read(VISIT_NAME),
			// A child case under the form's own case, so its basic subcase
			// action reads the name.
			links: [
				{
					identifier: "parent",
					targetType: "patient",
					target:
						type === "registration"
							? { kind: "op", opUuid: OWN }
							: { kind: "session" },
					relationship: "child",
				},
			],
		},
		// The worker's record keeps neither value.
		{
			uuid: WORKER,
			id: "worker",
			action: "update",
			caseType: "commcare-user",
			target: { kind: "worker-record" },
			writes: [{ property: "external_id", value: read(NOTE) }],
		},
	];
	const parsed = operations.map((operation) =>
		caseOperationSchema.parse(operation),
	);
	return buildDoc(
		{
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
							uuid: FORM,
							name: "Record",
							type,
							fields: [
								f({ kind: "text", id: "name", uuid: NAME }),
								f({ kind: "text", id: "external", uuid: EXTERNAL }),
								f({ kind: "text", id: "note", uuid: NOTE }),
								f({
									kind: "repeat",
									id: "visits",
									uuid: VISITS,
									repeat_mode: "user_controlled",
									children: [
										f({ kind: "text", id: "visit_name", uuid: VISIT_NAME }),
									],
								}),
								f({
									kind: "hidden",
									id: "computed_name",
									uuid: COMPUTED,
									calculate: "'Visit'",
								}),
							],
						},
					],
				},
			],
		},
		(doc) => {
			const form = doc.forms[FORM];
			if (form === undefined) throw new Error("The fixture form is missing.");
			form.caseOperations = parsed as typeof form.caseOperations;
		},
	);
}

function byId(doc: BlueprintDoc, map: ReadonlyMap<Uuid, string>) {
	return Object.fromEntries(
		[...map].map(([uuid, guard]) => [doc.fields[uuid]?.id, guard]),
	);
}

it("checks a create name, an external id and a child's name in a repeat", () => {
	const doc = app("registration");
	expect(byId(doc, caseScalarTextGuards(doc, FORM))).toEqual({
		name: "reject",
		external: "allow",
		visit_name: "reject",
	});
	expect(
		[...caseCreateNameFields(doc, FORM)].map((uuid) => doc.fields[uuid]?.id),
	).toEqual(["name", "visit_name"]);
});

it("checks a rename but does not count it as a create name", () => {
	const doc = app("followup");
	expect(byId(doc, caseScalarTextGuards(doc, FORM))).toMatchObject({
		name: "reject",
	});
	expect(
		[...caseCreateNameFields(doc, FORM)].map((uuid) => doc.fields[uuid]?.id),
	).toEqual(["visit_name"]);
});

it("includes a Hidden Value source, which takes the trimmed sibling", () => {
	const doc = app("registration", COMPUTED);
	expect(byId(doc, caseScalarTextGuards(doc, FORM))).toMatchObject({
		computed_name: "reject",
	});
	expect(byId(doc, caseScalarTextGuards(doc, FORM))).not.toHaveProperty("name");
});

it("leaves a create under no case of the form to the block that saves it", () => {
	// Unlinked, the visit is a Save to Case block, which trims and checks the
	// name it writes itself.
	const doc = app("registration");
	const form = doc.forms[FORM];
	const visit = form?.caseOperations?.find(
		(operation) => operation.uuid === VISIT,
	);
	if (visit === undefined || visit.action !== "create")
		throw new Error("The fixture visit is missing.");
	delete visit.links;
	expect(byId(doc, caseScalarTextGuards(doc, FORM))).toEqual({
		name: "reject",
		external: "allow",
	});
	expect(
		[...caseCreateNameFields(doc, FORM)].map((uuid) => doc.fields[uuid]?.id),
	).toEqual(["name"]);
});

it("checks only the questions a basic action reads where the caller knows the placement", () => {
	// A child create placed in a Save to Case block (a conditional one, say)
	// trims and checks its own name, so its question takes no sibling.
	const doc = app("registration");
	const placedBasic = (operationUuid: Uuid) => operationUuid !== VISIT;
	expect(byId(doc, caseScalarTextGuards(doc, FORM, { placedBasic }))).toEqual({
		name: "reject",
		external: "allow",
	});
	expect(
		[...caseCreateNameFields(doc, FORM, { placedBasic })].map(
			(uuid) => doc.fields[uuid]?.id,
		),
	).toEqual(["name"]);
	// Without the placement, the candidates keep the child's name.
	expect(byId(doc, caseScalarTextGuards(doc, FORM))).toHaveProperty(
		"visit_name",
		"reject",
	);
});
