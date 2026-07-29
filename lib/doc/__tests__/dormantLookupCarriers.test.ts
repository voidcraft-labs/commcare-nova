// Structural inventory of lookup-carrier authoring slots.
//
// `collectDormantLookupCarriers` is what decides whether a document can be
// exported at all: `lib/export/boundaryValidation.ts::lookupCarrierExportFindings`
// turns each carrier it returns into a `LOOKUP_CARRIER_EXPORT_NOT_ACTIVE`
// finding, so a carrier the collector misses becomes an app that exports a
// lookup reference the wire cannot yet carry. The properties pinned here are
// the ones that decide inclusion: which slots count, what a carrier's identity
// is, and that an unreachable entity is still inventoried.

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	canonicalLookupCarrierFingerprint,
	collectDormantLookupCarriers,
} from "@/lib/doc/dormantLookupCarriers";
import type { BlueprintDoc, LookupOptionsSource, Uuid } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { literal, matchAll, tableLookup, term } from "@/lib/domain/predicate";

const TABLE_A = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const VALUE_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;
const LABEL_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ae" as LookupColumnId;
const FILTER_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890af" as LookupColumnId;

function inlineOptions(variant: "original" | "replacement" = "original") {
	return [
		{
			uuid: (variant === "original"
				? "40000000-0000-4000-8000-000000000000"
				: "60000000-0000-4000-8000-000000000000") as Uuid,
			value: "active",
			label: "Active",
		},
		{
			uuid: (variant === "original"
				? "50000000-0000-4000-8000-000000000000"
				: "70000000-0000-4000-8000-000000000000") as Uuid,
			value: "closed",
			label: "Closed",
		},
	];
}

function source(
	filterValue = "yes",
	tableId: LookupTableId = TABLE_A,
): LookupOptionsSource {
	return {
		kind: "lookup-table",
		tableId,
		valueColumnId: VALUE_COLUMN,
		labelColumnId: LABEL_COLUMN,
		filter: {
			kind: "eq",
			left: {
				kind: "term",
				term: {
					kind: "table-column",
					tableId,
					columnId: FILTER_COLUMN,
				},
			},
			right: {
				kind: "term",
				term: { kind: "literal", value: filterValue },
			},
		},
	};
}

function selectDoc(optionsSource?: LookupOptionsSource): BlueprintDoc {
	return buildDoc({
		appName: "Lookup carrier inventory",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "single_select",
								id: "status",
								label: "Status",
								options: inlineOptions(),
								...(optionsSource !== undefined && { optionsSource }),
							}),
							f({ kind: "text", id: "notes", label: "Notes" }),
						],
					},
				],
			},
		],
	});
}

function statusField(doc: BlueprintDoc) {
	const field = Object.values(doc.fields).find(
		(candidate) => candidate.id === "status",
	);
	if (field?.kind !== "single_select") {
		throw new Error("fixture status select is missing");
	}
	return field;
}

describe("dormant lookup carrier inventory", () => {
	it("finds nothing in a document whose selects are inline-only", () => {
		expect(collectDormantLookupCarriers(selectDoc())).toEqual([]);
	});

	it("reports a select's lookup source with the location an export finding needs", () => {
		const doc = selectDoc(source());
		const field = statusField(doc);
		const carriers = collectDormantLookupCarriers(doc);

		expect(carriers).toHaveLength(1);
		expect(carriers[0]).toMatchObject({
			ownerUuid: field.uuid,
			ownerKind: "field",
			slot: "lookup_options_source",
			location: { scope: "field", fieldUuid: field.uuid, fieldId: "status" },
		});
	});

	it("keeps inline fallback options outside the carrier fingerprint", () => {
		// Inline options are the origin-compatible fallback, so editing only the
		// fallback beside a lookup source must not read as touching the carrier.
		const before = collectDormantLookupCarriers(selectDoc(source()))[0];
		const doc = selectDoc(source());
		statusField(doc).options = inlineOptions("replacement");
		const after = collectDormantLookupCarriers(doc)[0];

		expect(after.fingerprint).toBe(before.fingerprint);
	});

	it("fingerprints a lookup-bearing AST slot root, not only its stable leaf ids", () => {
		// Both documents name the same table and column; only a peer literal in
		// the filter differs. That still changes what the lookup evaluates to, so
		// the two carriers must not share an identity.
		const prevDoc = selectDoc();
		const moduleUuid = prevDoc.moduleOrder[0];
		prevDoc.modules[moduleUuid].displayCondition = source("yes").filter;
		const nextDoc = structuredClone(prevDoc);
		nextDoc.modules[moduleUuid].displayCondition = source("no").filter;

		const [before] = collectDormantLookupCarriers(prevDoc);
		const [after] = collectDormantLookupCarriers(nextDoc);
		expect(after).toMatchObject({
			ownerUuid: before.ownerUuid,
			ownerKind: "module",
			slot: before.slot,
		});
		expect(after.fingerprint).not.toBe(before.fingerprint);
	});

	it("gives an unchanged operation carrier a stable identity when a sibling moves", () => {
		// Write order is presentation, not identity: reordering the peer writes
		// must not make an untouched lookup write look like a different carrier.
		const doc = selectDoc();
		const form = Object.values(doc.forms)[0];
		form.caseOperations = [
			{
				uuid: "80000000-0000-4000-8000-000000000000" as Uuid,
				id: "update_status",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [
					{ property: "plain", value: term(literal("plain")) },
					{
						property: "lookup_value",
						value: tableLookup(TABLE_A, VALUE_COLUMN, matchAll()),
					},
				],
			},
		];
		const reordered = structuredClone(doc);
		const nextWrites = Object.values(reordered.forms)[0].caseOperations?.[0]
			.writes;
		if (nextWrites === undefined) throw new Error("expected operation writes");
		nextWrites.reverse();

		const before = collectDormantLookupCarriers(doc).find(
			(carrier) => carrier.slot === "case_operation_write_value",
		);
		const after = collectDormantLookupCarriers(reordered).find(
			(carrier) => carrier.slot === "case_operation_write_value",
		);
		expect(before).toBeDefined();
		expect(after?.subpath).toBe(before?.subpath);
		expect(after?.fingerprint).toBe(before?.fingerprint);
	});

	it("inventories a detached entity, so an unreachable carrier still blocks export", () => {
		// The field is removed from its parent's child order but its row survives.
		// Walking only the reachable tree would let that carrier export silently.
		const doc = selectDoc(source());
		const field = statusField(doc);
		for (const children of Object.values(doc.fieldOrder)) {
			const index = children.indexOf(field.uuid);
			if (index !== -1) children.splice(index, 1);
		}

		expect(collectDormantLookupCarriers(doc)).toHaveLength(1);
	});
});

describe("canonical lookup carrier fingerprint", () => {
	it("is stable across object key order while retaining nested semantics", () => {
		expect(
			canonicalLookupCarrierFingerprint({
				z: [{ b: 2, a: 1 }],
				a: "value",
			}),
		).toBe(
			canonicalLookupCarrierFingerprint({
				a: "value",
				z: [{ a: 1, b: 2 }],
			}),
		);
		expect(
			canonicalLookupCarrierFingerprint({ filter: { value: "yes" } }),
		).not.toBe(canonicalLookupCarrierFingerprint({ filter: { value: "no" } }));
	});

	it("distinguishes an omitted object member from a present array hole", () => {
		// An absent object key and a present-but-undefined one are the same
		// authored state; an array hole is a position and must survive as one.
		expect(canonicalLookupCarrierFingerprint({ a: 1, b: undefined })).toBe(
			canonicalLookupCarrierFingerprint({ a: 1 }),
		);
		expect(canonicalLookupCarrierFingerprint([1, undefined, 2])).not.toBe(
			canonicalLookupCarrierFingerprint([1, 2]),
		);
	});

	it("never collides a string with the scalar that shares its spelling", () => {
		expect(canonicalLookupCarrierFingerprint("1")).not.toBe(
			canonicalLookupCarrierFingerprint(1),
		);
		expect(canonicalLookupCarrierFingerprint("null")).not.toBe(
			canonicalLookupCarrierFingerprint(null),
		);
		expect(canonicalLookupCarrierFingerprint("true")).not.toBe(
			canonicalLookupCarrierFingerprint(true),
		);
	});
});
