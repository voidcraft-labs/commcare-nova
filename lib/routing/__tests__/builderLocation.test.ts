import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { proseText } from "@/lib/domain/prose";
import {
	createBuilderLocationSource,
	hasSelectedField,
	locationKind,
	selectedFieldUuid,
	selectedFormUuid,
	selectedModuleUuid,
	selectedProjectDataTableId,
} from "../builderLocation";
import type { Location } from "../types";

function fixture() {
	const store = createBlueprintDocStore();
	store.getState().load(
		buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Intake",
							type: "survey",
							fields: [
								f({ kind: "text", id: "one" }),
								f({ kind: "text", id: "two" }),
							],
						},
					],
				},
			],
		}),
	);
	const moduleUuid = store.getState().moduleOrder[0];
	const [formUuid] = store.getState().formOrder[moduleUuid];
	const [first, second] = store.getState().fieldOrder[formUuid];
	let segments: string[] = [first];
	const listeners = new Set<() => void>();
	const source = createBuilderLocationSource({
		getSegments: () => segments,
		subscribe: (callback) => {
			listeners.add(callback);
			return () => {
				listeners.delete(callback);
			};
		},
	});
	return {
		store,
		source,
		moduleUuid,
		formUuid,
		first,
		second,
		listeners,
		navigate: (next: string[]) => {
			segments = next;
			for (const fn of listeners) fn();
		},
	};
}

describe("Builder location source", () => {
	it("shares stable semantic snapshots across readers and ignores scalar edits", () => {
		const h = fixture();
		const initial = h.source.getSnapshot(h.store);
		const observations: Location[] = [];
		const unsubscribe = h.source.subscribe(h.store, () =>
			observations.push(h.source.getSnapshot(h.store)),
		);
		try {
			expect(initial).toEqual({
				kind: "form",
				moduleUuid: h.moduleUuid,
				formUuid: h.formUuid,
				selectedUuid: h.first,
			});
			expect(h.source.getSnapshot(h.store)).toBe(initial);
			expect(
				h.store.getState().applyMany([
					{
						kind: "updateField",
						uuid: h.first,
						targetKind: "text",
						patch: { label: proseText("Renamed") },
					},
				]),
			).toEqual([undefined]);
			expect(observations).toEqual([]);
			expect(h.source.getSnapshot(h.store)).toBe(initial);
			h.navigate([h.second]);
			const next = h.source.getSnapshot(h.store);
			expect(observations).toEqual([next]);
			expect(next).toEqual({ ...initial, selectedUuid: h.second });
			// These are the primitive values React observes; only the field changes.
			for (const projection of [
				selectedModuleUuid,
				selectedFormUuid,
				hasSelectedField,
				locationKind,
				selectedProjectDataTableId,
			]) {
				expect(projection(next)).toBe(projection(initial));
			}
			expect(selectedFieldUuid(next)).toBe(h.second);
		} finally {
			unsubscribe();
		}
		expect(h.listeners.size).toBe(0);
	});

	it("re-resolves the unchanged field URL after a real move, removal and undo", () => {
		const h = fixture();
		h.store.getState().startTracking();
		const observations: Location[] = [];
		const unsubscribe = h.source.subscribe(h.store, () =>
			observations.push(h.source.getSnapshot(h.store)),
		);
		try {
			h.source.getSnapshot(h.store);
			expect(
				h.store.getState().applyMany([
					{
						kind: "moveField",
						uuid: h.first,
						toParentUuid: h.formUuid,
						after: h.second,
					},
				]),
			).toEqual([undefined]);
			expect(observations.at(-1)).toEqual({
				kind: "form",
				moduleUuid: h.moduleUuid,
				formUuid: h.formUuid,
				selectedUuid: h.first,
			});
			expect(
				h.store.getState().applyMany([{ kind: "removeField", uuid: h.first }]),
			).toEqual([undefined]);
			expect(observations.at(-1)).toEqual({ kind: "home" });
			h.store.getState().undo();
			expect(observations.at(-1)).toEqual({
				kind: "form",
				moduleUuid: h.moduleUuid,
				formUuid: h.formUuid,
				selectedUuid: h.first,
			});
		} finally {
			unsubscribe();
		}
		const before = observations.length;
		h.navigate([]);
		h.store.getState().undo();
		expect(observations).toHaveLength(before);
	});

	it("keeps distinct documents isolated and resolves malformed and module paths", () => {
		const h = fixture();
		const empty = createBlueprintDocStore();
		expect(h.source.getSnapshot(empty)).toEqual({ kind: "home" });
		expect(h.source.getSnapshot(h.store).kind).toBe("form");
		h.navigate([h.moduleUuid]);
		expect(h.source.getSnapshot(h.store)).toEqual({
			kind: "module",
			moduleUuid: h.moduleUuid,
		});
		expect(h.source.getSnapshot(empty)).toEqual({ kind: "home" });
		h.navigate(["missing"]);
		expect(h.source.getSnapshot(h.store)).toEqual({ kind: "home" });
		h.navigate([]);
		expect(h.source.getSnapshot(h.store)).toEqual({ kind: "home" });
	});
});
