import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	type ExtractedLookupReference,
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupReferenceExtractorRegistry,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { literal, matchAll, tableLookup, term } from "@/lib/domain/predicate";
import type { LookupRevision, LookupTableDefinition } from "@/lib/lookup/types";
import { errorIdentity, evaluateCommit } from "../gate";
import { validateLookupReferences } from "../lookupReferences";
import { runValidation } from "../runner";

const tableId = (suffix: string) =>
	`00000000-0000-7000-8000-${suffix.padStart(12, "0")}` as LookupTableId;
const columnId = (suffix: string) =>
	`10000000-0000-7000-8000-${suffix.padStart(12, "0")}` as LookupColumnId;
const revision = (value: string) => value as LookupRevision;

const BASE_OCCURRENCE: ExtractedLookupReference = {
	carrierUuid: asUuid("carrier-1"),
	subpath: ["lookup"],
	tableId: tableId("1"),
	columnId: columnId("1"),
	acceptedColumnTypes: ["text"],
	location: {
		scope: "field",
		moduleUuid: asUuid("module-1"),
		formUuid: asUuid("form-1"),
		fieldUuid: asUuid("carrier-1"),
		field: "future.lookup",
	},
};

function registry(
	extract: (doc: BlueprintDoc) => readonly ExtractedLookupReference[],
): LookupReferenceExtractorRegistry {
	return Object.freeze([
		Object.freeze({ registrySlot: "future.lookup", extract }),
	]);
}

const STATIC_REGISTRY = registry(() => [BASE_OCCURRENCE]);

function availableContext(
	definitions: readonly LookupTableDefinition[],
	projectId = "project-a",
): LookupValidationContext {
	return {
		kind: "available",
		projectId,
		projectRevision: revision("7"),
		definitions,
	};
}

function definition(
	dataType: LookupTableDefinition["columns"][number]["dataType"] = "text",
): LookupTableDefinition {
	return {
		id: tableId("1"),
		name: "People",
		tag: "people",
		definitionRevision: revision("6"),
		columns: [
			{
				id: columnId("1"),
				wireName: "name",
				label: "Name",
				dataType,
			},
		],
	};
}

function lookupFindings(
	doc: BlueprintDoc,
	context: LookupValidationContext,
	lookupRegistry = STATIC_REGISTRY,
) {
	return validateLookupReferences(doc, context, lookupRegistry);
}

describe("lookup reference validation", () => {
	it("keeps ordinary documents clean under unavailable context with the empty production registry", () => {
		const doc = buildDoc({ appName: "Existing app" });
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((finding) =>
				finding.code.startsWith("LOOKUP_"),
			),
		).toEqual([]);
	});

	it("emits one unavailable finding per exact occurrence", () => {
		const doc = buildDoc();
		const twoOccurrences = registry(() => [
			BASE_OCCURRENCE,
			{ ...BASE_OCCURRENCE, subpath: ["lookup", "label"] },
		]);
		const findings = lookupFindings(
			doc,
			LOOKUP_CONTEXT_UNAVAILABLE,
			twoOccurrences,
		);

		expect(findings.map((finding) => finding.code)).toEqual([
			"LOOKUP_CONTEXT_UNAVAILABLE",
			"LOOKUP_CONTEXT_UNAVAILABLE",
		]);
		expect(findings.map(errorIdentity)).toHaveLength(2);
		expect(new Set(findings.map(errorIdentity)).size).toBe(2);
		expect(findings[0].details).toMatchObject({
			carrierUuid: "carrier-1",
			registrySlot: "future.lookup",
			tableId: tableId("1"),
			columnId: columnId("1"),
		});
	});

	it("makes missing and foreign definitions indistinguishable", () => {
		const doc = buildDoc();
		const missing = lookupFindings(doc, availableContext([], "project-a"));
		const foreign = lookupFindings(doc, availableContext([], "project-b"));

		expect(missing).toEqual(foreign);
		expect(missing.map((finding) => finding.code)).toEqual([
			"LOOKUP_TABLE_NOT_AVAILABLE",
		]);
	});

	it("distinguishes a missing column from a missing table", () => {
		const doc = buildDoc();
		const missingColumnRegistry = registry(() => [
			{ ...BASE_OCCURRENCE, columnId: columnId("2") },
		]);
		const findings = lookupFindings(
			doc,
			availableContext([definition()]),
			missingColumnRegistry,
		);

		expect(findings.map((finding) => finding.code)).toEqual([
			"LOOKUP_COLUMN_NOT_AVAILABLE",
		]);
	});

	it("enforces the extractor-owned accepted column type set", () => {
		const doc = buildDoc();
		expect(lookupFindings(doc, availableContext([definition("text")]))).toEqual(
			[],
		);

		const findings = lookupFindings(
			doc,
			availableContext([definition("decimal")]),
		);
		expect(findings.map((finding) => finding.code)).toEqual([
			"LOOKUP_COLUMN_TYPE_MISMATCH",
		]);
		expect(findings[0].details).toMatchObject({
			acceptedColumnTypes: "text",
			actualColumnType: "decimal",
		});
	});

	it("threads an explicit synthetic registry through the full runner", () => {
		const findings = runValidation(buildDoc(), LOOKUP_CONTEXT_UNAVAILABLE, {
			lookupReferenceExtractors: STATIC_REGISTRY,
		}).filter((finding) => finding.code.startsWith("LOOKUP_"));
		expect(findings).toHaveLength(1);
		expect(findings[0].code).toBe("LOOKUP_CONTEXT_UNAVAILABLE");
	});
});

describe("lookup-aware commit delta", () => {
	const conditionalRegistry = registry((doc) =>
		doc.appName.startsWith("Lookup") ? [BASE_OCCURRENCE] : [],
	);

	function operationCarrierDoc(): BlueprintDoc {
		const formUuid = asUuid("form-operation-member-identity");
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "plain", label: "Plain" },
						{ name: "lookup_value", label: "Lookup value" },
						{ name: "lookup_value_2", label: "Second lookup value" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: formUuid,
							name: "Update",
							type: "survey",
						},
					],
				},
			],
		});
		doc.forms[formUuid].caseOperations = [
			{
				uuid: asUuid("operation-member-identity"),
				id: "update_patient",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [
					{ property: "plain", value: term(literal("plain")) },
					{
						property: "lookup_value",
						value: tableLookup(tableId("10"), columnId("101"), matchAll()),
					},
				],
				links: [
					{
						identifier: "plain_link",
						targetType: "patient",
						target: null,
						relationship: "child",
					},
					{
						identifier: "lookup_link",
						targetType: "patient",
						target: {
							kind: "expression",
							expr: tableLookup(tableId("20"), columnId("201"), matchAll()),
						},
						relationship: "child",
					},
				],
			},
		];
		return doc;
	}

	it("allows unrelated edits beside one existing lookup finding", () => {
		const prevDoc = buildDoc({ appName: "Lookup app" });
		const nextDoc = { ...prevDoc, appName: "Lookup app renamed" };
		const context = LOOKUP_CONTEXT_UNAVAILABLE;

		const verdict = evaluateCommit({
			prevDoc,
			nextDoc,
			scope: "full",
			lookupContext: context,
			lookupReferenceExtractors: conditionalRegistry,
		});
		expect(verdict).toEqual({ ok: true });
	});

	it("rejects a newly introduced occurrence under the same exact context", () => {
		const prevDoc = buildDoc({ appName: "Ordinary app" });
		const nextDoc = { ...prevDoc, appName: "Lookup app" };
		const context = LOOKUP_CONTEXT_UNAVAILABLE;

		const verdict = evaluateCommit({
			prevDoc,
			nextDoc,
			scope: "full",
			lookupContext: context,
			lookupReferenceExtractors: conditionalRegistry,
		});
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.introduced.map((finding) => finding.code)).toEqual([
				"LOOKUP_CONTEXT_UNAVAILABLE",
			]);
		}
	});

	it("anchors operation-member lookup identities to property and identifier, not sibling position", () => {
		const prevDoc = operationCarrierDoc();
		const nextDoc = structuredClone(prevDoc);
		const reordered = Object.values(nextDoc.forms)[0].caseOperations?.[0];
		if (reordered?.writes === undefined || reordered.links === undefined) {
			throw new Error("expected operation members");
		}
		reordered.writes.reverse();
		reordered.links.reverse();

		expect(
			evaluateCommit({
				prevDoc,
				nextDoc,
				scope: "full",
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			}),
		).toEqual({ ok: true });

		const assertIntroducedLookup = (
			next: BlueprintDoc,
			expectedSubpath: string,
		) => {
			const verdict = evaluateCommit({
				prevDoc,
				nextDoc: next,
				scope: "full",
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			});
			expect(verdict.ok).toBe(false);
			if (verdict.ok) throw new Error("expected a rejected lookup addition");
			expect(
				verdict.introduced.some(
					(finding) =>
						finding.code === "LOOKUP_CONTEXT_UNAVAILABLE" &&
						finding.details?.subpath === expectedSubpath,
				),
			).toBe(true);
		};

		const withWrite = structuredClone(prevDoc);
		withWrite.forms[
			Object.keys(withWrite.forms)[0]
		].caseOperations?.[0].writes?.push({
			property: "lookup_value_2",
			value: tableLookup(tableId("30"), columnId("301"), matchAll()),
		});
		assertIntroducedLookup(
			withWrite,
			"/k:property/k:lookup_value_2/k:resultColumnId",
		);

		const withLink = structuredClone(prevDoc);
		withLink.forms[
			Object.keys(withLink.forms)[0]
		].caseOperations?.[0].links?.push({
			identifier: "lookup_link_2",
			targetType: "patient",
			target: {
				kind: "expression",
				expr: tableLookup(tableId("40"), columnId("401"), matchAll()),
			},
			relationship: "child",
		});
		assertIntroducedLookup(
			withLink,
			"/k:identifier/k:lookup_link_2/k:resultColumnId",
		);
	});
});
