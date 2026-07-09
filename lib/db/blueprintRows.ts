// Blueprint ⇄ entity rows — the persistence projection behind `apps`.
//
// There is no blueprint blob: an app's current state is scalar columns on its
// `apps` row (name, connectType, caseTypes, logo) plus one `blueprint_entities`
// row per module/form/field. `assembleBlueprint` reconstructs the exact
// `PersistableDoc` (records + membership arrays by stored `ordinal`);
// `decomposeBlueprint` is its inverse; `diffBlueprints` computes the minimal
// row-set a committed batch actually changed, so a one-field edit writes one
// row. Round-trip fidelity (`assemble(decompose(doc)) ≡ doc`) is the invariant
// the unit tests pin — the commit gate, the validator, and the fold check all
// stand on it.
//
// The diff compares per-entity JSON (not mutation targets): a rename's prose
// cascade rewrites OTHER fields' text, so the mutation batch alone
// under-approximates the dirty set. Per-entity stringify of a bounded doc is
// the same cost the old whole-blob serialize paid, and it is correct for any
// reducer side effect by construction.

import type { PersistableDoc } from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain/blueprint";

export interface EntityRow {
	uuid: string;
	kind: "module" | "form" | "field";
	parent_uuid: string | null;
	ordinal: number;
	data: Record<string, unknown>;
}

/** The `apps`-row scalar slice of the doc (everything that isn't an entity). */
export interface BlueprintScalars {
	app_name: string;
	connect_type: PersistableDoc["connectType"];
	case_types: PersistableDoc["caseTypes"];
	logo: string | null;
}

export function blueprintScalars(doc: PersistableDoc): BlueprintScalars {
	return {
		app_name: doc.appName,
		connect_type: doc.connectType,
		case_types: doc.caseTypes,
		logo: doc.logo ?? null,
	};
}

/**
 * Decompose a persistable doc into its entity rows. Parentage comes from the
 * membership arrays (`formOrder` keyed by module, `fieldOrder` keyed by form
 * or container field); `ordinal` is the array index, so the arrays round-trip
 * exactly. A field present in `fields` but in no `fieldOrder` array (the
 * orphan the parent rebuild guards) persists with a null parent and rides
 * only the record map on assembly.
 */
export function decomposeBlueprint(doc: PersistableDoc): EntityRow[] {
	const rows: EntityRow[] = [];
	const placedModules = new Set<string>(doc.moduleOrder);
	const placedForms = new Set<string>(Object.values(doc.formOrder).flat());
	for (const uuid of Object.keys(doc.modules)) {
		if (!placedModules.has(uuid)) {
			throw new Error(
				`[decomposeBlueprint] module ${uuid} is in \`modules\` but absent from \`moduleOrder\` — refusing to persist a doc that would lose it.`,
			);
		}
	}
	for (const uuid of Object.keys(doc.forms)) {
		if (!placedForms.has(uuid)) {
			throw new Error(
				`[decomposeBlueprint] form ${uuid} is in \`forms\` but absent from every \`formOrder\` — refusing to persist a doc that would lose it.`,
			);
		}
	}
	doc.moduleOrder.forEach((uuid, i) => {
		const mod = doc.modules[uuid];
		if (mod) {
			rows.push({
				uuid,
				kind: "module",
				parent_uuid: null,
				ordinal: i,
				data: mod as unknown as Record<string, unknown>,
			});
		}
	});
	for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
		formUuids.forEach((uuid, i) => {
			const form = doc.forms[uuid];
			if (form) {
				rows.push({
					uuid,
					kind: "form",
					parent_uuid: moduleUuid,
					ordinal: i,
					data: form as unknown as Record<string, unknown>,
				});
			}
		});
	}
	const placedFields = new Set<string>();
	for (const [parentUuid, fieldUuids] of Object.entries(doc.fieldOrder)) {
		fieldUuids.forEach((uuid, i) => {
			const field = doc.fields[uuid];
			if (field) {
				placedFields.add(uuid);
				rows.push({
					uuid,
					kind: "field",
					parent_uuid: parentUuid,
					ordinal: i,
					data: field as unknown as Record<string, unknown>,
				});
			}
		});
	}
	// Orphans — in the record map but in no membership array.
	for (const [uuid, field] of Object.entries(doc.fields)) {
		if (!placedFields.has(uuid)) {
			rows.push({
				uuid,
				kind: "field",
				parent_uuid: null,
				ordinal: 0,
				data: field as unknown as Record<string, unknown>,
			});
		}
	}
	return rows;
}

/**
 * Reassemble the exact `PersistableDoc` from an app's scalar slice + entity
 * rows, Zod-validated at the boundary (the same validated-read guarantee the
 * old converter gave). Membership arrays rebuild by stored `ordinal`.
 */
export function assembleBlueprint(
	appId: string,
	scalars: BlueprintScalars,
	rows: readonly EntityRow[],
): PersistableDoc {
	const modules: Record<string, unknown> = {};
	const forms: Record<string, unknown> = {};
	const fields: Record<string, unknown> = {};
	const moduleRows: EntityRow[] = [];
	const formsByModule = new Map<string, EntityRow[]>();
	const fieldsByParent = new Map<string, EntityRow[]>();

	for (const row of rows) {
		if (row.kind === "module") {
			modules[row.uuid] = row.data;
			moduleRows.push(row);
		} else if (row.kind === "form") {
			forms[row.uuid] = row.data;
			if (row.parent_uuid !== null) {
				const list = formsByModule.get(row.parent_uuid) ?? [];
				list.push(row);
				formsByModule.set(row.parent_uuid, list);
			}
		} else {
			fields[row.uuid] = row.data;
			if (row.parent_uuid !== null) {
				const list = fieldsByParent.get(row.parent_uuid) ?? [];
				list.push(row);
				fieldsByParent.set(row.parent_uuid, list);
			}
		}
	}

	const byOrdinal = (a: EntityRow, b: EntityRow) => a.ordinal - b.ordinal;
	moduleRows.sort(byOrdinal);
	const formOrder: Record<string, string[]> = {};
	for (const [moduleUuid, list] of formsByModule) {
		list.sort(byOrdinal);
		formOrder[moduleUuid] = list.map((r) => r.uuid);
	}
	const fieldOrder: Record<string, string[]> = {};
	for (const [parentUuid, list] of fieldsByParent) {
		list.sort(byOrdinal);
		fieldOrder[parentUuid] = list.map((r) => r.uuid);
	}
	/* Reproduce the reducer's key-per-parent invariant: every module carries a
	 * `formOrder` key and every form + group/repeat container a `fieldOrder`
	 * key, EMPTY when childless (a case-list-only module has no form; a fresh
	 * container has no children). Decompose emits no row for an empty array,
	 * so without this seed an assembled doc and a reducer-built doc would
	 * differ in shape and a raw `doc.formOrder[m].length` would throw only
	 * after a reload. */
	for (const row of moduleRows) {
		formOrder[row.uuid] ??= [];
	}
	for (const [uuid, form] of Object.entries(forms)) {
		void form;
		fieldOrder[uuid] ??= [];
	}
	for (const [uuid, field] of Object.entries(fields)) {
		const kind = (field as { kind?: string }).kind;
		if (kind === "group" || kind === "repeat") {
			fieldOrder[uuid] ??= [];
		}
	}

	return blueprintDocSchema.parse({
		appId,
		appName: scalars.app_name,
		connectType: scalars.connect_type,
		caseTypes: scalars.case_types,
		modules,
		forms,
		fields,
		moduleOrder: moduleRows.map((r) => r.uuid),
		formOrder,
		fieldOrder,
		...(scalars.logo !== null && { logo: scalars.logo }),
	});
}

/** The minimal write-set between two docs' entity rows. */
export interface EntityDiff {
	upserts: EntityRow[];
	deletedUuids: string[];
}

/** Deterministic serialization for the entity diff: object keys sorted at
 *  every depth. Postgres jsonb does NOT preserve key order, so `prev` (read
 *  back from rows) and `next` (reducer output) can carry the same entity with
 *  different key order — a plain stringify would read every entity as dirty
 *  and rewrite the whole doc each commit. */
function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * Per-entity diff by identity + content. Rows whose `(kind, parent, ordinal,
 * data)` all match are untouched; everything else upserts, and uuids absent
 * from `next` delete. Content compares via key-order-insensitive
 * serialization (`stableStringify`) so a jsonb round-trip's key reordering
 * never reads as a change; a residual false positive only costs a redundant
 * row write — never a lost change.
 */
export function diffBlueprints(
	prev: PersistableDoc,
	next: PersistableDoc,
): EntityDiff {
	const prevRows = new Map(decomposeBlueprint(prev).map((r) => [r.uuid, r]));
	const nextRows = decomposeBlueprint(next);
	const upserts: EntityRow[] = [];
	const seen = new Set<string>();
	for (const row of nextRows) {
		seen.add(row.uuid);
		const before = prevRows.get(row.uuid);
		if (
			!before ||
			before.kind !== row.kind ||
			before.parent_uuid !== row.parent_uuid ||
			before.ordinal !== row.ordinal ||
			stableStringify(before.data) !== stableStringify(row.data)
		) {
			upserts.push(row);
		}
	}
	const deletedUuids = [...prevRows.keys()].filter((uuid) => !seen.has(uuid));
	return { upserts, deletedUuids };
}
