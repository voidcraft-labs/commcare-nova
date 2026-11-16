import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { planPlacements } from "@/lib/commcare/placement";
import { runValidation } from "@/lib/commcare/validator/runner";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type Form,
	type PersistableDoc,
	proseText,
	type Uuid,
} from "@/lib/domain";
import { eq, formField, literal, term } from "@/lib/domain/expression";
import {
	severalCaseClosePlaces,
	withSeveralCaseClosePlaces,
} from "../severalCaseClosePlaces";

/** The place a publish recorded for a several-case own close before the
 *  close took its condition group: the selected-case row's operations group
 *  and the close-only block, with nothing between them. */
const PUBLISHED = [
	"nova_selected_cases",
	"item",
	"nova_operations",
	"nova_close_selected_cases",
] as const;

type Operation = NonNullable<Form["caseOperations"]>[number];

/** A close form of a menu whose list selects several patients, closing each
 *  selected case where the worker's outcome is "done". */
function closeForm(options: {
	readonly severalCases: boolean;
	readonly condition: "outcome" | "match-all" | "none";
	readonly held?: readonly [string, ...string[]];
	readonly operation?: Operation;
}): { doc: BlueprintDoc; formUuid: Uuid } {
	const doc = buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					...(options.severalCases && {
						selection: { kind: "multiple" as const, maximum: 15 },
					}),
				},
				forms: [
					{
						name: "Discharge",
						type: "close",
						fields: [f({ kind: "text", id: "outcome" })],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: ["case_name", "reviewed"].map((name) => ({
					name,
					label: proseText(name),
				})),
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const form = doc.forms[formUuid] as Form;
	if (options.condition === "outcome")
		form.closeCondition = eq(
			formField(doc.fieldOrder[formUuid][0]),
			literal("done"),
		);
	if (options.condition === "match-all")
		form.closeCondition = { kind: "match-all" };
	if (options.operation !== undefined)
		form.caseOperations = [...(form.caseOperations ?? []), options.operation];
	if (options.held !== undefined)
		form.ownClosePlacement = {
			kind: "save-to-case",
			path: [...options.held] as [string, ...string[]],
		};
	return { doc, formUuid };
}

function persisted(doc: BlueprintDoc): PersistableDoc {
	return toPersistableDoc(doc);
}

function heldPath(doc: PersistableDoc, formUuid: Uuid) {
	return doc.forms[formUuid]?.ownClosePlacement?.path;
}

/** The repaired document passes the gate the migrate writes through, and
 *  keeps the repaired place as a hold. */
function expectRepaired(
	before: PersistableDoc,
	target: PersistableDoc,
	formUuid: Uuid,
) {
	const prev = hydratePersistedBlueprint(before);
	const next = hydratePersistedBlueprint(target);
	expect(runValidation(next, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	expect(
		mutationCommitVerdict(
			prev,
			diffDocsToMutations(prev, next),
			LOOKUP_CONTEXT_UNAVAILABLE,
		).ok,
	).toBe(true);
	const ownClose = planPlacements(next, formUuid).placements.get("own-close");
	expect(ownClose?.held).toBe(true);
	expect(() => expandDoc(next)).not.toThrow();
}

describe("the several-case own close repair", () => {
	it("writes a published close at its shape, its condition group named by the planner", () => {
		const { doc, formUuid } = closeForm({
			severalCases: true,
			condition: "outcome",
			held: PUBLISHED,
		});
		const before = persisted(doc);
		// The plan no longer keeps the place as published, so the gate refuses it.
		expect(
			runValidation(
				hydratePersistedBlueprint(before),
				LOOKUP_CONTEXT_UNAVAILABLE,
			).map((finding) => finding.code),
		).toContain("HELD_PLACEMENT_INEXPRESSIBLE");

		const { target, places } = withSeveralCaseClosePlaces(before);
		expect(places).toEqual([
			{
				formUuid,
				held: [...PUBLISHED],
				migrated: [
					"nova_selected_cases",
					"item",
					"nova_operations",
					"nova_condition_close",
					"nova_close_selected_cases",
				],
			},
		]);
		expect(heldPath(target, formUuid)).toEqual(places[0]?.migrated);

		// The repaired place is the one the planner gives the same form unheld.
		const unheld = closeForm({ severalCases: true, condition: "outcome" });
		expect(
			planPlacements(unheld.doc, unheld.formUuid).placements.get("own-close")
				?.placement,
		).toEqual({ kind: "save-to-case", path: places[0]?.migrated });
		expectRepaired(before, target, formUuid);
	});

	it("takes the planner's suffix where a sibling already holds the condition group's name", () => {
		const { doc, formUuid } = closeForm({
			severalCases: true,
			condition: "outcome",
			held: PUBLISHED,
			operation: {
				uuid: testUuid("mark-reviewed"),
				id: "nova_condition_close",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [{ property: "reviewed", value: term(literal("yes")) }],
			},
		});
		const before = persisted(doc);
		const { target, places } = withSeveralCaseClosePlaces(before);
		expect(places.map((place) => place.migrated)).toEqual([
			[
				"nova_selected_cases",
				"item",
				"nova_operations",
				"nova_condition_close_1",
				"nova_close_selected_cases",
			],
		]);
		expectRepaired(before, target, formUuid);
	});

	it("changes nothing on a second run", () => {
		const { doc } = closeForm({
			severalCases: true,
			condition: "outcome",
			held: PUBLISHED,
		});
		const { target } = withSeveralCaseClosePlaces(persisted(doc));
		const again = withSeveralCaseClosePlaces(target);
		expect(again.places).toEqual([]);
		expect(again.target).toBe(target);
	});

	it("leaves a close with no condition, or one that closes every time, where it is held", () => {
		for (const condition of ["none", "match-all"] as const) {
			const { doc } = closeForm({
				severalCases: true,
				condition,
				held: PUBLISHED,
			});
			const before = persisted(doc);
			expect(severalCaseClosePlaces(doc)).toEqual([]);
			expect(withSeveralCaseClosePlaces(before).target).toBe(before);
		}
	});

	it("leaves the own close of a one-case menu where it is held", () => {
		const { doc } = closeForm({
			severalCases: false,
			condition: "outcome",
			held: ["nova_operations", "nova_condition_close", "nova_close"],
		});
		const before = persisted(doc);
		expect(severalCaseClosePlaces(doc)).toEqual([]);
		expect(withSeveralCaseClosePlaces(before).target).toBe(before);
	});
});
