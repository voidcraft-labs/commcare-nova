/**
 * The one-off transform that moves a blueprint from fractional order keys to
 * array position, plus the oracle that proves it changed nothing anyone can see.
 *
 * Every ordered collection in a stored document is currently a MEMBERSHIP set
 * whose array position is meaningless: a same-parent reorder writes only the
 * moved entity's `order` key and leaves the array untouched, so an app that has
 * ever been reordered has stale `ordinal` values and stale nested arrays. That
 * is why this migration exists and why reinterpreting position without it would
 * silently reorder every such app, including its exported CommCare artifacts.
 *
 * The transform reads the sequence through the CURRENT production comparators —
 * the same ones every reader, emitter, and preview surface uses today — and
 * writes that exact sequence into the arrays. The keys then carry no information
 * and are stripped.
 *
 * `derivedSequences` is the oracle. It captures what the document displays
 * BEFORE the transform; comparing it against the migrated arrays afterwards
 * proves the migration is invisible. That equality is the acceptance bar,
 * because every emitter consumes the sequence and drops the key, so an identical
 * sequence is an identical compile.
 *
 * Ties are frozen where they render. Two entities can share a key — a documented
 * rested state, and the defect this whole change removes — and today's
 * comparators break that tie on uuid. Reading the sequence through those
 * comparators therefore preserves the tie's current rendering exactly, and the
 * ambiguity disappears with the keys rather than being resolved differently.
 */

import {
	byDetailColumnOrder,
	byFlatEntitySortKey,
	byListColumnOrder,
	bySortKey,
} from "@/lib/doc/order/compare";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { orderedCaseOperations } from "@/lib/domain";

/**
 * Every ordered sequence a document displays, keyed by a stable path so the
 * before/after comparison can name exactly which collection diverged.
 *
 * Keys are `modules`, `forms:<moduleUuid>`, `fields:<parentUuid>`,
 * `columns:list:<moduleUuid>`, `columns:detail:<moduleUuid>`,
 * `searchInputs:<moduleUuid>`, `caseOperations:<formUuid>`,
 * `options:<fieldUuid>`, `userProperties`, `userTypes`, `personas`.
 */
export type DerivedSequences = ReadonlyMap<string, readonly Uuid[]>;

function sortedUuids<T extends { uuid?: string; order?: string }>(
	entities: readonly T[],
	compare: (a: T, b: T) => number,
): Uuid[] {
	return [...entities].sort(compare).map((e) => e.uuid as Uuid);
}

function resolveAll<T>(
	uuids: readonly string[],
	lookup: (uuid: string) => T | undefined,
): T[] {
	const out: T[] = [];
	for (const uuid of uuids) {
		const entity = lookup(uuid);
		if (entity !== undefined) out.push(entity);
	}
	return out;
}

/**
 * Read every displayed sequence out of a document using today's comparators.
 *
 * Deliberately duplicates the readers rather than calling `orderedFieldUuids`
 * and friends: those are about to change meaning, and an oracle that moves with
 * the code it is checking proves nothing.
 */
export function derivedSequences(doc: BlueprintDoc): DerivedSequences {
	const out = new Map<string, readonly Uuid[]>();

	out.set(
		"modules",
		sortedUuids(
			resolveAll(doc.moduleOrder, (u) => doc.modules[u]),
			bySortKey,
		),
	);

	for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
		out.set(
			`forms:${moduleUuid}`,
			sortedUuids(
				resolveAll(formUuids, (u) => doc.forms[u]),
				bySortKey,
			),
		);
	}

	for (const [parentUuid, fieldUuids] of Object.entries(doc.fieldOrder)) {
		out.set(
			`fields:${parentUuid}`,
			sortedUuids(
				resolveAll(fieldUuids, (u) => doc.fields[u]),
				bySortKey,
			),
		);
	}

	for (const module of Object.values(doc.modules)) {
		const config = module.caseListConfig;
		if (config === undefined) continue;
		// Results and Details are two independent sequences over one array, which
		// is why the migrated document needs two arrays rather than one.
		out.set(
			`columns:list:${module.uuid}`,
			sortedUuids(config.columns, byListColumnOrder),
		);
		out.set(
			`columns:detail:${module.uuid}`,
			sortedUuids(config.columns, byDetailColumnOrder),
		);
		out.set(
			`searchInputs:${module.uuid}`,
			sortedUuids(config.searchInputs, bySortKey),
		);
	}

	for (const form of Object.values(doc.forms)) {
		if (form.caseOperations === undefined) continue;
		out.set(
			`caseOperations:${form.uuid}`,
			orderedCaseOperations(form).map((op) => op.uuid as Uuid),
		);
	}

	for (const field of Object.values(doc.fields)) {
		if (!("options" in field) || !Array.isArray(field.options)) continue;
		out.set(`options:${field.uuid}`, sortedUuids(field.options, bySortKey));
	}

	// The flat collections have no membership array today — their sequence lives
	// only in the key, which is exactly why they need one after this.
	out.set(
		"userProperties",
		sortedUuids(Object.values(doc.userProperties ?? {}), byFlatEntitySortKey),
	);
	out.set(
		"userTypes",
		sortedUuids(Object.values(doc.userTypes ?? {}), byFlatEntitySortKey),
	);
	out.set(
		"personas",
		sortedUuids(Object.values(doc.personas ?? {}), byFlatEntitySortKey),
	);

	return out;
}

/**
 * Rewrite every ordered collection into the sequence the document currently
 * displays, then strip the keys. Returns a new document; the input is untouched.
 *
 * The two case-list ordering arrays are born here rather than derived later,
 * because Results and Details are genuinely two sequences over one set of
 * columns and a single array cannot hold both. Every column uuid appears in each
 * array exactly once regardless of visibility, so hiding and re-showing a column
 * restores its position.
 *
 * The three flat collections gain membership arrays for the first time. They had
 * none — their sequence lived only in the key — so stripping the key without
 * this would destroy their ordering outright.
 */
export function migrateDocToArrayOrder(doc: BlueprintDoc): BlueprintDoc {
	const sequences = derivedSequences(doc);
	const next = structuredClone(doc) as BlueprintDoc & Record<string, unknown>;
	const seq = (path: string): Uuid[] => [...(sequences.get(path) ?? [])];
	const strip = (entity: Record<string, unknown>): void => {
		delete entity.order;
		delete entity.listOrder;
		delete entity.detailOrder;
	};

	next.moduleOrder = seq("modules");
	for (const moduleUuid of Object.keys(next.formOrder)) {
		next.formOrder[moduleUuid] = seq(`forms:${moduleUuid}`);
	}
	for (const parentUuid of Object.keys(next.fieldOrder)) {
		next.fieldOrder[parentUuid] = seq(`fields:${parentUuid}`);
	}

	for (const module of Object.values(next.modules)) {
		strip(module as unknown as Record<string, unknown>);
		const config = module.caseListConfig as
			| (Record<string, unknown> & {
					columns: Record<string, unknown>[];
					searchInputs: Record<string, unknown>[];
			  })
			| undefined;
		if (config === undefined) continue;
		config.listColumnOrder = seq(`columns:list:${module.uuid}`);
		config.detailColumnOrder = seq(`columns:detail:${module.uuid}`);
		for (const column of config.columns) strip(column);
		const inputOrder = seq(`searchInputs:${module.uuid}`);
		const inputsByUuid = new Map(
			config.searchInputs.map((i) => [i.uuid as string, i]),
		);
		config.searchInputs = inputOrder
			.map((uuid) => inputsByUuid.get(uuid))
			.filter((i): i is Record<string, unknown> => i !== undefined);
		for (const input of config.searchInputs) strip(input);
	}

	for (const form of Object.values(next.forms)) {
		strip(form as unknown as Record<string, unknown>);
		if (form.caseOperations === undefined) continue;
		const opOrder = seq(`caseOperations:${form.uuid}`);
		const byUuid = new Map(form.caseOperations.map((op) => [op.uuid, op]));
		form.caseOperations = opOrder
			.map((uuid) => byUuid.get(uuid))
			.filter((op): op is NonNullable<typeof op> => op !== undefined);
		for (const op of form.caseOperations) {
			strip(op as unknown as Record<string, unknown>);
		}
	}

	for (const field of Object.values(next.fields)) {
		strip(field as unknown as Record<string, unknown>);
		if (!("options" in field) || !Array.isArray(field.options)) continue;
		const optionOrder = seq(`options:${field.uuid}`);
		const byUuid = new Map(
			(field.options as { uuid?: string }[]).map((o) => [o.uuid, o]),
		);
		field.options = optionOrder
			.map((uuid) => byUuid.get(uuid))
			.filter((o): o is { uuid?: string } => o !== undefined) as never;
		for (const option of field.options as Record<string, unknown>[]) {
			strip(option);
		}
	}

	next.userPropertyOrder = seq("userProperties");
	next.userTypeOrder = seq("userTypes");
	next.personaOrder = seq("personas");
	for (const record of [next.userProperties, next.userTypes, next.personas]) {
		for (const entity of Object.values(record ?? {})) {
			strip(entity as unknown as Record<string, unknown>);
		}
	}

	return next;
}

/** A sequence the migrated document disagrees with the original about. */
export interface SequenceDivergence {
	readonly path: string;
	readonly before: readonly Uuid[];
	readonly after: readonly Uuid[];
}

/**
 * Compare a captured pre-migration sequence set against the migrated document's
 * arrays. An empty result is the acceptance bar: the migration is invisible.
 *
 * Reads the migrated document's arrays DIRECTLY — no comparator, no sort —
 * because that is what every reader will do once the keys are gone. A pass here
 * therefore proves the post-migration readers see exactly what today's readers
 * see.
 */
export function sequenceDivergences(
	before: DerivedSequences,
	migrated: BlueprintDoc,
): SequenceDivergence[] {
	const after = migratedSequences(migrated);
	const divergences: SequenceDivergence[] = [];
	const paths = new Set([...before.keys(), ...after.keys()]);
	for (const path of [...paths].sort()) {
		const a = before.get(path) ?? [];
		const b = after.get(path) ?? [];
		if (a.length === b.length && a.every((uuid, i) => uuid === b[i])) continue;
		divergences.push({ path, before: a, after: b });
	}
	return divergences;
}

/** The migrated document's sequences, read as plain array position. */
function migratedSequences(doc: BlueprintDoc): Map<string, readonly Uuid[]> {
	const out = new Map<string, readonly Uuid[]>();
	const config = doc as unknown as {
		userPropertyOrder?: Uuid[];
		userTypeOrder?: Uuid[];
		personaOrder?: Uuid[];
	};

	out.set("modules", [...doc.moduleOrder] as Uuid[]);
	for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
		out.set(`forms:${moduleUuid}`, [...formUuids] as Uuid[]);
	}
	for (const [parentUuid, fieldUuids] of Object.entries(doc.fieldOrder)) {
		out.set(`fields:${parentUuid}`, [...fieldUuids] as Uuid[]);
	}
	for (const module of Object.values(doc.modules)) {
		const listConfig = module.caseListConfig as
			| {
					columns: { uuid: string }[];
					searchInputs: { uuid: string }[];
					listColumnOrder?: Uuid[];
					detailColumnOrder?: Uuid[];
			  }
			| undefined;
		if (listConfig === undefined) continue;
		out.set(`columns:list:${module.uuid}`, listConfig.listColumnOrder ?? []);
		out.set(
			`columns:detail:${module.uuid}`,
			listConfig.detailColumnOrder ?? [],
		);
		out.set(
			`searchInputs:${module.uuid}`,
			listConfig.searchInputs.map((i) => i.uuid as Uuid),
		);
	}
	for (const form of Object.values(doc.forms)) {
		if (form.caseOperations === undefined) continue;
		out.set(
			`caseOperations:${form.uuid}`,
			form.caseOperations.map((op) => op.uuid as Uuid),
		);
	}
	for (const field of Object.values(doc.fields)) {
		if (!("options" in field) || !Array.isArray(field.options)) continue;
		out.set(
			`options:${field.uuid}`,
			field.options.map((o) => o.uuid as Uuid),
		);
	}
	out.set("userProperties", config.userPropertyOrder ?? []);
	out.set("userTypes", config.userTypeOrder ?? []);
	out.set("personas", config.personaOrder ?? []);
	return out;
}
