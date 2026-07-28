/**
 * The sequence migration's frozen comparators, pinned.
 *
 * `20260727120000_sequence_is_array_position.ts` copies the four comparators
 * production sorted through, because the change that adds it deletes the
 * originals. A frozen copy is only useful if it stays faithful, and once the
 * originals are gone nothing else can prove that — so the behaviours worth
 * keeping are written down here.
 *
 * The fleet-wide proof ran BEFORE the conversion, against the live comparators
 * on real data: 380/380 production apps across 10,087 collections, and
 * 1021/1021 local apps across 12,281, with zero disagreements. That run is what
 * these cases stand in for now that its oracle no longer exists.
 */

import { describe, expect, it } from "vitest";
import {
	type StoredEntityRow,
	sequencesFromStoredRows,
} from "../20260727120000_sequence_is_array_position";

function row(
	partial: Partial<StoredEntityRow> & Pick<StoredEntityRow, "uuid" | "kind">,
): StoredEntityRow {
	return {
		app_id: "app",
		parent_uuid: null,
		ordinal: 0,
		data: {},
		...partial,
	};
}

const modules = (rows: StoredEntityRow[]): readonly string[] | undefined =>
	sequencesFromStoredRows(rows, { sorted: true }).get("modules");

describe("sequencesFromStoredRows", () => {
	it("orders modules by key, not by stored ordinal", () => {
		// The defect the migration exists for: a reorder wrote only the key, so
		// the ordinal is stale and disagrees with what the app renders.
		expect(
			modules([
				row({ uuid: "a", kind: "module", ordinal: 0, data: { order: "c" } }),
				row({ uuid: "b", kind: "module", ordinal: 1, data: { order: "a" } }),
			]),
		).toEqual(["b", "a"]);
	});

	it("falls back to stored ordinal when nothing carries a key", () => {
		// `bySortKey` returned 0 for two keyless entities and a stable sort left
		// them in array position. Losing that would reorder every legacy app.
		expect(
			modules([
				row({ uuid: "a", kind: "module", ordinal: 0 }),
				row({ uuid: "b", kind: "module", ordinal: 1 }),
			]),
		).toEqual(["a", "b"]);
	});

	it("sorts a keyed entity ahead of a keyless one", () => {
		expect(
			modules([
				row({ uuid: "a", kind: "module", ordinal: 0 }),
				row({ uuid: "b", kind: "module", ordinal: 1, data: { order: "z" } }),
			]),
		).toEqual(["b", "a"]);
	});

	it("breaks a tied key on uuid, freezing how that tie renders today", () => {
		// Two entities sharing a key is the rested state this whole change
		// removes. The migration must preserve how it renders, not resolve it.
		expect(
			modules([
				row({ uuid: "b", kind: "module", ordinal: 0, data: { order: "m" } }),
				row({ uuid: "a", kind: "module", ordinal: 1, data: { order: "m" } }),
			]),
		).toEqual(["a", "b"]);
	});

	it("ties flat user collections on uuid, never on ordinal", () => {
		// Those rows stored a constant 0, so a tied key had no array position to
		// fall back to — the one place the tie-break genuinely differs from
		// `bySortKey`, which returned 0 and let a stable sort decide.
		const seq = sequencesFromStoredRows(
			[
				row({ uuid: "b", kind: "persona", data: { order: "m" } }),
				row({ uuid: "a", kind: "persona", data: { order: "m" } }),
			],
			{ sorted: true },
		);
		expect(seq.get("personas")).toEqual(["a", "b"]);
	});

	it("leaves a keyless flat collection in stored order", () => {
		// Nothing carrying a key means the collection is already migrated, so its
		// ordinals ARE the sequence. Applying the uuid tie-break here would
		// scramble it — the same replay hazard the column guard exists for.
		const seq = sequencesFromStoredRows(
			[
				row({ uuid: "b", kind: "persona", ordinal: 0 }),
				row({ uuid: "a", kind: "persona", ordinal: 1 }),
			],
			{ sorted: true },
		);
		expect(seq.get("personas")).toEqual(["b", "a"]);
	});

	it("reads Results and Details as two sequences over one column set", () => {
		const seq = sequencesFromStoredRows(
			[
				row({
					uuid: "m",
					kind: "module",
					data: {
						caseListConfig: {
							columns: [
								{ uuid: "c1", listOrder: "b", detailOrder: "a" },
								{ uuid: "c2", listOrder: "a", detailOrder: "b" },
							],
							searchInputs: [],
						},
					},
				}),
			],
			{ sorted: true },
		);
		expect(seq.get("columns:list:m")).toEqual(["c2", "c1"]);
		expect(seq.get("columns:detail:m")).toEqual(["c1", "c2"]);
	});

	it("falls a column back to its generic key when a surface key is absent", () => {
		const seq = sequencesFromStoredRows(
			[
				row({
					uuid: "m",
					kind: "module",
					data: {
						caseListConfig: {
							columns: [
								{ uuid: "c1", order: "b" },
								{ uuid: "c2", order: "a" },
							],
							searchInputs: [],
						},
					},
				}),
			],
			{ sorted: true },
		);
		expect(seq.get("columns:list:m")).toEqual(["c2", "c1"]);
	});

	it("ties case operations by locale collation, not raw comparison", () => {
		// `orderedCaseOperations` used `localeCompare`, which disagrees with the
		// other comparators for uuids differing only in case.
		const seq = sequencesFromStoredRows(
			[
				row({
					uuid: "f",
					kind: "form",
					data: {
						caseOperations: [
							{ uuid: "B", order: "m" },
							{ uuid: "a", order: "m" },
						],
					},
				}),
			],
			{ sorted: true },
		);
		expect(seq.get("caseOperations:f")).toEqual(["a", "B"]);
	});

	it("labels uuid-less legacy options by position so a reorder stays visible", () => {
		const seq = sequencesFromStoredRows(
			[
				row({
					uuid: "fld",
					kind: "field",
					data: { options: [{ value: "x" }, { value: "y" }] },
				}),
			],
			{ sorted: true },
		);
		expect(seq.get("options:fld")).toEqual(["@0", "@1"]);
	});

	it("reads an already-migrated collection as plain array position", () => {
		// Replay-safety: the column comparators tie on uuid once both keys are
		// absent, so a second pass that re-sorted would scramble migrated columns.
		const seq = sequencesFromStoredRows(
			[
				row({ uuid: "b", kind: "module", ordinal: 0 }),
				row({ uuid: "a", kind: "module", ordinal: 1 }),
			],
			{ sorted: false },
		);
		expect(seq.get("modules")).toEqual(["b", "a"]);
	});
});
