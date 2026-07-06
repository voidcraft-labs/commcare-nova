/**
 * Wire round-trip proof that clearing an optional module/form slot survives
 * mutation-only persistence.
 *
 * The browser diffs its working doc into a `Mutation[]` and ships it as JSON
 * to `PUT /api/apps/[id]`, where the server parses each mutation through
 * `mutationSchema` and replays it with `applyMutations`. Two hazards an
 * in-memory replay (the `diffDocsToMutations.fuzz.test.ts` oracle) can't
 * catch live on that wire:
 *
 *   1. `JSON.stringify` DROPS `undefined`-valued keys, so a clear that
 *      lowers to `{ key: undefined }` arrives as an absent key — a no-op
 *      that silently keeps the stale value.
 *   2. The patch schema must ADMIT the clear's value, and the reducer must
 *      DELETE the slot rather than store the value, for the clear to land.
 *
 * Each test serializes the diff through `JSON.parse(JSON.stringify(...))`,
 * re-parses every mutation through `mutationSchema`, and replays the parsed
 * mutations on `prev` — the exact server path — then asserts the slot is
 * GONE (not present, not `null`).
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate";

/**
 * Replay a diff exactly as the persistence wire does: serialize to JSON
 * (dropping any `undefined`-valued key, as `JSON.stringify` does over the
 * `PUT` body), re-parse each mutation through `mutationSchema`, and apply
 * the parsed mutations to `prev`.
 */
function replayOverWire(prev: BlueprintDoc, next: BlueprintDoc): BlueprintDoc {
	const mutations = diffDocsToMutations(prev, next);
	const onWire = JSON.parse(JSON.stringify({ mutations })) as {
		mutations: unknown[];
	};
	const parsed = onWire.mutations.map((m) => mutationSchema.parse(m));
	return produce(prev, (d) => {
		applyMutations(d, parsed as Mutation[]);
	});
}

describe("diffDocsToMutations — clearing an optional slot survives the wire", () => {
	it("clears a form's closeCondition (conditional close → always close)", () => {
		const prev = buildDoc({
			appName: "Clinic",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Close visit",
							type: "close",
							closeCondition: { field: "done", answer: "yes" },
							fields: [{ kind: "text", id: "done", label: "Done?" }],
						},
					],
				},
			],
		});
		const formUuid = Object.keys(prev.forms)[0];
		expect(prev.forms[formUuid].closeCondition).toBeDefined();

		// The CloseConditionSection dispatch: switch the conditional close back
		// to "always close" by blanking `closeCondition`.
		const next = produce(prev, (d) => {
			d.forms[formUuid].closeCondition = undefined;
		});

		const replayed = replayOverWire(prev, next);

		// GONE — not present, not `null`.
		expect("closeCondition" in replayed.forms[formUuid]).toBe(false);
		expect(toPersistableDoc(replayed)).toEqual(toPersistableDoc(next));
	});

	it("clears a module's caseListConfig.filter", () => {
		const prev = buildDoc({
			appName: "Clinic",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [],
						searchInputs: [],
						filter: eq(prop("patient", "status"), literal("active")),
					},
				},
			],
		});
		const moduleUuid = Object.keys(prev.modules)[0];
		expect(prev.modules[moduleUuid].caseListConfig?.filter).toBeDefined();

		// Clear just the nested `filter` — the surrounding `caseListConfig`
		// survives. The diff emits a wholesale `caseListConfig` patch whose
		// rebuilt object omits `filter`.
		const next = produce(prev, (d) => {
			const config = d.modules[moduleUuid].caseListConfig;
			if (config) config.filter = undefined;
		});

		const replayed = replayOverWire(prev, next);

		const config = replayed.modules[moduleUuid].caseListConfig;
		expect(config).toBeDefined();
		expect(config && "filter" in config).toBe(false);
		expect(toPersistableDoc(replayed)).toEqual(toPersistableDoc(next));
	});

	it("clears a module's caseType (a top-level optional slot)", () => {
		const prev = buildDoc({
			appName: "Clinic",
			modules: [{ name: "Records", caseType: "patient", caseListOnly: true }],
		});
		const moduleUuid = Object.keys(prev.modules)[0];
		expect(prev.modules[moduleUuid].caseType).toBe("patient");

		const next = produce(prev, (d) => {
			d.modules[moduleUuid].caseType = undefined;
		});

		const replayed = replayOverWire(prev, next);

		expect("caseType" in replayed.modules[moduleUuid]).toBe(false);
		expect(toPersistableDoc(replayed)).toEqual(toPersistableDoc(next));
	});
});
