/**
 * SA `add_fields` anchored insert — a `beforeFieldId` / `afterFieldId` batch
 * lands AT the anchor in DISPLAY order, not appended.
 *
 * Sequence is derived (`sort-by-(order, uuid)`), so the anchored fields must
 * take `order` keys BETWEEN the anchor's display neighbors — the same neighbor
 * bounds the builder's `orderKeyForFieldSlot` uses. These would fail while the
 * order-minting pass always appended.
 */

import { describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { addFieldsTool } from "../addFields";

function makeCtx() {
	// The guarded writer returns `{ events, committedDoc }`; echo the passed
	// post-mutation doc so the tool's `newDoc` reflects the anchored insert.
	const recordMutations = vi.fn(async (_m: unknown, doc: unknown) => ({
		events: [],
		committedDoc: doc,
	}));
	const recordMutationStages = vi.fn(
		async (stages: Array<{ doc: unknown }>) => ({
			events: [],
			committedDoc: stages[stages.length - 1]?.doc,
		}),
	);
	const ctx = {
		appId: "app-1",
		userId: "user-1",
		runId: "run-1",
		recordMutations,
		recordMutationStages,
		recordConversation: vi.fn(),
	} as unknown as ToolExecutionContext;
	return { ctx, recordMutations };
}

/** A one-form survey doc with three text fields (qa, qb, qc), HYDRATED so its
 *  existing fields carry the `order` keys the anchor computes bounds from —
 *  exactly the shape the SA's chokepoint-hydrated session doc has. */
function threeFieldDoc(): BlueprintDoc {
	return hydratePersistedBlueprint(
		toPersistableDoc(
			buildDoc({
				modules: [
					{
						name: "M",
						forms: [
							{
								name: "F",
								type: "survey",
								fields: [
									f({ kind: "text", id: "qa", label: "A" }),
									f({ kind: "text", id: "qb", label: "B" }),
									f({ kind: "text", id: "qc", label: "C" }),
								],
							},
						],
					},
				],
			}),
		),
	);
}

function formUuidOf(doc: BlueprintDoc): Uuid {
	return doc.formOrder[doc.moduleOrder[0]][0];
}

/** The form's top-level fields in DISPLAY order, by id. */
function displayIds(doc: BlueprintDoc): string[] {
	return orderedFieldUuids(doc, formUuidOf(doc)).map(
		(u) => doc.fields[u]?.id ?? "?",
	);
}

function textField(id: string) {
	return { kind: "text", id, label: id.toUpperCase() } as never;
}

describe("add_fields anchored insert lands at the anchor in display order", () => {
	it("afterFieldId places a single field immediately AFTER the anchor", async () => {
		const { ctx } = makeCtx();
		const out = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [textField("qx")],
				afterFieldId: "qa",
			},
			ctx,
			threeFieldDoc(),
		);
		expect("message" in out.result).toBe(true);
		expect(displayIds(out.newDoc)).toEqual(["qa", "qx", "qb", "qc"]);
	});

	it("beforeFieldId places a single field immediately BEFORE the anchor", async () => {
		const { ctx } = makeCtx();
		const out = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [textField("qx")],
				beforeFieldId: "qc",
			},
			ctx,
			threeFieldDoc(),
		);
		expect("message" in out.result).toBe(true);
		expect(displayIds(out.newDoc)).toEqual(["qa", "qb", "qx", "qc"]);
	});

	it("a MULTI-field anchored insert lands the run contiguously in input order", async () => {
		const { ctx } = makeCtx();
		const out = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [textField("qx"), textField("qy"), textField("qz")],
				afterFieldId: "qa",
			},
			ctx,
			threeFieldDoc(),
		);
		expect("message" in out.result).toBe(true);
		expect(displayIds(out.newDoc)).toEqual([
			"qa",
			"qx",
			"qy",
			"qz",
			"qb",
			"qc",
		]);
	});

	it("beforeFieldId on the FIRST child lands the field ahead of everything", async () => {
		const { ctx } = makeCtx();
		const out = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [textField("qx")],
				beforeFieldId: "qa",
			},
			ctx,
			threeFieldDoc(),
		);
		expect("message" in out.result).toBe(true);
		expect(displayIds(out.newDoc)).toEqual(["qx", "qa", "qb", "qc"]);
	});

	it("afterFieldId on the LAST child appends after everything", async () => {
		const { ctx } = makeCtx();
		const out = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [textField("qx")],
				afterFieldId: "qc",
			},
			ctx,
			threeFieldDoc(),
		);
		expect("message" in out.result).toBe(true);
		expect(displayIds(out.newDoc)).toEqual(["qa", "qb", "qc", "qx"]);
	});

	it("no anchor still appends (regression guard for the default path)", async () => {
		const { ctx } = makeCtx();
		const out = await addFieldsTool.execute(
			{ moduleIndex: 0, formIndex: 0, fields: [textField("qx")] },
			ctx,
			threeFieldDoc(),
		);
		expect("message" in out.result).toBe(true);
		expect(displayIds(out.newDoc)).toEqual(["qa", "qb", "qc", "qx"]);
	});

	it("an anchor at a COLLISION lands after the whole tied run at a defined position", async () => {
		// Force qa and qb to share an `order` key — a legitimate rested tie
		// (`bySortKey` breaks it on uuid). `keysForSlot` must widen past the
		// tied run so the insert lands after BOTH, before the next distinct key,
		// instead of emitting a key outside the degenerate interval.
		const doc = threeFieldDoc();
		const byId = (id: string) =>
			Object.values(doc.fields).find((fl) => fl.id === id);
		const qa = byId("qa");
		const qb = byId("qb");
		const qc = byId("qc");
		if (!qa || !qb || !qc) throw new Error("fixture missing fields");
		(qa as { order?: string }).order = "V";
		(qb as { order?: string }).order = "V";
		(qc as { order?: string }).order = "z";

		const { ctx } = makeCtx();
		const out = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [textField("qx")],
				afterFieldId: "qa",
			},
			ctx,
			doc,
		);
		expect("message" in out.result).toBe(true);
		const ids = displayIds(out.newDoc);
		// qx lands after both tied siblings and before the next distinct key —
		// a well-defined slot regardless of the uuid-broken tie order.
		expect(ids.indexOf("qx")).toBeGreaterThan(ids.indexOf("qa"));
		expect(ids.indexOf("qx")).toBeGreaterThan(ids.indexOf("qb"));
		expect(ids.indexOf("qx")).toBeLessThan(ids.indexOf("qc"));
	});
});
