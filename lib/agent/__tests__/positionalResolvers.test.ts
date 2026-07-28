/**
 * The SA's positional resolvers address the sequence a reorder actually moved.
 *
 * `moduleIndex` / `formIndex` are what the SA reads back from
 * `summarizeBlueprint` / `get_app` / `searchBlueprint`, so a resolver has to
 * agree with the membership array those summaries walk — the array IS the
 * sequence. This proves `resolveModuleUuid` / `resolveFormUuid` follow a move.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc } from "@/lib/domain";
import {
	resolveFieldTarget,
	resolveFormUuid,
	resolveModuleUuid,
} from "../blueprintHelpers";

function hydrate(doc: BlueprintDoc): BlueprintDoc {
	const copy = structuredClone(doc);
	return copy;
}

describe("SA positional resolvers follow a reorder", () => {
	it("resolveModuleUuid tracks a same-parent module reorder", () => {
		const doc = hydrate(
			buildDoc({
				modules: [
					{ name: "Alpha", forms: [{ name: "FA", type: "survey" }] },
					{ name: "Bravo", forms: [{ name: "FB", type: "survey" }] },
				],
			}),
		);
		const [alpha, bravo] = doc.moduleOrder;
		// Move Bravo above Alpha.
		const next = produce(doc, (d) => {
			applyMutations(d, [{ kind: "moveModule", uuid: bravo, after: null }]);
		});
		expect(next.moduleOrder).toEqual([bravo, alpha]);
		expect(resolveModuleUuid(next, 0)).toBe(bravo);
		expect(resolveModuleUuid(next, 1)).toBe(alpha);
	});

	it("resolveFormUuid tracks a same-parent form reorder", () => {
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
		// Move Second above First.
		const next = produce(doc, (d) => {
			applyMutations(d, [
				{
					kind: "moveForm",
					uuid: second,
					toModuleUuid: moduleUuid,
					after: null,
				},
			]);
		});
		expect(next.formOrder[moduleUuid]).toEqual([second, first]);
		expect(resolveFormUuid(next, 0, 0)).toBe(second);
		expect(resolveFormUuid(next, 0, 1)).toBe(first);
	});
});

describe("resolveFieldTarget — bare id, uuid, and ambiguity", () => {
	/** Two groups legally sharing a field id (sibling-uniqueness is per
	 *  parent level), plus a second form holding an unrelated field. */
	function makeDoc(): BlueprintDoc {
		return hydrate(
			buildDoc({
				modules: [
					{
						name: "Clinic",
						forms: [
							{
								name: "Encounter",
								type: "survey",
								fields: [
									f({
										id: "orders",
										kind: "group",
										label: "Orders",
										children: [
											f({
												id: "patient_name",
												kind: "text",
												label: "In orders",
											}),
										],
									}),
									f({
										id: "history",
										kind: "group",
										label: "History",
										children: [
											f({
												id: "patient_name",
												kind: "text",
												label: "In history",
											}),
										],
									}),
									f({ id: "visit_date", kind: "date", label: "Visit date" }),
								],
							},
						],
					},
					{
						name: "Village",
						forms: [
							{
								name: "Register",
								type: "registration",
								fields: [f({ id: "village_name", kind: "text" })],
							},
						],
					},
				],
			}),
		);
	}

	it("resolves a unique bare id with its path", () => {
		const doc = makeDoc();
		const resolved = resolveFieldTarget(doc, 0, 0, "visit_date");
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.field.id).toBe("visit_date");
		expect(resolved.path).toBe("visit_date");
	});

	it("REFUSES an ambiguous bare id, listing every match's path + uuid", () => {
		const doc = makeDoc();
		const resolved = resolveFieldTarget(doc, 0, 0, "patient_name");
		expect(resolved.ok).toBe(false);
		if (resolved.ok) return;
		expect(resolved.error).toContain("ambiguous");
		expect(resolved.error).toContain('"orders/patient_name"');
		expect(resolved.error).toContain('"history/patient_name"');
		// Both uuids are named so the SA can re-target without a read call.
		const inOrders = Object.values(doc.fields).find(
			(fld) =>
				fld.id === "patient_name" &&
				"label" in fld &&
				fld.label === "In orders",
		);
		const inHistory = Object.values(doc.fields).find(
			(fld) =>
				fld.id === "patient_name" &&
				"label" in fld &&
				fld.label === "In history",
		);
		expect(resolved.error).toContain(String(inOrders?.uuid));
		expect(resolved.error).toContain(String(inHistory?.uuid));
	});

	it("resolves a uuid to the exact field, path included", () => {
		const doc = makeDoc();
		const inHistory = Object.values(doc.fields).find(
			(fld) =>
				fld.id === "patient_name" &&
				"label" in fld &&
				fld.label === "In history",
		);
		if (!inHistory) throw new Error("fixture field missing");
		const resolved = resolveFieldTarget(doc, 0, 0, inHistory.uuid);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.field.uuid).toBe(inHistory.uuid);
		expect(resolved.path).toBe("history/patient_name");
	});

	it("rejects a uuid that lives in a different form, naming its location", () => {
		const doc = makeDoc();
		const village = Object.values(doc.fields).find(
			(fld) => fld.id === "village_name",
		);
		if (!village) throw new Error("fixture field missing");
		const resolved = resolveFieldTarget(doc, 0, 0, village.uuid);
		expect(resolved.ok).toBe(false);
		if (resolved.ok) return;
		expect(resolved.error).toContain('"Register" (m1-f0)');
	});

	it("resolves a bare id that collides with an Object.prototype key", () => {
		// `doc.fields` is a plain prototype-bearing record, so an id like
		// "constructor" would hit an inherited key on a naive `doc.fields[ref]`
		// probe — the resolver's own-key guard keeps such fields addressable.
		const doc = hydrate(
			buildDoc({
				modules: [
					{
						name: "M",
						forms: [
							{
								name: "F",
								type: "survey",
								fields: [
									f({ id: "constructor", kind: "text", label: "Builder" }),
								],
							},
						],
					},
				],
			}),
		);
		const resolved = resolveFieldTarget(doc, 0, 0, "constructor");
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.field.id).toBe("constructor");
		expect(resolved.path).toBe("constructor");
	});

	it("misses cleanly on an unknown id and an out-of-range form", () => {
		const doc = makeDoc();
		const missing = resolveFieldTarget(doc, 0, 0, "nope");
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error).toContain('"nope" not found');
		const badForm = resolveFieldTarget(doc, 4, 2, "visit_date");
		expect(badForm.ok).toBe(false);
		if (!badForm.ok) expect(badForm.error).toContain("Form m4-f2 not found");
	});
});
