/**
 * A form's starting values from records, edited as every editor edits them:
 * one `updateForm` entry change through the production commit gate
 * (`mutationCommitVerdict`), which admits, applies and validates the batch.
 * The plausible failures: an arm of `applyFormEntryChange` that writes the
 * wrong order, a gate rule that stops refusing what it must, a rename that
 * leaves a value reading the old property, a diff that replaces the whole
 * list, and a held slot an editor's patch could set.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import type { FormEntryChange } from "@/lib/doc/formEntryMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { targetedUuid } from "@/proof/targeted/build";
import { independentChoicesBlueprint } from "@/proof/targeted/documents/independentFormChoices";

const uuid = (part: string) =>
	targetedUuid("targeted-independent-form-choices", part);
const VISIT = uuid("visit");
const REVIEW = uuid("review-form");

const change = (form: Uuid, entryChange: FormEntryChange): Mutation => ({
	kind: "updateForm",
	uuid: form,
	patch: {},
	entryChange,
});

function commit(doc: BlueprintDoc, mutations: Mutation[]) {
	return mutationCommitVerdict(doc, mutations, LOOKUP_CONTEXT_UNAVAILABLE);
}

function committed(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	const verdict = commit(doc, mutations);
	if (!verdict.ok)
		throw new Error(
			`The batch should commit: ${verdict.findings.map((one) => one.message).join(" | ")}`,
		);
	return verdict.nextDoc;
}

function refusal(doc: BlueprintDoc, mutations: Mutation[]): string {
	const verdict = commit(doc, mutations);
	if (verdict.ok) throw new Error("The batch should be refused");
	return verdict.findings.map((one) => one.message).join(" | ");
}

const order = (doc: BlueprintDoc, form: Uuid = VISIT) =>
	(doc.forms[form].openingAssignments ?? []).map((row) => row.uuid);

describe("editing a form's starting values from records", () => {
	const doc = independentChoicesBlueprint("assignments", true);

	it("adds, edits, moves and removes a value through the gate", () => {
		const added = testUuid("added-own-value");
		const withAdded = committed(doc, [
			change(VISIT, {
				operation: "add-assignment",
				after: uuid("copy-second-to-shared"),
				value: {
					uuid: added,
					field: uuid("first-name"),
					source: { kind: "own" },
					property: "second_note",
				},
			}),
		]);
		expect(order(withAdded)).toEqual([
			uuid("copy-first"),
			uuid("copy-first-to-shared"),
			uuid("copy-second-to-shared"),
			added,
		]);
		const edited = committed(withAdded, [
			change(VISIT, {
				operation: "edit-assignment",
				uuid: added,
				value: {
					field: uuid("first-name"),
					source: { kind: "own" },
					property: "first_note",
				},
			}),
		]);
		expect(
			edited.forms[VISIT].openingAssignments?.find((row) => row.uuid === added)
				?.property,
		).toBe("first_note");
		const moved = committed(edited, [
			change(VISIT, {
				operation: "move-assignment",
				uuid: added,
				after: uuid("copy-first-to-shared"),
			}),
		]);
		expect(order(moved)).toEqual([
			uuid("copy-first"),
			uuid("copy-first-to-shared"),
			added,
			uuid("copy-second-to-shared"),
		]);
		const removed = committed(moved, [
			change(VISIT, { operation: "remove-assignment", uuid: added }),
		]);
		expect(order(removed)).toEqual(order(doc));
	});

	it("moves a value whose record changes beside that record's others", () => {
		// The first value reads the first person; read from the form's own
		// record instead, it joins that record's values after the others.
		const next = committed(doc, [
			change(VISIT, {
				operation: "edit-assignment",
				uuid: uuid("copy-first"),
				value: {
					field: uuid("first-name"),
					source: { kind: "own" },
					property: "case_name",
				},
			}),
		]);
		expect(order(next)).toEqual([
			uuid("copy-first-to-shared"),
			uuid("copy-second-to-shared"),
			uuid("copy-first"),
		]);
		// And back: it returns before the own record's values.
		const back = committed(next, [
			change(VISIT, {
				operation: "edit-assignment",
				uuid: uuid("copy-first"),
				value: {
					field: uuid("first-name"),
					source: { kind: "selection", selection: uuid("first") },
					property: "case_name",
				},
			}),
		]);
		expect(order(back)).toEqual([
			uuid("copy-first-to-shared"),
			uuid("copy-first"),
			uuid("copy-second-to-shared"),
		]);
	});

	it("refuses each value the form cannot open with", () => {
		const add = (value: object, after?: Uuid | null) =>
			change(VISIT, {
				operation: "add-assignment",
				...(after !== undefined && { after }),
				value: {
					uuid: testUuid("refused-value"),
					...value,
				} as never,
			});
		// The destination is no question of the form.
		expect(
			refusal(doc, [
				add({
					field: uuid("visit"),
					source: { kind: "own" },
					property: "case_name",
				}),
			]),
		).toContain("needs a question in this form");
		// The record is none this form supplies.
		expect(
			refusal(doc, [
				add({
					field: uuid("first-name"),
					source: { kind: "selection", selection: testUuid("no-choice") },
					property: "case_name",
				}),
			]),
		).toContain("needs a record supplied by this form");
		// A value of an earlier record after a later record's.
		expect(
			refusal(doc, [
				add({
					field: uuid("note"),
					source: { kind: "selection", selection: uuid("first") },
					property: "case_name",
				}),
			]),
		).toContain("follow the order of the records");
		// One record filling one question twice.
		expect(
			refusal(doc, [
				add(
					{
						field: uuid("first-name"),
						source: { kind: "selection", selection: uuid("first") },
						property: "first_note",
					},
					uuid("copy-first"),
				),
			]),
		).toContain("one record can fill a question once");
	});

	it("follows a case property rename", () => {
		const reading = committed(doc, [
			change(VISIT, {
				operation: "edit-assignment",
				uuid: uuid("copy-first"),
				value: {
					field: uuid("first-name"),
					source: { kind: "selection", selection: uuid("first") },
					property: "first_note",
				},
			}),
		]);
		const renamed = committed(reading, [
			{
				kind: "renameCaseProperties",
				renames: [
					{ caseType: "person", from: "first_note", to: "opening_note" },
				],
			},
		]);
		expect(
			renamed.forms[VISIT].openingAssignments?.find(
				(row) => row.uuid === uuid("copy-first"),
			)?.property,
		).toBe("opening_note");
	});

	it("clears the held basic slot with the last value it carried", () => {
		const rows = order(doc, REVIEW);
		const cleared = committed(
			doc,
			rows.map((row) =>
				change(REVIEW, { operation: "remove-assignment", uuid: row }),
			),
		);
		expect(cleared.forms[REVIEW].openingAssignments).toBeUndefined();
		expect(cleared.forms[REVIEW].heldBasicOpening).toBeUndefined();
	});
});

describe("starting values between two documents", () => {
	const doc = independentChoicesBlueprint("assignment-diff", true);

	it("diffs them granularly, keeping a concurrent add", () => {
		const edited = produce(doc, (draft) => {
			const rows = draft.forms[VISIT].openingAssignments ?? [];
			// Drop one, change one's record, reorder the rest.
			draft.forms[VISIT].openingAssignments = [
				rows[2],
				{ ...rows[0], source: { kind: "own" } },
			];
		});
		const diff = diffDocsToMutations(doc, edited);
		const forms = diff.filter(
			(m): m is Extract<Mutation, { kind: "updateForm" }> =>
				m.kind === "updateForm" && m.uuid === VISIT,
		);
		expect(forms.some((m) => "openingAssignments" in m.patch)).toBe(false);
		expect(mutationTargetsInvalid(doc, diff)).toBe(false);
		const replayed = produce(doc, (draft) => {
			applyMutations(draft, diff);
		});
		expect(replayed.forms[VISIT].openingAssignments).toEqual(
			edited.forms[VISIT].openingAssignments,
		);
		// Another editor's value added meanwhile survives the replay.
		const concurrent = testUuid("concurrent-value");
		const theirs = produce(doc, (draft) => {
			draft.forms[VISIT].openingAssignments?.push({
				uuid: concurrent,
				field: uuid("note"),
				source: { kind: "own" },
				property: "case_name",
			});
		});
		const merged = produce(theirs, (draft) => {
			applyMutations(draft, diff);
		});
		expect(order(merged)).toContain(concurrent);
	});

	it("carries the held basic slot only as a hold", () => {
		const unheld = produce(doc, (draft) => {
			delete draft.forms[REVIEW].heldBasicOpening;
		});
		const diff = diffDocsToMutations(unheld, doc);
		expect(diff).toContainEqual({
			kind: "holdPlacements",
			holds: [{ target: "basic-opening", formUuid: REVIEW, placement: true }],
		});
		expect(
			mutationSchema.safeParse({
				kind: "updateForm",
				uuid: REVIEW,
				patch: { heldBasicOpening: true },
			}).success,
		).toBe(false);
		expect(
			mutationSchema.safeParse({
				kind: "updateForm",
				uuid: VISIT,
				patch: { openingAssignments: [] },
			}).success,
		).toBe(false);
	});

	it("refuses an assignment uuid another identity holds", () => {
		expect(
			mutationTargetsInvalid(doc, [
				change(VISIT, {
					operation: "add-assignment",
					value: {
						uuid: uuid("first"),
						field: uuid("note"),
						source: { kind: "own" },
						property: "case_name",
					},
				}),
			]),
		).toBe(true);
	});
});
