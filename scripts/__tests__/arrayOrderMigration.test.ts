/**
 * The migration's acceptance bar: it must be invisible.
 *
 * Each fixture is a shape that actually exists in stored data and that would
 * reorder an app if the transform got it wrong. The assertion is always the
 * same — the sequence the document renders today, read through the production
 * comparators, must equal the migrated document's plain array position.
 */

import { describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import {
	derivedSequences,
	migrateDocToArrayOrder,
	sequenceDivergences,
} from "../lib/arrayOrderMigration";

const EMPTY = {
	appName: "t",
	modules: {},
	forms: {},
	fields: {},
	moduleOrder: [],
	formOrder: {},
	fieldOrder: {},
	caseTypes: {},
};

function doc(patch: Record<string, unknown>): BlueprintDoc {
	return { ...EMPTY, ...patch } as unknown as BlueprintDoc;
}

function fieldsDoc(entries: [string, string | undefined][]): BlueprintDoc {
	const fields: Record<string, unknown> = {};
	for (const [uuid, order] of entries) {
		fields[uuid] = {
			uuid,
			id: uuid,
			kind: "text",
			label: uuid,
			...(order === undefined ? {} : { order }),
		};
	}
	// The array deliberately keeps insertion order — the stale shape every
	// reordered app is in, since a same-parent reorder never touches it.
	return doc({ fields, fieldOrder: { p1: entries.map(([uuid]) => uuid) } });
}

/** Migrate, and assert nothing anyone can see moved. */
function migrateInvisibly(input: BlueprintDoc): BlueprintDoc {
	const before = derivedSequences(input);
	const migrated = migrateDocToArrayOrder(input);
	expect(sequenceDivergences(before, migrated)).toEqual([]);
	return migrated;
}

describe("order-key migration", () => {
	it("adopts the key order, not the stale array order", () => {
		// Keys say three,one,two. The stored array still says one,two,three,
		// because reordering never rewrote it. Reinterpreting position without
		// migrating is exactly what would silently reorder this app.
		const migrated = migrateInvisibly(
			fieldsDoc([
				["one", "V"],
				["two", "VV"],
				["three", "F"],
			]),
		);
		expect(migrated.fieldOrder.p1).toEqual(["three", "one", "two"]);
	});

	it("freezes a rested tie exactly where it renders today", () => {
		// Two entities sharing a key is the defect this change removes, and it is
		// a legitimate rested state in stored data. Today it renders by uuid
		// tie-break; the migration must preserve that, not resolve it differently.
		const migrated = migrateInvisibly(
			fieldsDoc([
				["a-first", "V"],
				["z-tied", "F"],
				["b-tied", "F"],
			]),
		);
		expect(migrated.fieldOrder.p1).toEqual(["b-tied", "z-tied", "a-first"]);
	});

	it("keeps array position when no entity carries a key", () => {
		// `bySortKey` returns 0 for two absent keys, so a stable sort falls back to
		// array position. This is the one branch where position already leaks
		// through today, and a reimplemented tie-break would order these by uuid
		// and silently reorder every legacy app.
		const migrated = migrateInvisibly(
			doc({
				fields: {
					"z-later": { uuid: "z-later", id: "z", kind: "text", label: "z" },
					"a-earlier": { uuid: "a-earlier", id: "a", kind: "text", label: "a" },
				},
				fieldOrder: { p1: ["z-later", "a-earlier"] },
			}),
		);
		expect(migrated.fieldOrder.p1).toEqual(["z-later", "a-earlier"]);
	});

	it("sorts keyed entities ahead of keyless ones", () => {
		const migrated = migrateInvisibly(
			fieldsDoc([
				["nokey1", undefined],
				["keyed", "V"],
				["nokey2", undefined],
			]),
		);
		expect(migrated.fieldOrder.p1).toEqual(["keyed", "nokey1", "nokey2"]);
	});

	it("splits the two case-list sequences into two arrays", () => {
		// One `columns` array carries two independent sequences. A single array
		// cannot hold both, which is why the migrated config grows two.
		const migrated = migrateInvisibly(
			doc({
				modules: {
					m1: {
						uuid: "m1",
						name: "M",
						caseListConfig: {
							columns: [
								{ uuid: "c-a", listOrder: "V", detailOrder: "VVV" },
								{ uuid: "c-b", listOrder: "VV", detailOrder: "F" },
								{ uuid: "c-c", listOrder: "F", detailOrder: "VV" },
							],
							searchInputs: [],
						},
					},
				},
				moduleOrder: ["m1"],
			}),
		);
		const config = migrated.modules.m1.caseListConfig as unknown as {
			listColumnOrder: string[];
			detailColumnOrder: string[];
			columns: { listOrder?: string; detailOrder?: string }[];
		};
		expect(config.listColumnOrder).toEqual(["c-c", "c-a", "c-b"]);
		expect(config.detailColumnOrder).toEqual(["c-b", "c-c", "c-a"]);
		// Every column appears in both arrays regardless of visibility, so hiding
		// and re-showing one restores its place.
		expect([...config.listColumnOrder].sort()).toEqual(
			[...config.detailColumnOrder].sort(),
		);
		for (const column of config.columns) {
			expect(column.listOrder).toBeUndefined();
			expect(column.detailOrder).toBeUndefined();
		}
	});

	it("gives the flat collections the membership array they never had", () => {
		// These persist with no membership array and every row at ordinal 0, so
		// their sequence lives only in the key. Stripping it without this would
		// destroy their ordering outright.
		const migrated = migrateInvisibly(
			doc({
				userProperties: {
					"z-prop": { uuid: "z-prop", slug: "z", label: "Z" },
					"a-prop": { uuid: "a-prop", slug: "a", label: "A" },
				},
				userTypes: {
					"m-type": { uuid: "m-type", name: "M", order: "V" },
					"b-type": { uuid: "b-type", name: "B", order: "F" },
				},
			}),
		);
		const flat = migrated as unknown as {
			userPropertyOrder: string[];
			userTypeOrder: string[];
			personaOrder: string[];
		};
		// Unkeyed flat entities order by uuid — there is no array to fall back to.
		expect(flat.userPropertyOrder).toEqual(["a-prop", "z-prop"]);
		// Keyed ones order by key.
		expect(flat.userTypeOrder).toEqual(["b-type", "m-type"]);
		expect(flat.personaOrder).toEqual([]);
	});

	it("strips every key it read", () => {
		const migrated = migrateInvisibly(
			fieldsDoc([
				["one", "V"],
				["two", "VV"],
			]),
		);
		for (const field of Object.values(migrated.fields)) {
			expect((field as { order?: string }).order).toBeUndefined();
		}
	});

	it("is idempotent", () => {
		const once = migrateDocToArrayOrder(
			fieldsDoc([
				["one", "V"],
				["two", "VV"],
				["three", "F"],
			]),
		);
		expect(migrateDocToArrayOrder(once)).toEqual(once);
	});

	it("leaves the input document untouched", () => {
		const input = fieldsDoc([
			["one", "V"],
			["two", "F"],
		]);
		const snapshot = structuredClone(input);
		migrateDocToArrayOrder(input);
		expect(input).toEqual(snapshot);
	});
});
