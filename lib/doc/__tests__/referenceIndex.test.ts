/**
 * Reference index — build, queries, and the per-mutation maintenance
 * behaviors with non-obvious correctness rules:
 *
 *   - identity keying (form-local refs land on the target's uuid with
 *     prefix coverage; `#case/…` keys under the module's CURRENT type;
 *     AST refs key on the relation walk's destination);
 *   - the declarations index (case-property peers + form-scoped id
 *     holders) and the close-condition unique-holder rule;
 *   - resolution-context maintenance: an add that makes a previously
 *     dangling `#form/…` ref resolve, and a module case-type change
 *     re-keying contextual refs — both at-a-distance shifts where the
 *     carrier itself was never touched.
 *
 * The standing incremental ≡ rebuild proof lives in
 * `referenceIndex.fuzz.test.ts`; these are the targeted, readable pins.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { parseXPathForForm } from "@/lib/doc/expressionText";
import { applyMutations } from "@/lib/doc/mutations";
import {
	buildReferenceIndex,
	declarersOf,
	referencingCarrierSlots,
	referencingCarrierUuids,
} from "@/lib/doc/referenceIndex";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	casePropertyTargetKey,
	caseTypeTargetKey,
	entityTargetKey,
	expressionSource,
	type Uuid,
} from "@/lib/domain";
import { eq, literal, prop, subcasePath } from "@/lib/domain/predicate";

function uuidByFieldId(doc: BlueprintDoc, id: string): Uuid {
	const found = Object.values(doc.fields).find((field) => field.id === id);
	if (!found) throw new Error(`no field with id ${id} in fixture`);
	return found.uuid;
}

/** Printed text of an AST-stored relevant slot. */
function printedRelevant(doc: BlueprintDoc, uuid: Uuid): string | undefined {
	const field = doc.fields[uuid];
	return field ? expressionSource(field, "relevant", doc) : undefined;
}

function apply(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

/** A doc rich in every reference surface kind. */
function richDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Clinic",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "age", label: "Age" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [],
					searchInputs: [],
					filter: eq(prop("patient", "age"), literal("1")),
				},
				forms: [
					{
						name: "Register",
						type: "registration",
						closeCondition: { field: "outcome", answer: "done" },
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "patient",
							}),
							f({
								kind: "group",
								id: "grp",
								children: [f({ kind: "text", id: "inner", label: "Inner" })],
							}),
							f({
								kind: "text",
								id: "watcher",
								label: "See #patient/age and #form/grp/inner",
								relevant: "#form/grp/inner != '' and /data/case_name != ''",
							}),
							f({
								kind: "text",
								id: "slash_watcher",
								label: "Slash",
								relevant: "/data/grp/inner != ''",
							}),
							f({
								kind: "text",
								id: "pending",
								// The dangling ref rides PROSE — label refs resolve at
								// extraction, so a later add re-keys the edge through
								// the `local` bucket. The relevant's AST raw leaf
								// extracts nothing by design (unresolved identity
								// stays text forever).
								label: "Pending #form/pending_x",
								relevant: "#form/pending_x = '1'",
							}),
							f({
								kind: "text",
								id: "ctx_ref",
								label: "Ctx",
								relevant: "#case/age > 1",
							}),
							f({ kind: "text", id: "outcome", label: "Outcome" }),
						],
					},
				],
			},
		],
	});
}

describe("buildReferenceIndex — identity-keyed edges", () => {
	it("keys form-local refs on the target uuid, with prefix coverage for container paths", () => {
		const doc = richDoc();
		const grp = uuidByFieldId(doc, "grp");
		const inner = uuidByFieldId(doc, "inner");
		const watcher = uuidByFieldId(doc, "watcher");

		// An AST-stored ref is ONE identity leaf to the field it lands on —
		// `#form/grp/inner` / `/data/grp/inner` edge to `inner` alone, with
		// no container prefix edge: nothing ever rewrites the slot (print
		// re-derives the whole chain), so the container needs no carrier
		// lookup. PROSE refs still resolve per segment prefix — the label's
		// `#form/grp/inner` keeps the `grp` edge the prose rewriter needs.
		const slashWatcher = uuidByFieldId(doc, "slash_watcher");
		expect(referencingCarrierUuids(doc, entityTargetKey(grp))).toEqual([
			watcher,
		]);
		expect(referencingCarrierSlots(doc, entityTargetKey(grp))[watcher]).toEqual(
			{ label: true },
		);
		expect(
			referencingCarrierSlots(doc, entityTargetKey(inner))[watcher],
		).toEqual({ relevant: true, label: true });
		expect(
			referencingCarrierSlots(doc, entityTargetKey(inner))[slashWatcher],
		).toEqual({ relevant: true });

		// `/data/case_name` resolves the same way.
		const caseName = uuidByFieldId(doc, "case_name");
		expect(
			referencingCarrierSlots(doc, entityTargetKey(caseName))[watcher],
		).toEqual({ relevant: true });
	});

	it("keys explicit per-type hashtags as case-type AND case-property edges", () => {
		const doc = richDoc();
		const watcher = uuidByFieldId(doc, "watcher");
		expect(
			referencingCarrierUuids(doc, casePropertyTargetKey("patient", "age")),
		).toContain(watcher);
		expect(
			referencingCarrierUuids(doc, caseTypeTargetKey("patient")),
		).toContain(watcher);
	});

	it("keys #case refs under the module's CURRENT type, with no case-type edge", () => {
		const doc = richDoc();
		const ctxRef = uuidByFieldId(doc, "ctx_ref");
		expect(
			referencingCarrierUuids(doc, casePropertyTargetKey("patient", "age")),
		).toContain(ctxRef);
		// `#case/…` follows the module's type rather than naming one — the
		// retirement planner's distinction.
		expect(
			referencingCarrierSlots(doc, caseTypeTargetKey("patient"))[ctxRef],
		).toBeUndefined();
	});

	it("keys AST PropertyRefs on the relation walk's destination type", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Households",
					caseType: "household",
					caseListConfig: {
						columns: [],
						searchInputs: [],
						filter: eq(
							prop("household", "age", subcasePath("parent", "patient")),
							literal("1"),
						),
					},
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		// Destination (ofCaseType) is patient — the property edge lands there…
		expect(
			referencingCarrierUuids(doc, casePropertyTargetKey("patient", "age")),
		).toEqual([moduleUuid]);
		// …while origin + hint both register as type references.
		expect(
			referencingCarrierUuids(doc, caseTypeTargetKey("household")),
		).toContain(moduleUuid);
		expect(
			referencingCarrierUuids(doc, caseTypeTargetKey("patient")),
		).toContain(moduleUuid);
	});

	it("keys the close condition on the checked field's uuid — cousins can't shake it", () => {
		const doc = richDoc();
		const formUuid = doc.moduleOrder.flatMap((m) => doc.formOrder[m] ?? [])[0];
		const outcome = uuidByFieldId(doc, "outcome");
		expect(referencingCarrierUuids(doc, entityTargetKey(outcome))).toEqual([
			formUuid,
		]);

		// The ref names ONE field by uuid — a cousin minting the same id
		// changes nothing about the edge (the id-stored era dropped it on
		// ambiguity; identity has no ambiguity to drop).
		const grp = uuidByFieldId(doc, "grp");
		const next = apply(doc, [
			{
				kind: "addField",
				parentUuid: grp,
				field: {
					uuid: "11111111-1111-4111-8111-111111111111",
					kind: "text",
					id: "outcome",
					label: "Cousin outcome",
				} as never,
			},
		]);
		expect(referencingCarrierUuids(next, entityTargetKey(outcome))).toEqual([
			formUuid,
		]);
	});
});

describe("index-driven rewrites — slash-path descendants and mid-batch currency", () => {
	it("re-anchors a /data/… descendant ref when its container renames, and again when it moves", () => {
		const doc = richDoc();
		const grp = uuidByFieldId(doc, "grp");
		const slashWatcher = uuidByFieldId(doc, "slash_watcher");

		const renamed = apply(doc, [
			{ kind: "renameField", uuid: grp, newId: "grp2" },
		]);
		expect(printedRelevant(renamed, slashWatcher)).toBe(
			"/data/grp2/inner != ''",
		);
		expect(renamed.refIndex).toEqual(buildReferenceIndex(renamed));

		const formUuid = renamed.moduleOrder.flatMap(
			(m) => renamed.formOrder[m] ?? [],
		)[0];
		const outerUuid = "33333333-3333-4333-8333-333333333333";
		const moved = apply(renamed, [
			{
				kind: "addField",
				parentUuid: formUuid,
				field: {
					uuid: outerUuid,
					kind: "group",
					id: "outer",
					label: "Outer",
				} as never,
			},
			{
				kind: "moveField",
				uuid: grp,
				toParentUuid: outerUuid as never,
				toIndex: 0,
			},
		]);
		expect(printedRelevant(moved, slashWatcher)).toBe(
			"/data/outer/grp2/inner != ''",
		);
		expect(moved.refIndex).toEqual(buildReferenceIndex(moved));
	});

	it("a rename later in the SAME batch rewrites a ref the batch itself just added", () => {
		// Mid-batch currency is what lets reducers be lookup-driven at all:
		// the add's maintenance must land its edges BEFORE the rename's
		// reducer looks carriers up, inside one applyMutations call. The
		// fresh PROSE ref is what the rename rewrites; the AST relevant
		// follows at print with no rewrite.
		const doc = richDoc();
		const caseName = uuidByFieldId(doc, "case_name");
		const formUuid = doc.moduleOrder.flatMap((m) => doc.formOrder[m] ?? [])[0];
		const mintedUuid = "44444444-4444-4444-8444-444444444444";
		const next = apply(doc, [
			{
				kind: "addField",
				parentUuid: formUuid,
				field: {
					uuid: mintedUuid,
					kind: "text",
					id: "fresh_ref",
					label: "Fresh #form/case_name",
					relevant: parseXPathForForm(doc, formUuid, "#form/case_name != ''"),
				} as never,
			},
			{ kind: "renameField", uuid: caseName, newId: "full_name" },
		]);
		expect((next.fields[mintedUuid as never] as { label?: string }).label).toBe(
			"Fresh #form/full_name",
		);
		expect(printedRelevant(next, mintedUuid as never)).toBe(
			"#form/full_name != ''",
		);
		expect(next.refIndex).toEqual(buildReferenceIndex(next));
	});
});

describe("declarations index", () => {
	it("lists case-property declarers and follows renames", () => {
		const doc = richDoc();
		const caseName = uuidByFieldId(doc, "case_name");
		expect(declarersOf(doc, "patient", "case_name")).toEqual([caseName]);

		const renamed = apply(doc, [
			{ kind: "renameField", uuid: caseName, newId: "full_name" },
		]);
		expect(declarersOf(renamed, "patient", "case_name")).toEqual([]);
		expect(declarersOf(renamed, "patient", "full_name")).toEqual([caseName]);
	});
});

describe("incremental maintenance — at-a-distance resolution shifts", () => {
	it("an addField that satisfies a dangling #form ref creates the edge without touching the carrier", () => {
		const doc = richDoc();
		const formUuid = doc.moduleOrder.flatMap((m) => doc.formOrder[m] ?? [])[0];
		const pending = uuidByFieldId(doc, "pending");
		const mintedUuid = "22222222-2222-4222-8222-222222222222";
		const next = apply(doc, [
			{
				kind: "addField",
				parentUuid: formUuid,
				field: {
					uuid: mintedUuid,
					kind: "text",
					id: "pending_x",
					label: "Now exists",
				} as never,
			},
		]);
		expect(
			referencingCarrierSlots(next, entityTargetKey(mintedUuid))[pending],
		).toEqual({ label: true });
		expect(next.refIndex).toEqual(buildReferenceIndex(next));
	});

	it("a module case-type change re-keys #case refs across the module's forms", () => {
		const doc = richDoc();
		const moduleUuid = doc.moduleOrder[0];
		const ctxRef = uuidByFieldId(doc, "ctx_ref");
		const next = apply(doc, [
			{ kind: "updateModule", uuid: moduleUuid, patch: { caseType: "visit" } },
		]);
		expect(
			referencingCarrierUuids(next, casePropertyTargetKey("visit", "age")),
		).toContain(ctxRef);
		expect(
			referencingCarrierSlots(next, casePropertyTargetKey("patient", "age"))[
				ctxRef
			],
		).toBeUndefined();
		expect(next.refIndex).toEqual(buildReferenceIndex(next));
	});

	it("removals drop every trace of the removed subtree", () => {
		const doc = richDoc();
		const moduleUuid = doc.moduleOrder[0];
		const next = apply(doc, [{ kind: "removeModule", uuid: moduleUuid }]);
		expect(next.refIndex).toEqual(buildReferenceIndex(next));
		expect(next.refIndex?.in).toEqual({});
		expect(next.refIndex?.out).toEqual({});
		expect(next.refIndex?.decl).toEqual({});
	});
});
