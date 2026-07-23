import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { errorIdentity, evaluateCommit } from "@/lib/commcare/validator/gate";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	canonicalLookupCarrierFingerprint,
	collectDormantLookupCarriers,
} from "@/lib/doc/dormantLookupCarriers";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, LookupOptionsSource, Uuid } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { literal, matchAll, tableLookup, term } from "@/lib/domain/predicate";
import type { LookupRevision } from "@/lib/lookup/types";

const TABLE_A = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const TABLE_B = "018f3e8a-7b2c-7def-8abc-1234567890ac" as LookupTableId;
const VALUE_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;
const LABEL_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ae" as LookupColumnId;
const FILTER_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890af" as LookupColumnId;

const LOOKUP_CONTEXT: LookupValidationContext = {
	kind: "available",
	projectId: "project-1",
	projectRevision: "7" as LookupRevision,
	definitions: [TABLE_A, TABLE_B].map((tableId) => ({
		id: tableId,
		name: tableId === TABLE_A ? "Statuses" : "Replacement statuses",
		tag: tableId === TABLE_A ? "statuses" : "replacement-statuses",
		definitionRevision: "6" as LookupRevision,
		columns: [
			{
				id: VALUE_COLUMN,
				wireName: "value",
				label: "Value",
				dataType: "text" as const,
			},
			{
				id: LABEL_COLUMN,
				wireName: "label",
				label: "Label",
				dataType: "text" as const,
			},
			{
				id: FILTER_COLUMN,
				wireName: "enabled",
				label: "Enabled",
				dataType: "text" as const,
			},
		],
	})),
};

function inlineOptions(variant: "original" | "replacement" = "original") {
	return [
		{
			uuid: (variant === "original"
				? "40000000-0000-4000-8000-000000000000"
				: "60000000-0000-4000-8000-000000000000") as Uuid,
			order: "a0",
			value: "active",
			label: "Active",
		},
		{
			uuid: (variant === "original"
				? "50000000-0000-4000-8000-000000000000"
				: "70000000-0000-4000-8000-000000000000") as Uuid,
			order: "a1",
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
		appName: "Lookup carrier gate",
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

function dormantFindings(verdict: ReturnType<typeof mutationCommitVerdict>) {
	return verdict.ok
		? []
		: verdict.introduced.filter(
				(finding) => finding.code === "LOOKUP_CARRIER_COMMIT_NOT_ACTIVE",
			);
}

describe("dormant lookup carrier commit policy", () => {
	it("allows an unrelated edit beside a historical carrier", () => {
		const doc = selectDoc(source());
		const verdict = mutationCommitVerdict(
			doc,
			[{ kind: "setAppName", name: "Renamed lookup carrier gate" }],
			LOOKUP_CONTEXT,
		);

		expect(verdict.ok).toBe(true);
	});

	it("keeps inline fallback edits outside the historical source fingerprint", () => {
		const doc = selectDoc(source());
		const field = statusField(doc);
		const before = collectDormantLookupCarriers(doc)[0];
		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateField",
					uuid: field.uuid,
					targetKind: "single_select",
					patch: {
						options: inlineOptions("replacement").map((option, index) => ({
							...option,
							value: index === 0 ? "open" : "done",
							label: index === 0 ? "Open" : "Done",
						})),
					},
				} as Mutation,
			],
			LOOKUP_CONTEXT,
		);

		expect(verdict.ok).toBe(true);
		const after = collectDormantLookupCarriers(verdict.nextDoc)[0];
		expect(after.fingerprint).toBe(before.fingerprint);
	});

	it("rejects a nested filter edit even when every lookup id is unchanged", () => {
		const doc = selectDoc(source("yes"));
		const field = statusField(doc);
		const before = collectDormantLookupCarriers(doc)[0];
		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateField",
					uuid: field.uuid,
					targetKind: "single_select",
					patch: {},
					optionsSource: source("no"),
				},
			],
			LOOKUP_CONTEXT,
		);

		const findings = dormantFindings(verdict);
		expect(findings).toHaveLength(1);
		expect(findings[0].details).toMatchObject({
			carrierOwnerUuid: field.uuid,
			carrierSlot: "lookup_options_source",
		});
		expect(findings[0].details?.carrierFingerprint).not.toBe(
			before.fingerprint,
		);
	});

	it("rejects replacing a source", () => {
		const doc = selectDoc(source());
		const field = statusField(doc);
		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateField",
					uuid: field.uuid,
					targetKind: "single_select",
					patch: {},
					optionsSource: source("yes", TABLE_B),
				},
			],
			LOOKUP_CONTEXT,
		);

		expect(dormantFindings(verdict)).toHaveLength(1);
	});

	it("allows clearing a source and removing a carrier-bearing field", () => {
		const doc = selectDoc(source());
		const field = statusField(doc);
		const clear = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateField",
					uuid: field.uuid,
					targetKind: "single_select",
					patch: {},
					optionsSource: null,
				},
			],
			LOOKUP_CONTEXT,
		);
		expect(clear.ok).toBe(true);
		expect(collectDormantLookupCarriers(clear.nextDoc)).toEqual([]);

		const remove = mutationCommitVerdict(
			doc,
			[{ kind: "removeField", uuid: field.uuid }],
			LOOKUP_CONTEXT,
		);
		expect(remove.ok).toBe(true);
		expect(collectDormantLookupCarriers(remove.nextDoc)).toEqual([]);
	});

	it("rejects adding a source to an inline-only select", () => {
		const doc = selectDoc();
		const field = statusField(doc);
		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateField",
					uuid: field.uuid,
					targetKind: "single_select",
					patch: {},
					optionsSource: source(),
				},
			],
			LOOKUP_CONTEXT,
		);

		expect(dormantFindings(verdict)).toHaveLength(1);
	});

	it("rejects adding an AST carrier and allows clearing a historical one", () => {
		const prevDoc = selectDoc();
		const moduleUuid = prevDoc.moduleOrder[0];
		const withCarrier = structuredClone(prevDoc);
		withCarrier.modules[moduleUuid].displayCondition = source("yes").filter;

		const add = evaluateCommit({
			prevDoc,
			nextDoc: withCarrier,
			scope: "full",
			lookupContext: LOOKUP_CONTEXT,
		});
		expect(add.ok).toBe(false);
		if (add.ok) throw new Error("expected carrier addition rejection");
		expect(
			add.introduced.some(
				(finding) => finding.code === "LOOKUP_CARRIER_COMMIT_NOT_ACTIVE",
			),
		).toBe(true);

		const clear = evaluateCommit({
			prevDoc: withCarrier,
			nextDoc: prevDoc,
			scope: "full",
			lookupContext: LOOKUP_CONTEXT,
		});
		expect(clear.ok).toBe(true);
	});

	it("inventories detached historical entities instead of creating a gate bypass", () => {
		const prevDoc = selectDoc(source("yes"));
		const field = statusField(prevDoc);
		for (const children of Object.values(prevDoc.fieldOrder)) {
			const index = children.indexOf(field.uuid);
			if (index !== -1) children.splice(index, 1);
		}
		const nextDoc = structuredClone(prevDoc);
		const detached = statusField(nextDoc);
		detached.optionsSource = source("no");

		expect(collectDormantLookupCarriers(prevDoc)).toHaveLength(1);
		const verdict = evaluateCommit({
			prevDoc,
			nextDoc,
			scope: "full",
			lookupContext: LOOKUP_CONTEXT,
		});
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error("expected detached carrier edit rejection");
		expect(
			verdict.introduced.some(
				(finding) => finding.code === "LOOKUP_CARRIER_COMMIT_NOT_ACTIVE",
			),
		).toBe(true);
	});

	it("does not rename an unchanged operation carrier when a sibling moves", () => {
		const prevDoc = selectDoc();
		const form = Object.values(prevDoc.forms)[0];
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
		const nextDoc = structuredClone(prevDoc);
		const nextWrites = Object.values(nextDoc.forms)[0].caseOperations?.[0]
			.writes;
		if (nextWrites === undefined) throw new Error("expected operation writes");
		nextWrites.reverse();

		const before = collectDormantLookupCarriers(prevDoc).find(
			(carrier) => carrier.slot === "case_operation_write_value",
		);
		const after = collectDormantLookupCarriers(nextDoc).find(
			(carrier) => carrier.slot === "case_operation_write_value",
		);
		expect(after?.subpath).toBe(before?.subpath);
		expect(after?.fingerprint).toBe(before?.fingerprint);

		const verdict = evaluateCommit({
			prevDoc,
			nextDoc,
			scope: "full",
			lookupContext: LOOKUP_CONTEXT,
		});
		expect(verdict.ok).toBe(true);

		const withAdditionalCarrier = structuredClone(prevDoc);
		const additionalWrites = Object.values(withAdditionalCarrier.forms)[0]
			.caseOperations?.[0].writes;
		if (additionalWrites === undefined) {
			throw new Error("expected operation writes");
		}
		additionalWrites.push({
			property: "lookup_value_2",
			value: tableLookup(TABLE_A, VALUE_COLUMN, matchAll()),
		});
		const add = evaluateCommit({
			prevDoc,
			nextDoc: withAdditionalCarrier,
			scope: "full",
			lookupContext: LOOKUP_CONTEXT,
		});
		expect(add.ok).toBe(false);
		if (add.ok) throw new Error("expected added operation carrier rejection");
		expect(
			add.introduced.some(
				(finding) => finding.code === "LOOKUP_CARRIER_COMMIT_NOT_ACTIVE",
			),
		).toBe(true);
	});

	it("fingerprints a lookup-bearing AST slot root, not only its stable leaf ids", () => {
		const prevDoc = selectDoc();
		const moduleUuid = prevDoc.moduleOrder[0];
		prevDoc.modules[moduleUuid].displayCondition = source("yes").filter;
		const nextDoc = structuredClone(prevDoc);
		nextDoc.modules[moduleUuid].displayCondition = source("no").filter;

		const [before] = collectDormantLookupCarriers(prevDoc);
		const [after] = collectDormantLookupCarriers(nextDoc);
		expect(after).toMatchObject({
			ownerUuid: before.ownerUuid,
			slot: before.slot,
		});
		expect(after.fingerprint).not.toBe(before.fingerprint);

		const verdict = evaluateCommit({
			prevDoc,
			nextDoc,
			scope: "full",
			lookupContext: LOOKUP_CONTEXT,
		});
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error("expected carrier edit rejection");
		const finding = verdict.introduced.find(
			(candidate) => candidate.code === "LOOKUP_CARRIER_COMMIT_NOT_ACTIVE",
		);
		expect(finding).toBeDefined();
		expect(errorIdentity(finding as never)).toContain("fingerprint=");
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
});
