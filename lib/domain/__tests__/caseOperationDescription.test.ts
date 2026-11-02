/**
 * `describeCaseOperation` names a case change the way the builder's case
 * changes screen does, so the identity-move dialog, the tool results and the
 * offered moves read the row's own sentence. Each case builds a document and
 * compares the describer with the row sentence printed over the labels a
 * person reads in that document: the module's case type, an operation's id,
 * a repeat's and a field's label.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOperation,
	caseOperationSchema,
	describeCaseOperation,
	type OperationSentenceContext,
	operationSentence,
	operationSentenceText,
	proseText,
	type Uuid,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";

const FORM = testUuid("describe-form");
const NAME = testUuid("describe-name");
const REFERRAL_KEY = testUuid("describe-referral-key");
const BEDS = testUuid("describe-beds");
const BED_LABEL = testUuid("describe-bed-label");
const OWN = testUuid("describe-own");
const CREATE = testUuid("describe-create");
const UPDATE = testUuid("describe-update");
const EACH = testUuid("describe-each");
const GONE = testUuid("describe-gone");

const read = (uuid: Uuid): Expression => ({
	kind: "term",
	term: { kind: "field", uuid },
});

const OPERATIONS: readonly CaseOperation[] = [
	{
		uuid: OWN,
		id: "patient",
		action: "own",
		writes: [{ property: "village", value: read(NAME) }],
	},
	{
		uuid: CREATE,
		id: "make_referral",
		action: "create",
		caseType: "referral",
		target: { kind: "new", idFrom: REFERRAL_KEY },
		name: read(NAME),
	},
	{
		uuid: UPDATE,
		id: "touch_referral",
		action: "update",
		caseType: "referral",
		target: { kind: "op", opUuid: CREATE },
		writes: [
			{ property: "status", value: read(NAME) },
			{ property: "note", value: read(NAME) },
		],
	},
	{
		uuid: EACH,
		id: "make_bed",
		action: "create",
		caseType: "bed",
		target: { kind: "new" },
		name: read(BED_LABEL),
		forEach: { repeat: BEDS },
	},
];

/** A patient follow-up form whose case operations are `OPERATIONS`, each
 *  parsed through the stored schema so the fixture is one the document
 *  admits. */
function app(): BlueprintDoc {
	const parsed = OPERATIONS.map((operation) =>
		caseOperationSchema.parse(operation),
	);
	return buildDoc(
		{
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "village", label: proseText("Village") }],
				},
				{
					name: "referral",
					parent_type: "patient",
					properties: ["status", "note"].map((name) => ({
						name,
						label: proseText(name),
					})),
				},
				{ name: "bed", properties: [] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: FORM,
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "name",
									uuid: NAME,
									label: proseText("Name"),
								}),
								f({
									kind: "text",
									id: "referral_key",
									uuid: REFERRAL_KEY,
									label: proseText("Referral ID"),
								}),
								f({
									kind: "repeat",
									id: "beds",
									uuid: BEDS,
									label: proseText("Beds"),
									repeat_mode: "user_controlled",
									children: [
										f({
											kind: "text",
											id: "bed_label",
											uuid: BED_LABEL,
											label: proseText("Bed label"),
										}),
									],
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

/** The words a person reads in this document for what each uuid names. */
const LABELS: Record<string, string> = {
	[CREATE]: "make_referral",
	[UPDATE]: "touch_referral",
	[EACH]: "make_bed",
	[BEDS]: "Beds",
	[REFERRAL_KEY]: "Referral ID",
	[NAME]: "Name",
	[BED_LABEL]: "Bed label",
};

const shown: OperationSentenceContext = {
	formType: "followup",
	ownCaseType: "patient",
	operationName: (uuid) => LABELS[uuid],
	repeatLabel: (uuid) => LABELS[uuid],
	fieldLabel: (uuid) => LABELS[uuid],
};

function operation(uuid: Uuid): CaseOperation {
	const found = OPERATIONS.find((candidate) => candidate.uuid === uuid);
	if (found === undefined) throw new Error("The fixture operation is missing.");
	return found;
}

describe("describeCaseOperation", () => {
	const doc = app();

	it.each([
		["the own arm", OWN],
		["a keyed create", CREATE],
		["an update of an earlier create", UPDATE],
		["a create once for each repeat entry", EACH],
	])("reads %s as the builder's row does", (_name, uuid) => {
		expect(describeCaseOperation(doc, FORM, uuid)).toBe(
			operationSentenceText(operationSentence(operation(uuid), shown)),
		);
	});

	it("names the earlier create an update reads, by its id", () => {
		expect(describeCaseOperation(doc, FORM, UPDATE)).toBe(
			"Update the referral case from “make_referral”: saves 2 properties",
		);
	});

	it("reads an operation the form no longer holds as an unnamed case change", () => {
		expect(describeCaseOperation(doc, FORM, GONE)).toBe("A case change");
	});
});
