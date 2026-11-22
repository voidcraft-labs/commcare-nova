import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	REGISTER,
	ROUTE,
	SOURCE,
	twoMenus,
	VISIT,
} from "@/lib/commcare/__tests__/menuFormRoutesFixture";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { caseListModuleMutations } from "@/lib/doc/scaffolds";
import { sharedChildUuid } from "@/lib/doc/sharedFormChildren";
import {
	changeListedMenuSource,
	withListedMenuHierarchy,
} from "@/lib/doc/sharedMenuHierarchy";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

function apply(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
	return verdict.nextDoc;
}

it("replays per-form changes to a listed menu while preserving an unrelated form link and a concurrent exclusion", () => {
	const doc = twoMenus();
	const added = { uuid: testUuid("register-in-clinic"), id: "clinic-register" };
	const before = apply(doc, [
		{
			kind: "addEntryPoint",
			entryPoint: added,
			target: { kind: "form", moduleUuid: ROUTE, formUuid: REGISTER },
		},
	]);
	const after = apply(before, [
		{
			kind: "updateModule",
			uuid: ROUTE,
			patch: {},
			listedForm: { sourceUuid: SOURCE, formUuid: REGISTER, included: true },
		},
		{
			kind: "updateEntryPoint",
			entryPointUuid: added.uuid,
			patch: { id: "register-here" },
		},
	]);
	const edits = diffDocsToMutations(before, after);
	expect(apply(before, edits)).toEqual(after);
	const concurrent = apply(before, [
		{
			kind: "updateModule",
			uuid: ROUTE,
			patch: {},
			listedForm: { sourceUuid: SOURCE, formUuid: VISIT, included: false },
		},
	]);
	const replayed = apply(concurrent, edits).modules[ROUTE].formsFromMenu;
	expect(replayed?.excludedFormUuids).toEqual([VISIT]);
	expect(replayed?.entryPoints?.map((row) => row.entryPoint.id)).toEqual([
		"clinic-visit",
		"register-here",
	]);
	expect(apply(after, diffDocsToMutations(after, before))).toEqual(before);
	expect(
		mutationCommitVerdict(
			before,
			[
				{
					kind: "updateModule",
					uuid: ROUTE,
					patch: { formsFromMenu: { menuUuid: SOURCE, entryPoints: [] } },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		).ok,
	).toBe(false);
});

it("preserves a listed child and its edited columns on reorder, removes it with the source child, and restores its real identities", () => {
	const before = twoMenus();
	const scaffold = caseListModuleMutations(before, {
		caseType: "patient",
		name: "Neighborhood",
		parentModuleUuid: SOURCE,
	});
	const edits = withListedMenuHierarchy(before, scaffold.mutations);
	const after = apply(before, edits);
	const child = sharedChildUuid(ROUTE, scaffold.moduleUuid);
	const settings = after.modules[child]?.caseListConfig;
	const column = settings?.columns[0];
	const original =
		after.modules[scaffold.moduleUuid]?.caseListConfig?.columns[0];
	if (!column || !original)
		throw new Error("The two paths need separate columns.");
	expect(after.modules[child].parentModuleUuid).toBe(ROUTE);
	expect(after.modules[child].formsFromMenu?.menuUuid).toBe(
		scaffold.moduleUuid,
	);
	expect(column.uuid).not.toBe(original.uuid);
	const renamed = apply(after, [
		{ kind: "renameModule", uuid: child, newId: "Clinic area" },
	]);
	const reorder = withListedMenuHierarchy(renamed, [
		{ kind: "moveModule", uuid: scaffold.moduleUuid, after: null },
	]);
	expect(apply(renamed, reorder).modules[child]).toEqual(
		renamed.modules[child],
	);
	const detach = withListedMenuHierarchy(renamed, [
		{ kind: "moveModule", uuid: child, parentModuleUuid: null, after: null },
	]);
	const detached = mutationCommitVerdict(
		renamed,
		detach,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(detached).toMatchObject({
		ok: false,
		findings: expect.arrayContaining([
			expect.objectContaining({ code: "MENU_FORM_SOURCE_INVALID" }),
		]),
	});
	const remove = withListedMenuHierarchy(renamed, [
		{ kind: "removeModule", uuid: scaffold.moduleUuid },
	]);
	const deleted = apply(renamed, remove);
	expect(deleted.modules[child]).toBeUndefined();
	expect(deleted.forms).toEqual(renamed.forms);
	expect(apply(deleted, diffDocsToMutations(deleted, renamed))).toEqual(
		renamed,
	);
});

it("requires an explicit decision about active and paused form links before changing the menu that supplies forms", () => {
	const doc = twoMenus();
	const other = caseListModuleMutations(doc, {
		caseType: "patient",
		name: "Other clinic",
	});
	const before = apply(doc, other.mutations);
	expect(
		changeListedMenuSource(before, ROUTE, SOURCE, other.moduleUuid),
	).toMatchObject({
		ok: false,
		message: expect.stringContaining("clinic-visit"),
	});
	const removed = apply(before, [
		{ kind: "removeEntryPoint", entryPointUuid: testUuid("clinic-visit") },
	]);
	const switchSource = changeListedMenuSource(
		removed,
		ROUTE,
		SOURCE,
		other.moduleUuid,
	);
	if (!switchSource.ok) throw new Error(switchSource.message);
	const after = apply(
		removed,
		withListedMenuHierarchy(removed, switchSource.mutations),
	);
	expect(after.modules[ROUTE].formsFromMenu).toEqual({
		menuUuid: other.moduleUuid,
	});
	expect(apply(before, diffDocsToMutations(before, after))).toEqual(after);
	expect(apply(after, diffDocsToMutations(after, before))).toEqual(before);
	expect(
		mutationCommitVerdict(
			after,
			[
				{
					kind: "updateModule",
					uuid: ROUTE,
					patch: {},
					listedForm: {
						sourceUuid: SOURCE,
						formUuid: REGISTER,
						included: false,
					},
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		).ok,
	).toBe(false);
});

it("preserves the route and external link when an HQ edit moves the form and changes that route's source together", () => {
	const initial = twoMenus();
	const other = caseListModuleMutations(initial, {
		caseType: "patient",
		name: "Outreach",
	});
	const before = apply(initial, other.mutations);
	const link = before.modules[ROUTE].formsFromMenu?.entryPoints?.[0];
	if (!link) throw new Error("The original route needs its Visit link.");
	const moved = apply(before, [
		{
			kind: "moveForm",
			uuid: VISIT,
			toModuleUuid: other.moduleUuid,
			after: null,
		},
		{
			kind: "updateModule",
			uuid: ROUTE,
			patch: { formsFromMenu: { menuUuid: other.moduleUuid } },
		},
	]);
	const next = apply(moved, [
		{
			kind: "addEntryPoint",
			target: { kind: "form", moduleUuid: ROUTE, formUuid: VISIT },
			entryPoint: link.entryPoint,
		},
	]);
	expect(apply(before, diffDocsToMutations(before, next))).toEqual(next);
	expect(apply(next, diffDocsToMutations(next, before))).toEqual(before);
});
