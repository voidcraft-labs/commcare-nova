import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	advancedFixture,
	HOUSEHOLDS,
	OP,
	read,
} from "@/lib/commcare/__tests__/advancedPlacementFixture";
import { placementsToHold } from "@/lib/commcare/placementHolds";
import { runValidation } from "@/lib/commcare/validator/runner";
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import { formCaseSelections } from "@/lib/domain/advancedEntryDatums";
import { literal, term } from "@/lib/domain/expression/builders";
import type { FormCaseSelection } from "@/lib/domain/formEntryCases";
import { diffDocsToMutations } from "../diffDocsToMutations";
import type { FormEntryChange } from "../formEntryMutations";
import { withIdentityMoves } from "../identityMoves";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../lookupReferences";
import { applyMutations } from "../mutations";
import { mutationTargetsInvalid } from "../mutationTargetAdmission";
import type { Mutation } from "../types";

const choice = (tag: string): FormCaseSelection => ({
	uuid: testUuid(tag),
	tag,
	name: tag,
	caseType: "household",
	source: { kind: "choose", module: HOUSEHOLDS },
});
const supply = (form: Uuid, entryChange: FormEntryChange): Mutation => ({
	kind: "updateForm",
	uuid: form,
	patch: {},
	entryChange,
});
const apply = (doc: BlueprintDoc, changes: Mutation[]) =>
	produce(doc, (draft) => {
		applyMutations(draft, changes);
	});

describe("editing a form's incoming records and values", () => {
	it("reviews changing or dropping a published no-write choice and preserves its neighbor and ordinary labels", () => {
		const { doc, formUuid } = advancedFixture({
			formType: "followup",
			operations: () => [],
		});
		const extra = choice("referrer");
		const { uuid } = extra;
		const edited = apply(doc, [
			supply(formUuid, { operation: "add-choice", value: extra }),
		]);
		const published = apply(edited, [
			{ kind: "holdPlacements", holds: [...placementsToHold(edited)] },
		]);
		expect(published.forms[formUuid].heldSelectionTags?.[uuid]).toBe(
			"referrer",
		);
		const named = supply(formUuid, {
			operation: "edit-choice",
			uuid,
			patch: { name: "Referring household" },
		});
		expect(withIdentityMoves(published, [named]).moves).toEqual([]);
		const change = supply(formUuid, {
			operation: "edit-choice",
			uuid,
			patch: { tag: "source" },
		});
		const previous = published;
		for (const [mutation, tag] of [
			[change, "source"],
			[supply(formUuid, { operation: "use-menu-choices" }), undefined],
			[supply(formUuid, { operation: "remove-choice", uuid }), undefined],
		] as const) {
			const unreviewed = apply(previous, [mutation]);
			expect(
				runValidation(unreviewed, LOOKUP_CONTEXT_UNAVAILABLE).some(
					(error) => error.code === "HELD_PLACEMENT_INEXPRESSIBLE",
				),
			).toBe(true);
			const plan = withIdentityMoves(previous, [mutation]);
			expect(plan.moves).toHaveLength(1);
			expect(plan.moves[0].subject).toEqual({
				kind: "form-selection",
				formUuid,
				selectionUuid: uuid,
			});
			const after = apply(previous, [...plan.batch]);
			expect(after.forms[formUuid].heldSelectionTags?.[uuid]).toBe(tag);
			expect(
				runValidation(after, LOOKUP_CONTEXT_UNAVAILABLE).filter(
					(error) => error.code === "HELD_PLACEMENT_INEXPRESSIBLE",
				),
			).toEqual([]);
			expect(
				apply(after, diffDocsToMutations(after, previous)).forms[formUuid],
			).toEqual(previous.forms[formUuid]);
		}
	});

	it("keeps an implied menu choice's identity, checks stale anchors and edits each row without disturbing its neighbor", () => {
		const { doc, formUuid } = advancedFixture({
			formType: "followup",
			operations: () => [],
		});
		const [original] = formCaseSelections(doc, formUuid);
		const extra = choice("additional");
		const add = supply(formUuid, {
			operation: "add-choice",
			value: extra,
			after: original.uuid,
		});
		const rename = supply(formUuid, {
			operation: "edit-choice",
			uuid: original.uuid,
			patch: { name: "First visit" },
		});
		const reorder = supply(formUuid, {
			operation: "move-choice",
			uuid: extra.uuid,
			after: null,
		});
		expect(mutationTargetsInvalid(doc, [add, rename, reorder])).toBe(false);
		const edited = apply(doc, [add, rename, reorder]);
		expect(edited.forms[formUuid].caseSelections).toEqual([
			extra,
			{ ...original, name: "First visit" },
		]);
		expect(
			mutationTargetsInvalid(edited, [
				supply(formUuid, {
					operation: "move-choice",
					uuid: extra.uuid,
					after: testUuid("retired"),
				}),
			]),
		).toBe(true);
		expect(
			mutationTargetsInvalid(edited, [
				supply(formUuid, {
					operation: "add-value",
					value: {
						uuid: extra.uuid,
						key: "duplicate",
						value: term(literal("hi")),
					},
				}),
			]),
		).toBe(true);
		expect(apply(edited, [add]).forms[formUuid].caseSelections).toEqual(
			edited.forms[formUuid].caseSelections,
		);
	});

	it("round trips a simultaneous arrival, reorder and changed source through the same granular history used for adoption and undo", () => {
		const { doc, formUuid } = advancedFixture({ formType: "followup" });
		const a = choice("first"),
			b = choice("second"),
			c = choice("third"),
			d = choice("fourth");
		const withRows = (rows: FormCaseSelection[]) => ({
			...doc,
			forms: {
				...doc.forms,
				[formUuid]: {
					...doc.forms[formUuid],
					caseSelections: rows,
					computedDatums: rows.map((row) => ({
						uuid: testUuid(`formula-${row.tag}`),
						key: `value_${row.tag}`,
						value: term(literal(row.name)),
					})),
				},
			},
		});
		const before = withRows([a, b, c]),
			after = withRows([c, d, { ...b, name: "Updated" }, a]);
		for (const [from, to] of [
			[before, after],
			[after, before],
		] as const) {
			const diff = diffDocsToMutations(from, to);
			expect(diff.length).toBeGreaterThan(0);
			expect(
				diff.every(
					(m) => m.kind === "updateForm" && m.entryChange !== undefined,
				),
			).toBe(true);
			expect(mutationTargetsInvalid(from, diff)).toBe(false);
			expect(apply(from, diff).forms[formUuid]).toEqual(to.forms[formUuid]);
		}
	});

	// The choices a form derives follow its case changes: a change to the
	// worker's record adds the worker's load. A diff that both drops that
	// change and has the form keep its own choices must take the derived
	// list before the change goes, or it names a choice no longer there
	// (and, the other way, keeps one the target lacks).
	it("takes a form's derived choices before the same diff changes the case changes they follow", () => {
		const own = { uuid: OP("own"), id: "household", action: "own" };
		const worker = {
			uuid: OP("worker"),
			id: "worker",
			action: "update",
			caseType: "commcare-user",
			target: { kind: "worker-record" },
			writes: [{ property: "last", value: read("name") }],
		};
		const withWorker = advancedFixture({
			formType: "followup",
			operations: () => [own, worker] as CaseOperation[],
		});
		const { formUuid } = withWorker;
		const ownOnly = advancedFixture({
			formType: "followup",
			operations: () => [own] as CaseOperation[],
		}).doc;
		const derived = formCaseSelections(withWorker.doc, formUuid);
		expect(derived.map((row) => row.caseType)).toEqual([
			"household",
			"commcare-user",
		]);
		const explicit = (doc: BlueprintDoc): BlueprintDoc => ({
			...doc,
			forms: {
				...doc.forms,
				[formUuid]: {
					...doc.forms[formUuid],
					caseSelections: [derived[0], choice("second")],
				},
			},
		});
		for (const [from, to] of [
			[withWorker.doc, explicit(ownOnly)],
			[ownOnly, explicit(withWorker.doc)],
		] as const) {
			const diff = diffDocsToMutations(from, to);
			expect(mutationTargetsInvalid(from, diff)).toBe(false);
			expect(apply(from, diff).forms[formUuid]).toEqual(to.forms[formUuid]);
		}
	});
});
