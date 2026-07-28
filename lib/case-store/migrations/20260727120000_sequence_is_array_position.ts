// Sequence stops being a key on the entity and becomes the entity's position.
//
// Every ordered collection used to carry a fractional `order` string, and the
// array or `ordinal` it sat in meant nothing: a same-parent reorder wrote only
// the moved entity's key and left the array untouched. So an app that has ever
// been reordered carries a stale `ordinal` and stale nested arrays, and simply
// reinterpreting position without this migration would silently reorder it —
// including its exported CommCare artifacts.
//
// This reads each collection's sequence through the comparators production used
// at the time (frozen below, deliberately copied rather than imported — an
// oracle that moves with the code it checks proves nothing, and the originals
// are deleted by the same change that adds this file), writes that exact
// sequence into `ordinal` and into the nested arrays, and strips the keys.
//
// Ties are frozen where they render. Two entities could share a key — a rested
// state the old model tolerated, and the defect this removes — and the old
// comparators broke that tie on uuid or on array position. Reading through them
// preserves today's rendering exactly, so the ambiguity disappears WITH the keys
// instead of being resolved differently.
//
// Case-list columns are the one collection that gains new keys: Results and
// Details are two independent sequences over one array of columns, and a single
// array cannot hold both, so `listColumnOrder` / `detailColumnOrder` are born
// here. Every column uuid appears in each exactly once regardless of
// visibility, so hiding and re-showing a column restores its place.
//
// THIS IS A MAINTENANCE CUTOVER, not a rolling migration. The migrate Job runs
// while the previous revision still serves, and that revision's module schema is
// strict — it rejects the two new column keys outright. Pause traffic for this
// execution and deploy the new revision immediately after, the same way the
// case-schema split cutover is run. Every other collection here stays readable
// by the old revision throughout (its backfill is position-seeded, so it
// re-derives exactly what this writes), so columns are the whole exposure.
//
// Replay-safe: a collection whose members carry no legacy key is already
// migrated and is left alone. That guard is load-bearing rather than defensive —
// the column comparators tie on uuid when both keys are absent, so a second pass
// without it would re-sort migrated columns into uuid order.

import { type Kysely, sql } from "kysely";

/** The stored shape this migration reads. Local on purpose: it describes what
 *  is in the database today, not what the application types will say next.
 *
 *  Exported, with `sequencesFromStoredRows` below, so the pre-migration scan can
 *  drive THIS code rather than a second copy of it — the whole risk in freezing
 *  a comparator is that the copy disagrees with the original, and a scan testing
 *  its own copy would prove nothing about what actually runs. */
export interface StoredEntityRow {
	app_id: string;
	uuid: string;
	kind: string;
	parent_uuid: string | null;
	ordinal: number;
	data: Record<string, unknown>;
}

interface LegacySortable {
	readonly uuid?: string;
	readonly order?: string;
}

interface LegacyColumn extends LegacySortable {
	readonly listOrder?: string;
	readonly detailOrder?: string;
}

function compareUuid(a: string | undefined, b: string | undefined): number {
	const x = a ?? "";
	const y = b ?? "";
	if (x < y) return -1;
	if (x > y) return 1;
	return 0;
}

/**
 * `lib/doc/order/compare.ts::bySortKey`, verbatim.
 *
 * Both keys absent compares EQUAL, which is what made a stable sort fall back to
 * array position. That fallback is why every caller below feeds its members in
 * stored order and relies on `Array.prototype.sort` being stable (guaranteed
 * since ES2019).
 */
function bySortKey(a: LegacySortable, b: LegacySortable): number {
	if (a.order !== undefined && b.order !== undefined) {
		if (a.order < b.order) return -1;
		if (a.order > b.order) return 1;
		return compareUuid(a.uuid, b.uuid);
	}
	if (a.order !== undefined) return -1;
	if (b.order !== undefined) return 1;
	return 0;
}

/**
 * `lib/doc/order/compare.ts::byListColumnOrder` / `byDetailColumnOrder`,
 * verbatim. The surface key wins; a legacy column falls back to its generic
 * `order`; absent-on-both ties on uuid — which is precisely why the caller must
 * not run this over an already-migrated column set.
 */
function byColumnOrder(
	a: LegacyColumn,
	b: LegacyColumn,
	key: "listOrder" | "detailOrder",
): number {
	const aOrder = a[key] ?? a.order;
	const bOrder = b[key] ?? b.order;
	if (aOrder !== undefined && bOrder !== undefined) {
		if (aOrder < bOrder) return -1;
		if (aOrder > bOrder) return 1;
		return compareUuid(a.uuid, b.uuid);
	}
	if (aOrder !== undefined) return -1;
	if (bOrder !== undefined) return 1;
	return compareUuid(a.uuid, b.uuid);
}

/**
 * `lib/domain/forms.ts::orderedCaseOperations`, verbatim — it ties on
 * `localeCompare` rather than raw `<`/`>`, which is a different sequence from
 * `bySortKey` for uuids that differ in case or by locale collation. Preserving
 * that difference is the point of copying it.
 */
function byCaseOperationOrder(a: LegacySortable, b: LegacySortable): number {
	if (a.order !== undefined && b.order !== undefined) {
		if (a.order < b.order) return -1;
		if (a.order > b.order) return 1;
		return (a.uuid ?? "").localeCompare(b.uuid ?? "");
	}
	if (a.order !== undefined) return -1;
	if (b.order !== undefined) return 1;
	return (a.uuid ?? "").localeCompare(b.uuid ?? "");
}

/**
 * The flat user collections' tie-break. They never had a membership array —
 * their sequence lived only in the key and their `ordinal` was a constant 0 —
 * so two keyless entities had no array position to fall back to and tied on
 * uuid instead.
 */
function byLegacyFlatOrder(a: LegacySortable, b: LegacySortable): number {
	if (a.order !== undefined && b.order !== undefined) {
		if (a.order < b.order) return -1;
		if (a.order > b.order) return 1;
	} else if (a.order !== undefined) {
		return -1;
	} else if (b.order !== undefined) {
		return 1;
	}
	return compareUuid(a.uuid, b.uuid);
}

const FLAT_KINDS = new Set(["user_property", "user_type", "persona"]);

/** True when nothing in the collection carries a legacy key — already migrated. */
function alreadyMigrated(
	members: readonly LegacyColumn[],
	keys: readonly ("order" | "listOrder" | "detailOrder")[] = ["order"],
): boolean {
	return !members.some((m) => keys.some((k) => m[k] !== undefined));
}

function stripKeys(entity: Record<string, unknown>): void {
	delete entity.order;
	delete entity.listOrder;
	delete entity.detailOrder;
}

function asRecordArray(value: unknown): Record<string, unknown>[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value as Record<string, unknown>[];
}

/**
 * Rewrite one entity's nested collections in place. Returns true when anything
 * changed, so the caller can write only the rows that need it.
 */
function migrateNested(kind: string, data: Record<string, unknown>): boolean {
	let changed = false;

	if (data.order !== undefined) {
		delete data.order;
		changed = true;
	}

	if (kind === "module") {
		const config = data.caseListConfig as Record<string, unknown> | undefined;
		if (config !== undefined && config !== null) {
			const columns = asRecordArray(config.columns);
			if (
				columns !== undefined &&
				config.listColumnOrder === undefined &&
				!alreadyMigrated(columns as LegacyColumn[], [
					"order",
					"listOrder",
					"detailOrder",
				])
			) {
				config.listColumnOrder = [...columns]
					.sort((a, b) =>
						byColumnOrder(a as LegacyColumn, b as LegacyColumn, "listOrder"),
					)
					.map((c) => c.uuid);
				config.detailColumnOrder = [...columns]
					.sort((a, b) =>
						byColumnOrder(a as LegacyColumn, b as LegacyColumn, "detailOrder"),
					)
					.map((c) => c.uuid);
				for (const column of columns) stripKeys(column);
				changed = true;
			}
			const inputs = asRecordArray(config.searchInputs);
			if (
				inputs !== undefined &&
				!alreadyMigrated(inputs as LegacySortable[])
			) {
				config.searchInputs = [...inputs].sort((a, b) =>
					bySortKey(a as LegacySortable, b as LegacySortable),
				);
				for (const input of config.searchInputs as Record<string, unknown>[]) {
					stripKeys(input);
				}
				changed = true;
			}
		}
	}

	if (kind === "form") {
		const operations = asRecordArray(data.caseOperations);
		if (
			operations !== undefined &&
			!alreadyMigrated(operations as LegacySortable[])
		) {
			data.caseOperations = [...operations].sort((a, b) =>
				byCaseOperationOrder(a as LegacySortable, b as LegacySortable),
			);
			for (const operation of data.caseOperations as Record<
				string,
				unknown
			>[]) {
				stripKeys(operation);
			}
			changed = true;
		}
	}

	if (kind === "field") {
		const options = asRecordArray(data.options);
		if (
			options !== undefined &&
			!alreadyMigrated(options as LegacySortable[])
		) {
			data.options = [...options].sort((a, b) =>
				bySortKey(a as LegacySortable, b as LegacySortable),
			);
			for (const option of data.options as Record<string, unknown>[]) {
				stripKeys(option);
			}
			changed = true;
		}
	}

	return changed;
}

/**
 * Every ordered sequence the given app's rows describe, keyed by the same paths
 * `derivedSequences` uses so the two can be compared directly.
 *
 * `sorted: true` derives the sequence through the frozen comparators — what this
 * migration will decide. `sorted: false` reads plain array position with no
 * comparator at all — what every reader does once the keys are gone. Running
 * both around the migration is the proof that it changed nothing.
 */
export function sequencesFromStoredRows(
	rows: readonly StoredEntityRow[],
	options: { readonly sorted: boolean },
): Map<string, string[]> {
	const out = new Map<string, string[]>();
	const buckets = new Map<string, StoredEntityRow[]>();
	for (const row of rows) {
		const key = `${row.kind} ${row.parent_uuid ?? ""}`;
		const bucket = buckets.get(key);
		if (bucket === undefined) buckets.set(key, [row]);
		else bucket.push(row);
	}

	/** Order a bucket the way the requested mode says, then name its uuids. */
	const sequence = (
		bucket: readonly StoredEntityRow[],
		compare: (a: LegacySortable, b: LegacySortable) => number,
	): string[] => {
		const sortables = bucket.map((row) => ({
			uuid: row.uuid,
			order: row.data.order as string | undefined,
		}));
		const ordered =
			options.sorted && !alreadyMigrated(sortables)
				? [...sortables].sort(compare)
				: sortables;
		return ordered.map((s) => s.uuid);
	};

	/**
	 * The same for a nested array living inside one entity's payload.
	 *
	 * A member with no `uuid` gets a label from its position BEFORE the sort.
	 * Legacy select options are the real case — they predate option uuids, and
	 * naming them `undefined` would make every one of them look identical to
	 * every other, so a reordering among them would be invisible here.
	 */
	const nested = (
		members: readonly Record<string, unknown>[],
		compare: (a: LegacySortable, b: LegacySortable) => number,
	): string[] => {
		const labelled = members.map((m, i) => ({
			...m,
			uuid: (m.uuid as string | undefined) ?? `@${i}`,
		}));
		const ordered =
			options.sorted && !alreadyMigrated(labelled as readonly LegacyColumn[])
				? [...labelled].sort((a, b) =>
						compare(a as LegacySortable, b as LegacySortable),
					)
				: labelled;
		return ordered.map((m) => m.uuid);
	};

	for (const [key, bucket] of buckets) {
		const [kind, parent] = [
			key.slice(0, key.indexOf(" ")),
			key.slice(key.indexOf(" ") + 1),
		];
		if (kind === "module") out.set("modules", sequence(bucket, bySortKey));
		else if (kind === "form") {
			out.set(`forms:${parent}`, sequence(bucket, bySortKey));
		} else if (kind === "field" && parent !== "") {
			out.set(`fields:${parent}`, sequence(bucket, bySortKey));
		} else if (kind === "user_property") {
			out.set("userProperties", sequence(bucket, byLegacyFlatOrder));
		} else if (kind === "user_type") {
			out.set("userTypes", sequence(bucket, byLegacyFlatOrder));
		} else if (kind === "persona") {
			out.set("personas", sequence(bucket, byLegacyFlatOrder));
		}
	}

	for (const row of rows) {
		const data = row.data;
		if (row.kind === "module") {
			const config = data.caseListConfig as Record<string, unknown> | undefined;
			if (config === undefined || config === null) continue;
			const columns = asRecordArray(config.columns);
			if (columns !== undefined) {
				// Post-migration the two orders are stored arrays; pre-migration they
				// are two sorts over the one `columns` array.
				const listOrder = config.listColumnOrder as string[] | undefined;
				const detailOrder = config.detailColumnOrder as string[] | undefined;
				out.set(
					`columns:list:${row.uuid}`,
					!options.sorted && listOrder !== undefined
						? [...listOrder]
						: [...columns]
								.sort((a, b) =>
									byColumnOrder(
										a as LegacyColumn,
										b as LegacyColumn,
										"listOrder",
									),
								)
								.map((c) => c.uuid as string),
				);
				out.set(
					`columns:detail:${row.uuid}`,
					!options.sorted && detailOrder !== undefined
						? [...detailOrder]
						: [...columns]
								.sort((a, b) =>
									byColumnOrder(
										a as LegacyColumn,
										b as LegacyColumn,
										"detailOrder",
									),
								)
								.map((c) => c.uuid as string),
				);
			}
			const inputs = asRecordArray(config.searchInputs);
			if (inputs !== undefined) {
				out.set(`searchInputs:${row.uuid}`, nested(inputs, bySortKey));
			}
		} else if (row.kind === "form") {
			const operations = asRecordArray(data.caseOperations);
			if (operations !== undefined) {
				out.set(
					`caseOperations:${row.uuid}`,
					nested(operations, byCaseOperationOrder),
				);
			}
		} else if (row.kind === "field") {
			const options_ = asRecordArray(data.options);
			if (options_ !== undefined) {
				out.set(`options:${row.uuid}`, nested(options_, bySortKey));
			}
		}
	}

	return out;
}

export async function up(db: Kysely<unknown>): Promise<void> {
	// Stored order is the input to the array-position fallback, so `ordinal` must
	// lead the row order. `uuid` makes the read total for the flat kinds, whose
	// `ordinal` was a constant 0.
	const result = await sql<StoredEntityRow>`
		SELECT app_id, uuid, kind, parent_uuid, ordinal, data
		FROM blueprint_entities
		ORDER BY app_id, kind, parent_uuid NULLS FIRST, ordinal, uuid
	`.execute(db);

	// Bucket by the collection an entity's position is relative to. The flat
	// kinds have a null parent, so the kind alone separates them.
	const buckets = new Map<string, StoredEntityRow[]>();
	for (const row of result.rows) {
		const key = `${row.app_id} ${row.kind} ${row.parent_uuid ?? ""}`;
		const bucket = buckets.get(key);
		if (bucket === undefined) buckets.set(key, [row]);
		else bucket.push(row);
	}

	const updates = new Map<string, { ordinal: number; data: unknown }>();
	const stage = (row: StoredEntityRow, ordinal: number): void => {
		updates.set(`${row.app_id} ${row.uuid}`, { ordinal, data: row.data });
	};

	for (const bucket of buckets.values()) {
		const kind = bucket[0].kind;
		const sortables = bucket.map((row) => ({
			row,
			uuid: row.uuid,
			order: row.data.order as string | undefined,
		}));

		// A bucket whose members carry no key is already migrated: its stored
		// ordinals ARE the sequence, and re-sorting would only risk moving them.
		const sequenced = alreadyMigrated(sortables)
			? sortables
			: [...sortables].sort(
					FLAT_KINDS.has(kind) ? byLegacyFlatOrder : bySortKey,
				);

		sequenced.forEach((entry, index) => {
			const nestedChanged = migrateNested(kind, entry.row.data);
			if (nestedChanged || entry.row.ordinal !== index) {
				stage(entry.row, index);
			}
		});
	}

	for (const [key, { ordinal, data }] of updates) {
		const [appId, uuid] = key.split(" ");
		await sql`
			UPDATE blueprint_entities
			SET ordinal = ${ordinal}, data = ${JSON.stringify(data)}::jsonb
			WHERE app_id = ${appId} AND uuid = ${uuid}
		`.execute(db);
	}
}

export async function down(): Promise<void> {
	// Intentionally empty. The prior state stored a sequence in fractional keys
	// that no deployed reader understands any more; recreating it would mint keys
	// this change exists to delete.
}
