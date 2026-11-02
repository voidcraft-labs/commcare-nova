/**
 * A field's "Saves to" is the view of the case-operation writes that save its
 * answer as it is. The builder, the tools and every reader of a field's
 * destination read these views, so a write the view leaves out is one the
 * field would be shown not to make, and a write it takes in is one the field
 * would be shown making when it saves something computed.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { ensureReferenceIndex } from "@/lib/doc/referenceIndex";
import {
	type BlueprintDoc,
	type CaseOperation,
	caseOperationSchema,
	fieldCaseWriteViewKey,
	fieldCaseWriteViews,
	formCaseWriteViews,
	proseText,
	type Uuid,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";

const FORM = testUuid("views-form");
const NAME = testUuid("views-name");
const PHONE = testUuid("views-phone");
const PHOTO = testUuid("views-photo");
const VISITS = testUuid("views-visits");
const OWN = testUuid("views-own");
const CHILD = testUuid("views-child");
const OTHER = testUuid("views-other");
const WORKER = testUuid("views-worker");

const read = (
	uuid: Uuid,
	extra: Partial<
		Omit<
			Extract<Extract<Expression, { kind: "term" }>["term"], { kind: "field" }>,
			"kind" | "uuid"
		>
	> = {},
): Expression => ({ kind: "term", term: { kind: "field", uuid, ...extra } });
const link = (field: Uuid): Expression => ({
	kind: "term",
	term: { kind: "capture-link", field },
});

/** A patient module (under households, over visits) with one form whose
 * case operations are `operations`. Each operation parses through the
 * stored schema, so every fixture is a shape the document admits. */
function app(
	type: "registration" | "followup",
	operations: readonly CaseOperation[],
): BlueprintDoc {
	const parsed = operations.map((operation) =>
		caseOperationSchema.parse(operation),
	);
	return buildDoc(
		{
			caseTypes: [
				{ name: "household", properties: [] },
				{
					name: "patient",
					parent_type: "household",
					properties: ["phone", "photo_link", "village"].map((name) => ({
						name,
						label: proseText(name),
					})),
				},
				{ name: "visit", parent_type: "patient", properties: [] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: FORM,
							name: "Visit",
							type,
							fields: [
								f({ kind: "text", id: "name", uuid: NAME }),
								f({ kind: "text", id: "phone", uuid: PHONE }),
								f({ kind: "image", id: "photo", uuid: PHOTO }),
								f({
									kind: "repeat",
									id: "visits",
									uuid: VISITS,
									repeat_mode: "user_controlled",
									children: [],
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

/** Both ways a document is read: from its reference index, and without one. */
function bothReads(doc: BlueprintDoc) {
	const indexed: BlueprintDoc = { ...doc };
	ensureReferenceIndex(indexed);
	return [
		{ read: "without an index", doc },
		{ read: "from the index", doc: indexed },
	];
}

describe("which writes are in a field's view", () => {
	it("takes a bare read in each spelling, and a capture link, in the name, owner and write slots", () => {
		const doc = app("followup", [
			{
				uuid: OWN,
				id: "patient",
				action: "own",
				name: read(NAME),
				owner: read(NAME, { spelling: "absolute" }),
				writes: [
					{ property: "phone", value: read(NAME, { spelling: "relative" }) },
					{ property: "village", value: read(NAME, { spelling: "current" }) },
					{ property: "photo_link", value: link(PHOTO) },
				],
			},
		]);
		for (const { read: how, doc: reading } of bothReads(doc)) {
			const views = fieldCaseWriteViews(reading, NAME);
			expect(
				views.map(({ slot, property, link }) => ({ slot, property, link })),
				how,
			).toEqual([
				{ slot: "name", property: "case_name", link: false },
				{ slot: "owner", property: "owner_id", link: false },
				{ slot: "write", property: "phone", link: false },
				{ slot: "write", property: "village", link: false },
			]);
			expect(
				fieldCaseWriteViews(reading, PHOTO).map(({ slot, property, link }) => ({
					slot,
					property,
					link,
				})),
				how,
			).toEqual([{ slot: "write", property: "photo_link", link: true }]);
		}
	});

	it("leaves out a filtered read, a read inside an expression and a query-wrapper read", () => {
		const doc = app("followup", [
			{
				uuid: OWN,
				id: "patient",
				action: "own",
				writes: [
					{
						property: "phone",
						value: read(PHONE, {
							spelling: "relative",
							filters: [
								{ step: { kind: "field", uuid: VISITS }, where: [read(NAME)] },
							],
						}),
					},
					{
						property: "village",
						value: {
							kind: "concat",
							parts: [
								read(PHONE),
								{ kind: "term", term: { kind: "literal", value: "!" } },
							],
						},
					},
					{
						property: "photo_link",
						value: read(PHONE, { role: "query-wrapper", spelling: "relative" }),
					},
				],
			},
		]);
		for (const { read: how, doc: reading } of bothReads(doc))
			expect(fieldCaseWriteViews(reading, PHONE), how).toEqual([]);
	});
});

describe("where a view's write lands", () => {
	it("is the form's own case for the own case's writes, and the case above for a write through `via`", () => {
		const doc = app("followup", [
			{
				uuid: OWN,
				id: "patient",
				action: "own",
				writes: [
					{ property: "phone", value: read(PHONE) },
					{
						property: "phone",
						value: read(PHONE),
						via: [{ identifier: "parent" }],
						onlyIfChanged: true,
					},
				],
			},
		]);
		expect(
			fieldCaseWriteViews(doc, PHONE).map(
				({ caseType, destination, via, onlyIfChanged }) => ({
					caseType,
					destination,
					via,
					onlyIfChanged,
				}),
			),
		).toEqual([
			{
				caseType: "patient",
				destination: "own",
				via: undefined,
				onlyIfChanged: false,
			},
			{
				caseType: "household",
				destination: "ancestor",
				via: [{ identifier: "parent" }],
				onlyIfChanged: true,
			},
		]);
		expect(fieldCaseWriteViews(doc, PHONE).map(fieldCaseWriteViewKey)).toEqual([
			{ operationUuid: OWN, slot: "write", key: { property: "phone" } },
			{
				operationUuid: OWN,
				slot: "write",
				key: { property: "phone", via: [{ identifier: "parent" }] },
			},
		]);
	});

	it("is a child for a create whose one parent link, of either relationship, names the form's own case", () => {
		for (const relationship of ["child", "extension"] as const) {
			const followup = app("followup", [
				{ uuid: OWN, id: "patient", action: "own" },
				{
					uuid: CHILD,
					id: "visit",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: read(NAME),
					links: [
						{
							identifier: "parent",
							targetType: "patient",
							target: { kind: "session" },
							relationship,
						},
					],
				},
			]);
			expect(fieldCaseWriteViews(followup, NAME)).toMatchObject([
				{ caseType: "visit", destination: "child", operationUuid: CHILD },
			]);
			const registration = app("registration", [
				{ uuid: OWN, id: "patient", action: "own", name: read(PHONE) },
				{
					uuid: CHILD,
					id: "visit",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: read(NAME),
					links: [
						{
							identifier: "parent",
							targetType: "patient",
							target: { kind: "op", opUuid: OWN },
							relationship,
						},
					],
				},
			]);
			expect(fieldCaseWriteViews(registration, NAME)).toMatchObject([
				{ destination: "child" },
			]);
		}
	});

	it("is the worker's record for its update, and other for any other case", () => {
		const doc = app("followup", [
			{ uuid: OWN, id: "patient", action: "own" },
			{
				uuid: WORKER,
				id: "worker",
				action: "update",
				caseType: "commcare-user",
				target: { kind: "worker-record" },
				writes: [{ property: "last_phone", value: read(PHONE) }],
			},
			{
				uuid: OTHER,
				id: "loose_visit",
				action: "create",
				caseType: "visit",
				target: { kind: "new" },
				name: read(PHONE),
			},
			{
				uuid: CHILD,
				id: "linked_elsewhere",
				action: "create",
				caseType: "visit",
				target: { kind: "new" },
				name: read(PHONE),
				links: [
					{
						identifier: "parent",
						targetType: "visit",
						target: { kind: "op", opUuid: OTHER },
						relationship: "child",
					},
				],
			},
		]);
		expect(
			fieldCaseWriteViews(doc, PHONE).map(({ operationUuid, destination }) => ({
				operationUuid,
				destination,
			})),
		).toEqual([
			{ operationUuid: WORKER, destination: "worker-record" },
			{ operationUuid: OTHER, destination: "other" },
			{ operationUuid: CHILD, destination: "other" },
		]);
	});
});

describe("the order of a field's views", () => {
	it("follows the operations, then name, owner and writes in array order", () => {
		const doc = app("registration", [
			{
				uuid: OWN,
				id: "patient",
				action: "own",
				writes: [
					{ property: "village", value: read(NAME) },
					{ property: "phone", value: read(NAME) },
				],
				owner: read(NAME),
				name: read(NAME),
			},
			{
				uuid: OTHER,
				id: "visit",
				action: "create",
				caseType: "visit",
				target: { kind: "new" },
				name: read(NAME),
			},
		]);
		for (const { read: how, doc: reading } of bothReads(doc)) {
			expect(
				fieldCaseWriteViews(reading, NAME).map(
					({ operationUuid, slot, property }) =>
						`${operationUuid === OWN ? "own" : "visit"} ${slot} ${property}`,
				),
				how,
			).toEqual([
				"own name case_name",
				"own owner owner_id",
				"own write village",
				"own write phone",
				"visit name case_name",
			]);
			expect([...formCaseWriteViews(reading, FORM).keys()], how).toEqual([
				NAME,
			]);
		}
	});
});
