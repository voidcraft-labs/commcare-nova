// The operations field writes become, as the cutover and the fuzz mapping
// plan them (classes C1 to C3 of part 01 §22). Catches a dry run and its
// execution, or two fuzz mappings of one draw, naming different operations,
// and a plan whose order the wire cannot run.

import { Immer } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	type FieldWriteFact,
	operationsFromFieldWrites,
} from "@/lib/doc/fieldWriteOperations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	type Mutation,
	mutationSchema,
} from "@/lib/doc/types";
import {
	type CaseOperation,
	caseWriteOperationUuid,
	type Expression,
	type Uuid,
} from "@/lib/domain";

const APP = "field-writes-app";
const MODULE = testUuid("writes-module");
const REG = testUuid("writes-registration");
const FUP = testUuid("writes-followup");
const NAME = testUuid("writes-name");
const NOTE = testUuid("writes-note");
const PHOTO = testUuid("writes-photo");
const HEAD = testUuid("writes-head");
const COLOR = testUuid("writes-color");
const MEMBERS = testUuid("writes-members");
const MEMBER = testUuid("writes-member");
const MEMBER_AGE = testUuid("writes-member-age");
const ASSET = testUuid("writes-asset");
const CLINIC = testUuid("writes-clinic");
const FUP_NOTE = testUuid("writes-fup-note");
const STORED_ROOT = testUuid("writes-stored-root");
const STORED_ROW = testUuid("writes-stored-row");
const COLOR_PROPERTY = testUuid("writes-user-color");

const read = (uuid: Uuid): Expression => ({
	kind: "term",
	term: { kind: "field", uuid },
});
const link = (uuid: Uuid): Expression => ({
	kind: "term",
	term: { kind: "capture-link", field: uuid },
});

const viewer = (caseType: string) => ({
	name: caseType,
	caseType,
	caseListOnly: true,
	caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
});

/** A registration and a follow-up as the old shape stored them: no
 *  operation made from a field write yet, one stored create at the root and
 *  one in the repeat. */
function fixture(): BlueprintDoc {
	const doc = buildDoc(
		{
			appId: APP,
			caseTypes: [
				{
					name: "household",
					properties: [
						{ name: "note", label: "Note" },
						{ name: "photo", label: "Photo" },
					],
				},
				{
					name: "member",
					parent_type: "household",
					relationship: "child",
					properties: [{ name: "age", label: "Age" }],
				},
				{
					name: "asset",
					parent_type: "household",
					relationship: "extension",
					properties: [],
				},
				{ name: "clinic", properties: [] },
			],
			modules: [
				{
					uuid: MODULE,
					name: "Households",
					caseType: "household",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: REG,
							name: "Register",
							type: "registration",
							fields: [
								f({ uuid: NAME, kind: "text", id: "hh_name" }),
								f({ uuid: NOTE, kind: "text", id: "note" }),
								f({ uuid: PHOTO, kind: "image", id: "photo" }),
								f({ uuid: HEAD, kind: "text", id: "head" }),
								f({ uuid: COLOR, kind: "text", id: "color" }),
								f({ uuid: CLINIC, kind: "text", id: "clinic" }),
								f({
									uuid: MEMBERS,
									kind: "repeat",
									id: "members",
									children: [
										f({ uuid: MEMBER, kind: "text", id: "member" }),
										f({ uuid: MEMBER_AGE, kind: "int", id: "age" }),
										f({ uuid: ASSET, kind: "text", id: "asset" }),
									],
								}),
							],
						},
						{
							uuid: FUP,
							name: "Visit",
							type: "followup",
							fields: [f({ uuid: FUP_NOTE, kind: "text", id: "fup_note" })],
						},
					],
				},
				viewer("member"),
				viewer("asset"),
				viewer("clinic"),
			],
		},
		(draft) => {
			draft.userProperties = {
				[COLOR_PROPERTY]: {
					uuid: COLOR_PROPERTY,
					slug: "favorite_color",
					label: "Favorite color",
				},
			};
			draft.userPropertyOrder = [COLOR_PROPERTY];
		},
	);
	doc.forms[REG].caseOperations = [
		{
			uuid: STORED_ROOT,
			id: "clinic",
			action: "create",
			caseType: "clinic",
			target: { kind: "new" },
			name: read(CLINIC),
		},
		{
			uuid: STORED_ROW,
			id: "clinic_row",
			action: "create",
			caseType: "clinic",
			target: { kind: "new" },
			name: read(ASSET),
			forEach: { repeat: MEMBERS },
		},
	];
	delete doc.forms[FUP].caseOperations;
	return doc;
}

const FACTS: readonly FieldWriteFact[] = [
	{
		fieldUuid: NAME,
		caseType: "household",
		property: "case_name",
		capture: false,
	},
	{ fieldUuid: NOTE, caseType: "household", property: "note", capture: false },
	{ fieldUuid: PHOTO, caseType: "household", property: "photo", capture: true },
	{
		fieldUuid: HEAD,
		caseType: "member",
		property: "case_name",
		capture: false,
	},
	{
		fieldUuid: COLOR,
		caseType: "commcare-user",
		property: "favorite_color",
		capture: false,
	},
	{
		fieldUuid: MEMBER,
		caseType: "member",
		property: "case_name",
		capture: false,
	},
	{
		fieldUuid: MEMBER_AGE,
		caseType: "member",
		property: "age",
		capture: false,
	},
	{
		fieldUuid: ASSET,
		caseType: "asset",
		property: "case_name",
		capture: false,
	},
];

const UNFROZEN = new Immer({ autoFreeze: false });

function applied(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	return UNFROZEN.produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

const unit = (
	name: Parameters<typeof caseWriteOperationUuid>[2],
	attempt = 0,
) => caseWriteOperationUuid(APP, REG, name, attempt);

describe("operationsFromFieldWrites", () => {
	it("makes each bucket's operation, in the order the wire runs them", () => {
		const doc = fixture();
		const next = applied(doc, operationsFromFieldWrites(doc, REG, FACTS));
		const operations = next.forms[REG]?.caseOperations ?? [];
		const ownUuid = unit("own");
		expect(operations.map((operation) => operation.uuid)).toEqual([
			ownUuid,
			STORED_ROOT,
			unit("child:member:root"),
			unit("usercase"),
			STORED_ROW,
			unit(`child:member:${MEMBERS}`),
			unit(`extension:asset:${MEMBERS}`),
		]);
		const byUuid = new Map(
			operations.map((operation) => [operation.uuid, operation]),
		);
		expect(byUuid.get(ownUuid)).toEqual({
			uuid: ownUuid,
			id: "household",
			action: "own",
			name: read(NAME),
			writes: [
				{ property: "note", value: read(NOTE) },
				{ property: "photo", value: link(PHOTO) },
			],
		});
		const parentLink = (relationship: "child" | "extension") => [
			{
				identifier: "parent",
				targetType: "household",
				target: { kind: "op" as const, opUuid: ownUuid },
				relationship,
			},
		];
		expect(byUuid.get(unit("child:member:root"))).toEqual({
			uuid: unit("child:member:root"),
			id: "member",
			action: "create",
			caseType: "member",
			target: { kind: "new" },
			name: read(HEAD),
			links: parentLink("child"),
		} satisfies CaseOperation);
		expect(byUuid.get(unit(`child:member:${MEMBERS}`))).toMatchObject({
			id: "member_2",
			name: read(MEMBER),
			writes: [{ property: "age", value: read(MEMBER_AGE) }],
			forEach: { repeat: MEMBERS },
			links: parentLink("child"),
		});
		expect(byUuid.get(unit(`extension:asset:${MEMBERS}`))).toMatchObject({
			id: "asset",
			caseType: "asset",
			name: read(ASSET),
			forEach: { repeat: MEMBERS },
			links: parentLink("extension"),
		});
		expect(byUuid.get(unit("usercase"))).toEqual({
			uuid: unit("usercase"),
			id: "commcare_user",
			action: "update",
			caseType: "commcare-user",
			target: { kind: "worker-record" },
			writes: [{ property: "favorite_color", value: read(COLOR) }],
		});
	});

	it("names the same operations on a second run, and plans nothing over its own result", () => {
		const doc = fixture();
		const first = operationsFromFieldWrites(doc, REG, FACTS);
		expect(operationsFromFieldWrites(fixture(), REG, FACTS)).toEqual(first);
		const next = applied(doc, first);
		expect(operationsFromFieldWrites(next, REG, FACTS)).toEqual([]);
	});

	it("steps around a UUID the document already holds", () => {
		const doc = fixture();
		const stored = doc.forms[REG].caseOperations ?? [];
		doc.forms[REG].caseOperations = stored.map((operation) =>
			operation.uuid === STORED_ROOT
				? { ...operation, uuid: unit("own") }
				: operation,
		);
		const next = applied(doc, operationsFromFieldWrites(doc, REG, FACTS));
		expect(next.forms[REG]?.caseOperations?.[0]).toMatchObject({
			action: "own",
			uuid: unit("own", 1),
		});
	});

	it("gives a follow-up's own case its writes against the loaded case", () => {
		const doc = fixture();
		const next = applied(
			doc,
			operationsFromFieldWrites(doc, FUP, [
				{
					fieldUuid: FUP_NOTE,
					caseType: "household",
					property: "note",
					capture: false,
				},
			]),
		);
		expect(next.forms[FUP]?.caseOperations).toEqual([
			{
				uuid: caseWriteOperationUuid(APP, FUP, "own"),
				id: "household",
				action: "own",
				writes: [{ property: "note", value: read(FUP_NOTE) }],
			},
		]);
	});

	// Gate-dependent: the validator rules of pull request 4 (the own case,
	// placement, the worker's record) decide this batch.
	it("lands a batch the gate admits", () => {
		const doc = fixture();
		const parsed = [
			...operationsFromFieldWrites(doc, REG, FACTS),
			...operationsFromFieldWrites(doc, FUP, [
				{
					fieldUuid: FUP_NOTE,
					caseType: "household",
					property: "note",
					capture: false,
				},
			]),
		].map((mutation) =>
			mutationSchema.parse(JSON.parse(JSON.stringify(mutation))),
		);
		const verdict = mutationCommitVerdict(
			doc,
			parsed,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	});
});
