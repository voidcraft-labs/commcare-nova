/**
 * The SA's positional resolvers address DISPLAY order, not array position.
 *
 * `moduleIndex` / `formIndex` are the sequence the SA reads from
 * `summarizeBlueprint` / `get_app` / `searchBlueprint` — `sort-by-(order,
 * uuid)`. A same-parent reorder writes only the entity's `order` and leaves
 * the `moduleOrder` / `formOrder` membership array untouched, so a resolver
 * that indexed the raw array would address the WRONG entity afterward. This
 * proves `resolveModuleUuid` / `resolveFormUuid` follow the sorted sequence.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { applyMutations } from "@/lib/doc/mutations";
import { backfillOrderKeys } from "@/lib/doc/order/backfill";
import { keyBetween } from "@/lib/doc/order/keys";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { resolveFormUuid, resolveModuleUuid } from "../blueprintHelpers";

function hydrate(doc: BlueprintDoc): BlueprintDoc {
	const copy = structuredClone(doc);
	backfillOrderKeys(copy);
	return copy;
}

describe("SA positional resolvers follow display order after a reorder", () => {
	it("resolveModuleUuid tracks a same-parent module reorder, not the array slot", () => {
		const doc = hydrate(
			buildDoc({
				modules: [
					{ name: "Alpha", forms: [{ name: "FA", type: "survey" }] },
					{ name: "Bravo", forms: [{ name: "FB", type: "survey" }] },
				],
			}),
		);
		const [alpha, bravo] = doc.moduleOrder;
		// Move Bravo to sort BEFORE Alpha — order-only, membership array
		// untouched (Bravo stays at array index 1).
		const next = produce(doc, (d) => {
			applyMutations(d, [
				{
					kind: "moveModule",
					uuid: bravo,
					order: keyBetween(null, d.modules[alpha].order ?? null),
				} as Mutation,
			]);
		});
		// The array is unchanged; only the display order flipped.
		expect(next.moduleOrder).toEqual(doc.moduleOrder);
		// Index 0 now resolves to Bravo (display-first), NOT the array head.
		expect(resolveModuleUuid(next, 0)).toBe(bravo);
		expect(resolveModuleUuid(next, 1)).toBe(alpha);
		// A raw array read would (wrongly) still see Alpha at 0.
		expect(next.moduleOrder[0]).toBe(alpha);
	});

	it("resolveFormUuid tracks a same-parent form reorder, not the array slot", () => {
		const doc = hydrate(
			buildDoc({
				modules: [
					{
						name: "M",
						forms: [
							{ name: "First", type: "survey" },
							{ name: "Second", type: "survey" },
						],
					},
				],
			}),
		);
		const moduleUuid = doc.moduleOrder[0];
		const [first, second] = doc.formOrder[moduleUuid];
		// Move Second before First — order-only.
		const next = produce(doc, (d) => {
			applyMutations(d, [
				{
					kind: "moveForm",
					uuid: second,
					toModuleUuid: moduleUuid,
					order: keyBetween(null, d.forms[first].order ?? null),
				} as Mutation,
			]);
		});
		expect(next.formOrder[moduleUuid]).toEqual(doc.formOrder[moduleUuid]);
		expect(resolveFormUuid(next, 0, 0)).toBe(second);
		expect(resolveFormUuid(next, 0, 1)).toBe(first);
	});
});
