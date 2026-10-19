/**
 * The two halves of a module's case list step agree (part 05 §1.3, "One id
 * per slot"; §5): the domain half (`entryDatumSupplies`, the `case-list`
 * point) decides without spelling an id which chosen cases every entry the
 * list runs in holds at one datum id, and the id half
 * (`formLinkProjection.ts::entryDatumIds`) prints those ids. A ref the domain
 * admits must print one id in every entry; a ref it puts in `differs` must
 * print another id, or none, in some entry. Only a `selected-case` is read
 * at these points.
 */
import * as fc from "fast-check";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import { assertGenerated } from "@/lib/commcare/__tests__/compilerEvidence";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import {
	entryDatumIds,
	formLinkProjectionContext,
} from "@/lib/commcare/formLinkProjection";
import {
	chosen,
	chosenCaseDoc,
} from "@/lib/domain/__tests__/chosenCaseFixture";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	entryDatumSupplies,
	modulesSelectingThrough,
} from "@/lib/domain/entryDatumSupplies";
import { datumRefKey } from "@/lib/domain/expression/types";
import { CASE_LOADING_FORM_TYPES } from "@/lib/domain/forms";
import type { Uuid } from "@/lib/domain/uuid";

/** The ids each entry reaching `module`'s list prints for the choices made
 * before the list, by ref. */
function printedBeforeList(
	doc: BlueprintDoc,
	module: Uuid,
): readonly ReadonlyMap<string, { id: string; scalar: boolean }>[] {
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	return [module, ...modulesSelectingThrough(doc, module)].flatMap((owner) => {
		if (doc.modules[owner]?.caseType === undefined) return [];
		const form = (doc.formOrder[owner] ?? []).find((uuid) => {
			const candidate = doc.forms[uuid];
			return (
				candidate !== undefined &&
				candidate.entry === undefined &&
				CASE_LOADING_FORM_TYPES.has(candidate.type)
			);
		});
		if (form === undefined && doc.modules[owner].caseListOnly !== true)
			return [];
		const rows = entryDatumIds(doc, ctx, owner, form);
		const own = rows.findIndex((row) =>
			row.refs.some(
				(ref) => ref.kind === "selected-case" && ref.module === module,
			),
		);
		if (own < 0) return [];
		return [
			new Map(
				rows
					.slice(0, own)
					.flatMap((row) =>
						row.refs
							.filter((ref) => ref.kind === "selected-case")
							.map(
								(ref) =>
									[
										datumRefKey(ref),
										{ id: row.id, scalar: row.scalar },
									] as const,
							),
					),
			),
		];
	});
}

/** For every module of `doc`, the domain's case list set equals what the
 * printed ids show. Returns how many lists it compared. */
function expectCaseListAgreement(doc: BlueprintDoc): number {
	let lists = 0;
	for (const module of doc.moduleOrder) {
		const printed = printedBeforeList(doc, module);
		const supplies = entryDatumSupplies(doc, { kind: "case-list", module });
		const [primary, ...others] = printed;
		const oneId: string[] = [];
		const differs: string[] = [];
		for (const [key, { id }] of primary ?? new Map()) {
			if (others.every((other) => other.get(key)?.id === id)) oneId.push(key);
			else differs.push(key);
		}
		const label = `${doc.modules[module]?.name ?? module}`;
		expect(
			supplies.refs.map(({ ref }) => datumRefKey(ref)).sort(),
			`${label}: one id`,
		).toEqual(oneId.sort());
		expect(
			(supplies.differs ?? []).map(({ ref }) => datumRefKey(ref)).sort(),
			`${label}: differs`,
		).toEqual(differs.sort());
		for (const { ref, scalar } of supplies.refs)
			expect(primary?.get(datumRefKey(ref))?.scalar, label).toBe(scalar);
		lists++;
	}
	return lists;
}

describe("the case list step's two halves", () => {
	it("agree over Villages → Households → Members", () => {
		expect(expectCaseListAgreement(chosenCaseDoc())).toBe(3);
		// Households' list runs at parent_id in its own entries and at
		// parent_parent_id in Members', so the village is no one id there.
		expect(
			entryDatumSupplies(chosenCaseDoc(), {
				kind: "case-list",
				module: chosen.households,
			}).differs,
		).toHaveLength(1);
	});

	it("agree when a child menu's choices align with its root's", () => {
		const nested = chosenCaseDoc();
		nested.modules[chosen.members].parentModuleUuid = chosen.households;
		expectCaseListAgreement(nested);
		const underVillages = chosenCaseDoc();
		underVillages.modules[chosen.households].parentModuleUuid = chosen.villages;
		expectCaseListAgreement(underVillages);
	});

	it("agree when two modules choose through one list from different menus", () => {
		const doc = chosenCaseDoc();
		const visits = testUuid("chosen-visits");
		const visitForm = testUuid("chosen-visit-form");
		doc.caseTypes?.push({
			name: "visit",
			parent_type: "household",
			properties: [],
		});
		doc.modules[visits] = {
			uuid: visits,
			id: "visits",
			name: "Visits",
			caseType: "visit",
			parentCaseModuleUuid: chosen.households,
			caseListConfig: caseListConfig([]),
		};
		doc.moduleOrder.push(visits);
		doc.forms[visitForm] = {
			uuid: visitForm,
			id: "visit",
			name: "Visit",
			type: "followup",
		};
		doc.formOrder[visits] = [visitForm];
		doc.fieldOrder[visitForm] = [];
		doc.modules[chosen.members].parentModuleUuid = chosen.households;
		expectCaseListAgreement(doc);
	});

	it("agree when a menu chooses several cases or none before the list", () => {
		const several = chosenCaseDoc();
		several.modules[chosen.villages].caseListConfig = {
			...caseListConfig([]),
			selection: { kind: "multiple", maximum: 3 },
		};
		expectCaseListAgreement(several);
		const parentless = chosenCaseDoc();
		parentless.modules[chosen.members].parentCaseModuleUuid = undefined;
		expectCaseListAgreement(parentless);
	});

	it("agree over generated suites, as written, nested and chained", () => {
		let lists = 0;
		assertGenerated(
			fc.property(suiteDocArbitrary, (doc) => {
				lists += expectCaseListAgreement(doc);
				lists += expectCaseListAgreement(
					produce(doc, (draft) => {
						const [root, child] = draft.moduleOrder;
						if (root !== undefined && child !== undefined)
							draft.modules[child].parentModuleUuid = root;
					}),
				);
				// Each later module picks its case after the one before it.
				lists += expectCaseListAgreement(
					produce(doc, (draft) => {
						for (const [index, module] of draft.moduleOrder.entries())
							if (index > 0)
								draft.modules[module].parentCaseModuleUuid =
									draft.moduleOrder[index - 1];
					}),
				);
			}),
			{ seed: 20261019, numRuns: 20 },
		);
		expect(lists).toBeGreaterThan(20);
	});
});
