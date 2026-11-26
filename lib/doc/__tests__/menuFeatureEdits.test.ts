/**
 * The menus group's references held through concurrent edits, undo and redo,
 * and a rename, at the commit gate every editor shares
 * (`commitVerdicts.ts::mutationCommitVerdict`) and the store's history.
 *
 * Contract: a case-list action naming the case another case change creates
 * (`target: { kind: "created-case", operationUuid }`) never stands over a
 * removed change: of two edits planned on one document, offering that action
 * and removing the change, the one committed second is refused, and the
 * document passes the whole validator.
 * Undo and redo restore the slot exactly. Renaming the change's id keeps the
 * reference, which is an identity. The same holds of a form's deep link
 * badge, whose two edits land whole in order and whose worker property read
 * is an identity: its removal is refused, its rename reaches the upload.
 * Plausible failure: a removal that leaves the action, or the
 * argument, naming nothing (the export then writes a frame for no datum),
 * history that restores another slot than the one edited, a rename that
 * re-keys the reference.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	declareWorkerProperties,
	f,
	workerPropertyUuid,
} from "@/lib/__tests__/docHelpers";
import {
	caseListActionRolesFixture,
	actionRoleIds as id,
} from "@/lib/commcare/__tests__/caseListActionRolesFixture";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { planFormEntryCaseCreations } from "@/lib/doc/entryPointMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { removeUserPropertyPlan } from "@/lib/doc/userMutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Module } from "@/lib/domain";
import { sessionUserProperty, term } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";

type Verdict = ReturnType<typeof mutationCommitVerdict>;

function verdict(doc: BlueprintDoc, mutations: Mutation[]): Verdict {
	return mutationCommitVerdict(doc, mutations, LOOKUP_CONTEXT_UNAVAILABLE);
}

/** The store holding `doc`, tracking history from here. */
function storeOf(doc: BlueprintDoc) {
	const store = createBlueprintDocStore();
	store.getState().load(toPersistableDoc(doc));
	store.getState().startTracking();
	return store;
}

/** The store's document as the gate reads it. */
function current(store: ReturnType<typeof storeOf>): BlueprintDoc {
	return store.getState() as unknown as BlueprintDoc;
}

/** Commit `mutations` to the store through the gate, or return the refusal. */
function commit(store: ReturnType<typeof storeOf>, mutations: Mutation[]) {
	const found = verdict(current(store), mutations);
	if (found.ok) store.getState().applyMany(found.mutations);
	return found;
}

const created = {
	kind: "always",
	formUuid: id.register,
	target: { kind: "created-case", operationUuid: id.newPerson },
	label: "Add a household and member",
	afterSubmit: "new-case",
} as const;

/** The fixture with New members offering no action yet. */
function withoutAction(): BlueprintDoc {
	const doc = caseListActionRolesFixture();
	delete doc.modules[id.registerList].caseListRegistrationForm;
	return doc;
}

const offerCreated: Mutation = {
	kind: "updateModule",
	uuid: id.registerList,
	patch: { caseListRegistrationForm: created },
} as Mutation;

const removePerson: Mutation = {
	kind: "updateForm",
	uuid: id.register,
	patch: {},
	caseOperationChange: { operation: "remove", uuid: id.newPerson },
} as Mutation;

describe("a list action naming a case another change creates", () => {
	it("is never left naming a removed change, whichever of two edits on one document lands second", () => {
		for (const order of [
			[offerCreated, removePerson],
			[removePerson, offerCreated],
		] as const) {
			const store = storeOf(withoutAction());
			const first = commit(store, [order[0]]);
			expect(first.ok).toBe(true);
			const second = commit(store, [order[1]]);
			const doc = current(store);
			const slot = doc.modules[id.registerList]?.caseListRegistrationForm;
			const operations = doc.forms[id.register]?.caseOperations ?? [];
			if (slot?.kind === "always" && slot.target?.kind === "created-case")
				expect(operations.map((one) => one.uuid)).toContain(
					slot.target.operationUuid,
				);
			// The second edit, planned on the document before the first, is
			// refused: the button keeps the change it uses until its host
			// chooses another, and no button names a change that is gone.
			expect(second.ok).toBe(false);
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		}
	});

	it("comes back exactly with undo and goes again with redo", () => {
		const store = storeOf(withoutAction());
		expect(commit(store, [offerCreated]).ok).toBe(true);
		expect(
			current(store).modules[id.registerList]?.caseListRegistrationForm,
		).toEqual(created);
		store.getState().undo();
		expect(
			current(store).modules[id.registerList]?.caseListRegistrationForm,
		).toBeUndefined();
		store.getState().redo();
		expect(
			current(store).modules[id.registerList]?.caseListRegistrationForm,
		).toEqual(created);
	});

	it("keeps naming the change when the change's id is renamed", () => {
		const store = storeOf(caseListActionRolesFixture());
		const renamed = commit(store, [
			{
				kind: "updateForm",
				uuid: id.register,
				patch: {},
				caseOperationPatch: {
					operation: "update",
					uuid: id.newPerson,
					targetAction: "create",
					patch: { id: "new_relative" },
				},
			} as unknown as Mutation,
		]);
		expect(renamed.ok ? [] : renamed.findings).toEqual([]);
		const doc = current(store);
		expect(
			doc.forms[id.register]?.caseOperations?.find(
				(one) => one.uuid === id.newPerson,
			)?.id,
		).toBe("new_relative");
		const slot = doc.modules[id.registerList]?.caseListRegistrationForm;
		expect(slot?.kind === "always" && slot.target).toEqual({
			kind: "created-case",
			operationUuid: id.newPerson,
		});
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});
});

const BADGED = testUuid("badge-edits-households");

/** Households, a list of households whose badge counts nothing yet, the worker's `district` declared. */
function badgedMenu(badge?: Module["badge"]): BlueprintDoc {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: BADGED,
				name: "Households",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
	});
	declareWorkerProperties(doc, ["district"]);
	if (badge !== undefined) doc.modules[BADGED].badge = badge;
	return doc;
}

const DISTRICT = workerPropertyUuid("district");
const districtBadge: NonNullable<Module["badge"]> = {
	kind: "calculation",
	expression: term(sessionUserProperty(DISTRICT)),
};
const setBadge = (badge: Module["badge"] | null): Mutation =>
	({ kind: "updateModule", uuid: BADGED, patch: { badge } }) as Mutation;

/** The badge HQ's upload carries for Households, as Nova writes it. */
function uploadedBadge(doc: BlueprintDoc): unknown {
	return expandDoc(doc).modules[0]?.custom_icons;
}

describe("a menu's badge", () => {
	it("takes the second of two edits planned on one document whole, never a mix of the two", () => {
		const text = { kind: "text", text: "Due" } as const;
		for (const [first, second] of [
			[text, districtBadge],
			[districtBadge, text],
		] as const) {
			const store = storeOf(badgedMenu());
			expect(commit(store, [setBadge(first)]).ok).toBe(true);
			expect(commit(store, [setBadge(second)]).ok).toBe(true);
			expect(current(store).modules[BADGED]?.badge).toEqual(second);
			expect(runValidation(current(store), LOOKUP_CONTEXT_UNAVAILABLE)).toEqual(
				[],
			);
		}
	});

	it("keeps a worker property a badge reads: its removal is refused, naming the badge", () => {
		const plan = removeUserPropertyPlan(badgedMenu(districtBadge), DISTRICT);
		expect(plan.ok).toBe(false);
		expect(plan.ok ? [] : plan.references).toHaveLength(1);
	});

	it("comes back exactly with undo and goes again with redo", () => {
		const store = storeOf(badgedMenu({ kind: "text", text: "New" }));
		expect(commit(store, [setBadge(districtBadge)]).ok).toBe(true);
		store.getState().undo();
		expect(current(store).modules[BADGED]?.badge).toEqual({
			kind: "text",
			text: "New",
		});
		store.getState().redo();
		expect(current(store).modules[BADGED]?.badge).toEqual(districtBadge);
	});

	it("reads the worker property by identity, so a rename reaches the upload", () => {
		const store = storeOf(badgedMenu(districtBadge));
		const before = JSON.stringify(uploadedBadge(current(store)));
		expect(before).toContain("district");
		const renamed = commit(store, [
			{
				kind: "updateUserProperty",
				uuid: DISTRICT,
				patch: { slug: "ward" },
			} as Mutation,
		]);
		expect(renamed.ok ? [] : renamed.findings).toEqual([]);
		expect(current(store).modules[BADGED]?.badge).toEqual(districtBadge);
		const after = JSON.stringify(uploadedBadge(current(store)));
		expect(after).toContain("ward");
		expect(after).not.toContain("district");
	});
});

describe("a form's deep link argument supplied by a case it creates", () => {
	const target = {
		kind: "form",
		moduleUuid: id.householdForms,
		formUuid: id.register,
	} as const;

	it("is never left naming a removed change, whichever of two edits on one document lands second", () => {
		const base = withoutAction();
		const choose = planFormEntryCaseCreations(base, target, [id.newPerson]);
		if (!choose.ok) throw new Error(choose.reason.message);
		for (const order of [
			[choose.mutations, [removePerson]],
			[[removePerson], choose.mutations],
		] as const) {
			const store = storeOf(base);
			expect(commit(store, [...order[0]]).ok).toBe(true);
			commit(store, [...order[1]]);
			const doc = current(store);
			const operations = new Set(
				(doc.forms[id.register]?.caseOperations ?? []).map((one) => one.uuid),
			);
			for (const chosen of doc.forms[id.register]?.entryCaseCreations ?? [])
				expect(operations.has(chosen)).toBe(true);
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		}
	});

	it("comes back exactly with undo and goes again with redo", () => {
		const base = withoutAction();
		const choose = planFormEntryCaseCreations(base, target, [id.newPerson]);
		if (!choose.ok) throw new Error(choose.reason.message);
		const store = storeOf(base);
		expect(commit(store, [...choose.mutations]).ok).toBe(true);
		expect(current(store).forms[id.register]?.entryCaseCreations).toEqual([
			id.newPerson,
		]);
		store.getState().undo();
		expect(
			current(store).forms[id.register]?.entryCaseCreations,
		).toBeUndefined();
		store.getState().redo();
		expect(current(store).forms[id.register]?.entryCaseCreations).toEqual([
			id.newPerson,
		]);
	});
});
