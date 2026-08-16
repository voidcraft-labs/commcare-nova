// Blueprint ⇄ entity rows — the persistence projection behind `apps`.
//
// There is no blueprint blob: an app's current state is scalar columns on its
// `apps` row (name, connectType, caseTypes, localization, logo) plus one `blueprint_entities`
// row per hierarchical or flat authored entity. `assembleBlueprint` reconstructs the exact
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

import {
	asUuid,
	ownRecordValue,
	type PersistableDoc,
	recordWithValue,
	type Uuid,
} from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain/blueprint";

export interface EntityRow {
	uuid: Uuid;
	kind: EntityRowKind;
	parent_uuid: Uuid | null;
	ordinal: number;
	data: Record<string, unknown>;
}

/**
 * The entity kinds a blueprint decomposes into.
 *
 * The first three carry the runnable app and encode their hierarchy in
 * `(parent_uuid, ordinal)`. The final collections are flat app-level catalogs
 * (users, organization, and automations): they have no parent, so they persist with a null
 * parent, but their `ordinal` is real — it IS their sequence, the same as
 * every other collection.
 */
export type EntityRowKind =
	| "module"
	| "form"
	| "field"
	| "user_property"
	| "user_type"
	| "persona"
	| "organization_level"
	| "location_property"
	| "automation";

/** Which doc slot each flat user collection round-trips through. */
const FLAT_COLLECTIONS = [
	["user_property", "userProperties", "userPropertyOrder"],
	["user_type", "userTypes", "userTypeOrder"],
	["persona", "personas", "personaOrder"],
	["organization_level", "organizationLevels", "organizationLevelOrder"],
	["location_property", "locationProperties", "locationPropertyOrder"],
	["automation", "automations", "automationOrder"],
] as const satisfies readonly (readonly [
	EntityRowKind,
	(
		| "userProperties"
		| "userTypes"
		| "personas"
		| "organizationLevels"
		| "locationProperties"
		| "automations"
	),
	(
		| "userPropertyOrder"
		| "userTypeOrder"
		| "personaOrder"
		| "organizationLevelOrder"
		| "locationPropertyOrder"
		| "automationOrder"
	),
])[];

/** The `apps`-row scalar slice of the doc (everything that isn't an entity). */
export interface BlueprintScalars {
	app_name: string;
	connect_type: PersistableDoc["connectType"];
	case_types: PersistableDoc["caseTypes"];
	localization: PersistableDoc["localization"];
	logo: string | null;
}

export function blueprintScalars(doc: PersistableDoc): BlueprintScalars {
	return {
		app_name: doc.appName,
		connect_type: doc.connectType,
		case_types: doc.caseTypes,
		localization: doc.localization,
		logo: doc.logo ?? null,
	};
}

/**
 * Decompose a persistable doc into its entity rows. Parentage comes from the
 * membership arrays (`formOrder` keyed by module, `fieldOrder` keyed by form
 * or container field); `ordinal` is the array index, so the arrays round-trip
 * exactly. The domain parser closes topology before row construction: every
 * entity is present exactly once in its owning sequence, every parent is the
 * expected kind, and no orphan row can be constructed.
 */
export function decomposeBlueprint(doc: PersistableDoc): EntityRow[] {
	const canonicalDoc = blueprintDocSchema.parse(doc);
	const rows: EntityRow[] = [];
	canonicalDoc.moduleOrder.forEach((uuid, i) => {
		const mod = ownRecordValue(canonicalDoc.modules, uuid);
		if (mod === undefined) {
			throw new Error(
				`[decomposeBlueprint] validated module ${uuid} is unavailable.`,
			);
		}
		rows.push({
			uuid,
			kind: "module",
			parent_uuid: null,
			ordinal: i,
			data: mod as unknown as Record<string, unknown>,
		});
	});
	for (const [moduleUuid, formUuids] of Object.entries(
		canonicalDoc.formOrder,
	)) {
		formUuids.forEach((uuid, i) => {
			const form = ownRecordValue(canonicalDoc.forms, uuid);
			if (form === undefined) {
				throw new Error(
					`[decomposeBlueprint] validated form ${uuid} is unavailable.`,
				);
			}
			rows.push({
				uuid,
				kind: "form",
				parent_uuid: asUuid(moduleUuid),
				ordinal: i,
				data: form as unknown as Record<string, unknown>,
			});
		});
	}
	for (const [parentUuid, fieldUuids] of Object.entries(
		canonicalDoc.fieldOrder,
	)) {
		fieldUuids.forEach((uuid, i) => {
			const field = ownRecordValue(canonicalDoc.fields, uuid);
			if (field === undefined) {
				throw new Error(
					`[decomposeBlueprint] validated field ${uuid} is unavailable.`,
				);
			}
			rows.push({
				uuid,
				kind: "field",
				parent_uuid: asUuid(parentUuid),
				ordinal: i,
				data: field as unknown as Record<string, unknown>,
			});
		});
	}
	for (const [kind, slot, orderSlot] of FLAT_COLLECTIONS) {
		const record = canonicalDoc[slot] ?? {};
		const sequence = canonicalDoc[orderSlot] ?? [];
		sequence.forEach((uuid, ordinal) => {
			const entity = ownRecordValue(
				record as Readonly<Record<string, unknown>>,
				uuid,
			);
			if (entity === undefined) {
				throw new Error(
					`[decomposeBlueprint] validated ${kind} ${uuid} is unavailable.`,
				);
			}
			rows.push({
				uuid,
				kind,
				parent_uuid: null,
				// The array position IS the sequence, so it is what persists.
				ordinal,
				data: entity as unknown as Record<string, unknown>,
			});
		});
	}
	const seen = new Map<string, EntityRowKind>();
	for (const row of rows) {
		const previousKind = seen.get(row.uuid);
		if (previousKind !== undefined) {
			throw new Error(
				`[decomposeBlueprint] duplicate entity uuid ${row.uuid} appears as both ${previousKind} and ${row.kind}; refusing to collapse two entities into one durable row.`,
			);
		}
		seen.set(row.uuid, row.kind);
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
	let modules: Record<string, unknown> = {};
	let forms: Record<string, unknown> = {};
	let fields: Record<string, unknown> = {};
	/* Derived from `FLAT_COLLECTIONS`, never hand-listed beside it: a kind
	 * added to the table but missed in a literal initializer would leave its
	 * accumulator absent, so every row of that kind would be dropped while
	 * the classifier below still looked correct — a silent loss, which is the
	 * one failure mode this projection must not have. */
	const flat: Record<string, Record<string, unknown>> = Object.fromEntries(
		FLAT_COLLECTIONS.map(([, slot]) => [slot, {}]),
	);
	const flatSlotByKind = new Map<string, string>(
		FLAT_COLLECTIONS.map(([kind, slot]) => [kind, slot]),
	);
	/* Rows per flat kind, kept so the membership arrays rebuild from the stored
	 * `ordinal` exactly as `moduleOrder` and `formOrder` do. The record alone
	 * cannot carry sequence — that is the whole reason the array exists. */
	const flatRowsBySlot = new Map<string, EntityRow[]>();
	const moduleRows: EntityRow[] = [];
	const formsByModule = new Map<string, EntityRow[]>();
	const fieldsByParent = new Map<string, EntityRow[]>();

	for (const row of rows) {
		// Every kind branches explicitly. Falling through to `fields` was the
		// old shape's default and is exactly the trap a new kind would spring:
		// a persona read as a field parses as neither, and the whole app stops
		// loading rather than losing one row.
		const flatSlot = flatSlotByKind.get(row.kind);
		if (flatSlot !== undefined) {
			if (row.parent_uuid !== null) {
				throw new Error(
					`Blueprint flat entity ${row.uuid} (${row.kind}) has unexpected parent ${row.parent_uuid}.`,
				);
			}
			const collection = flat[flatSlot];
			if (collection !== undefined) {
				flat[flatSlot] = recordWithValue(
					collection as Record<string, Record<string, unknown>>,
					row.uuid,
					row.data,
				);
				const list = flatRowsBySlot.get(flatSlot) ?? [];
				list.push(row);
				flatRowsBySlot.set(flatSlot, list);
			}
		} else if (row.kind === "module") {
			modules = recordWithValue<unknown>(modules, row.uuid, row.data);
			moduleRows.push(row);
		} else if (row.kind === "form") {
			forms = recordWithValue<unknown>(forms, row.uuid, row.data);
			if (row.parent_uuid !== null) {
				const list = formsByModule.get(row.parent_uuid) ?? [];
				list.push(row);
				formsByModule.set(row.parent_uuid, list);
			}
		} else if (row.kind === "field") {
			fields = recordWithValue<unknown>(fields, row.uuid, row.data);
			if (row.parent_uuid !== null) {
				const list = fieldsByParent.get(row.parent_uuid) ?? [];
				list.push(row);
				fieldsByParent.set(row.parent_uuid, list);
			}
		} else {
			throw new Error(
				`[assembleBlueprint] unsupported entity row kind ${String(row.kind)}.`,
			);
		}
	}

	const byOrdinal = (a: EntityRow, b: EntityRow) => a.ordinal - b.ordinal;
	moduleRows.sort(byOrdinal);
	let formOrder: Record<string, Uuid[]> = {};
	for (const [moduleUuid, list] of formsByModule) {
		list.sort(byOrdinal);
		formOrder = recordWithValue(
			formOrder,
			moduleUuid,
			list.map((r) => r.uuid),
		);
	}
	let fieldOrder: Record<string, Uuid[]> = {};
	for (const [parentUuid, list] of fieldsByParent) {
		list.sort(byOrdinal);
		fieldOrder = recordWithValue(
			fieldOrder,
			parentUuid,
			list.map((r) => r.uuid),
		);
	}
	/* Reproduce the reducer's key-per-parent invariant: every module carries a
	 * `formOrder` key and every form + group/repeat container a `fieldOrder`
	 * key, EMPTY when childless (a case-list-only module has no form; a fresh
	 * container has no children). Decompose emits no row for an empty array,
	 * so without this seed an assembled doc and a reducer-built doc would
	 * differ in shape and a raw `doc.formOrder[m].length` would throw only
	 * after a reload. */
	for (const row of moduleRows) {
		if (!Object.hasOwn(formOrder, row.uuid)) {
			formOrder = recordWithValue<Uuid[]>(formOrder, row.uuid, []);
		}
	}
	for (const [uuid, form] of Object.entries(forms)) {
		void form;
		if (!Object.hasOwn(fieldOrder, uuid)) {
			fieldOrder = recordWithValue<Uuid[]>(fieldOrder, uuid, []);
		}
	}
	for (const [uuid, field] of Object.entries(fields)) {
		const kind = (field as { kind?: string }).kind;
		if (
			(kind === "group" || kind === "repeat") &&
			!Object.hasOwn(fieldOrder, uuid)
		) {
			fieldOrder = recordWithValue<Uuid[]>(fieldOrder, uuid, []);
		}
	}

	return blueprintDocSchema.parse({
		appId,
		appName: scalars.app_name,
		connectType: scalars.connect_type,
		caseTypes: scalars.case_types,
		...(scalars.localization !== undefined && {
			localization: scalars.localization,
		}),
		modules,
		forms,
		fields,
		moduleOrder: moduleRows.map((r) => r.uuid),
		formOrder,
		fieldOrder,
		...(scalars.logo !== null && { logo: scalars.logo }),
		/* Omitted when empty, so an app that declares no user properties,
		 * types, or personas assembles to exactly the doc it did before those
		 * collections existed — the same shape `logo` keeps for an app with no
		 * logo. Every reader takes absent as empty, so the two shapes would
		 * otherwise be a distinction without a difference that still diffed. */
		...Object.fromEntries(
			Object.entries(flat).filter(
				([, collection]) => Object.keys(collection).length > 0,
			),
		),
		/* The membership array rebuilds from the stored `ordinal`, the same way
		 * `moduleOrder` does above — the record's key iteration order is not a
		 * sequence and must never be mistaken for one. Omitted alongside its
		 * record when the collection is empty. */
		...Object.fromEntries(
			FLAT_COLLECTIONS.flatMap(([, slot, orderSlot]) => {
				const flatRows = flatRowsBySlot.get(slot) ?? [];
				if (flatRows.length === 0) return [];
				const sequence = [...flatRows]
					.sort((a, b) => a.ordinal - b.ordinal)
					.map((row) => row.uuid);
				return [[orderSlot, sequence] as const];
			}),
		),
	});
}

/** The minimal write-set between two docs' entity rows. */
export interface EntityDiff {
	upserts: EntityRow[];
	deletedUuids: Uuid[];
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
