import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	type ExtractedLookupReference,
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupReferenceExtractorRegistry,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	hiddenSearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	eq,
	literal,
	matchAll,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import type { LookupRevision, LookupTableDefinition } from "@/lib/lookup/types";
import { evaluateCommit } from "../gate";
import { validateLookupReferences } from "../lookupReferences";
import { runValidation } from "../runner";

const tableId = (suffix: string) =>
	`00000000-0000-7000-8000-${suffix.padStart(12, "0")}` as LookupTableId;
const columnId = (suffix: string) =>
	`10000000-0000-7000-8000-${suffix.padStart(12, "0")}` as LookupColumnId;
const revision = (value: string) => value as LookupRevision;

const BASE_OCCURRENCE: ExtractedLookupReference = {
	carrierUuid: testUuid("carrier-1"),
	subpath: ["lookup"],
	tableId: tableId("1"),
	columnId: columnId("1"),
	acceptedColumnTypes: ["text"],
	location: {
		scope: "field",
		moduleUuid: testUuid("module-1"),
		formUuid: testUuid("form-1"),
		fieldUuid: testUuid("carrier-1"),
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
		expect(findings.map((finding) => finding.details?.subpath)).toEqual([
			"/k:lookup",
			"/k:lookup/k:label",
		]);
		expect(findings[0].details).toMatchObject({
			carrierUuid: testUuid("carrier-1"),
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

	it("checks a Search prompt's choice list and Search-screen predicates against the live table", () => {
		// A `select` prompt's value/label columns and its row filter, a
		// sibling's required condition and check, and a hidden value all read
		// the Project's tables. Each is extracted by the production registry,
		// so a column the table no longer holds is one finding per exact
		// occurrence rather than an emit-time surprise.
		const moduleUuid = testUuid("module-search-lookup");
		const selectUuid = testUuid("search-select-lookup");
		const nameUuid = testUuid("search-name-lookup");
		const hiddenUuid = testUuid("search-hidden-lookup");
		const missingColumn = columnId("9");
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "region", label: proseText("Region") },
						{ name: "full_name", label: proseText("Name") },
					],
				},
			],
			modules: [
				{
					uuid: moduleUuid,
					name: "Patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: {
						columns: [],
						searchInputs: [
							simpleSearchInputDef(
								selectUuid,
								"region",
								"Region",
								"select",
								"region",
								{
									options: {
										kind: "lookup",
										tableId: tableId("1"),
										valueColumnId: columnId("1"),
										labelColumnId: columnId("1"),
										filter: eq(
											tableColumn(tableId("1"), missingColumn),
											literal("north"),
										),
									},
								},
							),
							simpleSearchInputDef(
								nameUuid,
								"full_name",
								"Name",
								"text",
								"full_name",
								{
									required: {
										when: eq(
											tableLookup(tableId("1"), missingColumn, matchAll()),
											literal("yes"),
										),
									},
									validation: {
										rule: eq(
											tableLookup(tableId("1"), columnId("1"), matchAll()),
											literal("yes"),
										),
										message: "Not in the list.",
									},
								},
							),
							hiddenSearchInputDef(
								hiddenUuid,
								"site",
								"Site",
								tableLookup(tableId("1"), missingColumn, matchAll()),
							),
						],
					},
				},
			],
		});

		// Findings sort by carrier, so the projection is read by slot.
		const bySlot = (findings: readonly { slot?: unknown }[]) =>
			[...findings].sort((a, b) =>
				String(a.slot).localeCompare(String(b.slot)),
			);
		const findings = bySlot(
			runValidation(doc, availableContext([definition()]))
				.filter((finding) => finding.code.startsWith("LOOKUP_"))
				.map((finding) => ({
					code: finding.code,
					slot: finding.details?.registrySlot,
					carrier: finding.details?.carrierUuid,
					subpath: finding.details?.subpath,
				})),
		);

		expect(findings).toEqual([
			{
				code: "LOOKUP_COLUMN_NOT_AVAILABLE",
				slot: "search_input_hidden_value",
				carrier: hiddenUuid,
				subpath: "/k:resultColumnId",
			},
			{
				code: "LOOKUP_COLUMN_NOT_AVAILABLE",
				slot: "search_input_options",
				carrier: selectUuid,
				subpath: "/k:filter/k:left/k:term/k:columnId",
			},
			{
				code: "LOOKUP_COLUMN_NOT_AVAILABLE",
				slot: "search_input_required_when",
				carrier: nameUuid,
				subpath: "/k:left/k:resultColumnId",
			},
		]);
		// Under an unavailable context every exact occurrence is named, the
		// well-formed check included.
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)
				.filter((finding) => finding.code === "LOOKUP_CONTEXT_UNAVAILABLE")
				.map((finding) => finding.details?.registrySlot)
				.sort(),
		).toEqual([
			"search_input_hidden_value",
			"search_input_options",
			"search_input_options",
			"search_input_options",
			"search_input_required_when",
			"search_input_validation_rule",
		]);
	});

	it("threads an explicit synthetic registry through the full runner", () => {
		const findings = runValidation(buildDoc(), LOOKUP_CONTEXT_UNAVAILABLE, {
			lookupReferenceExtractors: STATIC_REGISTRY,
		}).filter((finding) => finding.code.startsWith("LOOKUP_"));
		expect(findings).toHaveLength(1);
		expect(findings[0].code).toBe("LOOKUP_CONTEXT_UNAVAILABLE");
	});
});

describe("lookup-aware absolute commit gate", () => {
	const conditionalRegistry = registry((doc) =>
		doc.appName.startsWith("Lookup") ? [BASE_OCCURRENCE] : [],
	);

	function operationCarrierDoc(): BlueprintDoc {
		const formUuid = testUuid("form-operation-member-identity");
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "plain", label: proseText("Plain") },
						{ name: "lookup_value", label: proseText("Lookup value") },
						{ name: "lookup_value_2", label: proseText("Second lookup value") },
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
				uuid: testUuid("operation-member-identity"),
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

	it("rejects unrelated edits while the complete candidate has a lookup finding", () => {
		const prevDoc = buildDoc({ appName: "Lookup app" });
		const nextDoc = { ...prevDoc, appName: "Lookup app renamed" };
		const context = LOOKUP_CONTEXT_UNAVAILABLE;

		const verdict = evaluateCommit({
			nextDoc,
			lookupContext: context,
			lookupReferenceExtractors: conditionalRegistry,
		});
		expect(verdict.ok).toBe(false);
	});

	it("returns every gating finding on the complete candidate", () => {
		const prevDoc = buildDoc({ appName: "Ordinary app" });
		const nextDoc = { ...prevDoc, appName: "Lookup app" };
		const context = LOOKUP_CONTEXT_UNAVAILABLE;

		const verdict = evaluateCommit({
			nextDoc,
			lookupContext: context,
			lookupReferenceExtractors: conditionalRegistry,
		});
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.map((finding) => finding.code)).toEqual([
				"NO_MODULES",
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
				nextDoc,
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			}),
		).toMatchObject({ ok: false });

		const assertCandidateLookup = (
			next: BlueprintDoc,
			expectedSubpath: string,
		) => {
			const verdict = evaluateCommit({
				nextDoc: next,
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			});
			expect(verdict.ok).toBe(false);
			if (verdict.ok) throw new Error("expected a rejected lookup addition");
			expect(
				verdict.findings.some(
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
		assertCandidateLookup(
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
		assertCandidateLookup(
			withLink,
			"/k:identifier/k:lookup_link_2/k:resultColumnId",
		);
	});
});
