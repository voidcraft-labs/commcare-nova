/**
 * Cutover-only legacy normalization for stored Firestore blueprints.
 *
 * The old loader never Zod-parsed a stored blueprint, so prod docs carry
 * shapes today's runtime tolerates only because it never reads them. The
 * Postgres loader (`assembleBlueprint`) strict-parses on every load, so the
 * cutover must project each doc onto exactly what today's readers consume.
 * Four rules, each a lossless projection of the CURRENT user-visible app
 * (verified against the full prod dataset by `scan-firestore-to-pg.ts`):
 *
 *   1. **Strip vestigial v0 case-list keys.** Module-level `caseListColumns` /
 *      `caseDetailColumns` predate `caseListConfig`; the v0→v2 reshape's bulk
 *      query filtered `deleted_at == null AND status == "complete"`, so
 *      trashed / errored apps kept the keys. Nothing reads them.
 *   2. **Prune orphan module/form subtrees.** Firestore merge-writes left
 *      module records behind after deletion (`blueprint.modules` map keys
 *      survive a merge `set`). Display, wire, and preview all walk the
 *      membership arrays, so a record absent from them is invisible today —
 *      and `decomposeBlueprint` refuses to persist it. Pruned: modules not in
 *      `moduleOrder`, forms not in any surviving `formOrder` array, and the
 *      fields reachable ONLY through pruned containers. Fields in no
 *      membership array at all stay — `decomposeBlueprint` preserves those
 *      by design. The complementary defect also prunes: a membership entry
 *      (or `formOrder`/`fieldOrder` key) whose record is gone renders
 *      nothing today, and `assembleBlueprint` rebuilds arrays from rows, so
 *      a dangling uuid cannot round-trip.
 *   3. **Narrow repeat fields to their mode's slots.** Old edits left, e.g.,
 *      a `repeat_count` on a `user_controlled` repeat; consumers narrow by
 *      `repeat_mode` (`fieldSlotApplies`), so the extra slot is dead weight
 *      the per-mode strict schema rejects.
 *   4. **Seed absent case-property labels.** `label` became required after
 *      some docs were written; `label ??= name` is what the UI showed then.
 *
 * One-off: deleted with the cutover scripts once production has migrated.
 */
import type { PersistableDoc } from "@/lib/domain";

export interface LegacyNormalizationReport {
	strippedCaseListKeys: number;
	prunedModules: number;
	prunedForms: number;
	prunedFields: number;
	prunedDanglingRefs: number;
	narrowedRepeats: number;
	seededPropertyLabels: number;
}

/** One short line naming what normalization changed; `null` when nothing. */
export function normalizationSummary(
	r: LegacyNormalizationReport,
): string | null {
	const parts: string[] = [];
	if (r.strippedCaseListKeys > 0)
		parts.push(
			`stripped v0 case-list keys on ${r.strippedCaseListKeys} module(s)`,
		);
	if (r.prunedModules > 0)
		parts.push(`pruned ${r.prunedModules} orphan module(s)`);
	if (r.prunedForms > 0) parts.push(`pruned ${r.prunedForms} orphan form(s)`);
	if (r.prunedFields > 0)
		parts.push(`pruned ${r.prunedFields} orphan field(s)`);
	if (r.prunedDanglingRefs > 0)
		parts.push(`pruned ${r.prunedDanglingRefs} dangling membership ref(s)`);
	if (r.narrowedRepeats > 0)
		parts.push(`narrowed ${r.narrowedRepeats} repeat field(s) to their mode`);
	if (r.seededPropertyLabels > 0)
		parts.push(`seeded ${r.seededPropertyLabels} case-property label(s)`);
	return parts.length > 0 ? parts.join(", ") : null;
}

interface LooseDoc {
	modules: Record<string, Record<string, unknown>>;
	forms: Record<string, Record<string, unknown>>;
	fields: Record<string, Record<string, unknown>>;
	moduleOrder: string[];
	formOrder: Record<string, string[]>;
	fieldOrder: Record<string, string[]>;
	caseTypes: Array<{ properties?: Array<Record<string, unknown>> }> | null;
}

const LEGACY_MODULE_KEYS = ["caseListColumns", "caseDetailColumns"] as const;

export function normalizeLegacyBlueprint(persistable: PersistableDoc): {
	doc: PersistableDoc;
	report: LegacyNormalizationReport;
} {
	const doc = structuredClone(persistable) as unknown as LooseDoc;
	const report: LegacyNormalizationReport = {
		strippedCaseListKeys: 0,
		prunedModules: 0,
		prunedForms: 0,
		prunedFields: 0,
		prunedDanglingRefs: 0,
		narrowedRepeats: 0,
		seededPropertyLabels: 0,
	};

	// ── 2a. Prune dangling membership refs (entry/key without a record) ──
	// MUST run before the orphan-record pruning: a `formOrder` key under a
	// recordless module would otherwise count its forms as surviving
	// membership, then lose its key and leave those form records orphaned.
	let dangling = 0;
	const keepModule = (u: string) => u in doc.modules;
	dangling += doc.moduleOrder.length;
	doc.moduleOrder = doc.moduleOrder.filter(keepModule);
	dangling -= doc.moduleOrder.length;
	for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
		if (!keepModule(moduleUuid)) {
			dangling++;
			delete doc.formOrder[moduleUuid];
			continue;
		}
		const kept = formUuids.filter((u) => u in doc.forms);
		dangling += formUuids.length - kept.length;
		doc.formOrder[moduleUuid] = kept;
	}
	for (const [parentUuid, fieldUuids] of Object.entries(doc.fieldOrder)) {
		if (!(parentUuid in doc.forms) && !(parentUuid in doc.fields)) {
			dangling++;
			delete doc.fieldOrder[parentUuid];
			continue;
		}
		const kept = fieldUuids.filter((u) => u in doc.fields);
		dangling += fieldUuids.length - kept.length;
		doc.fieldOrder[parentUuid] = kept;
	}
	report.prunedDanglingRefs = dangling;

	// ── 2b. Prune orphan module/form subtrees ─────────────────────────────
	const placedModules = new Set(doc.moduleOrder);
	const removedModules = new Set(
		Object.keys(doc.modules).filter((u) => !placedModules.has(u)),
	);
	const survivingFormMembership = new Set<string>();
	for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
		if (removedModules.has(moduleUuid)) continue;
		for (const f of formUuids) survivingFormMembership.add(f);
	}
	const removedForms = new Set(
		Object.keys(doc.forms).filter((u) => !survivingFormMembership.has(u)),
	);
	// Fields reachable ONLY via pruned containers, to a fixpoint (a pruned
	// group/repeat field is itself a container whose children then prune).
	const removedContainers = new Set<string>(removedForms);
	const removedFields = new Set<string>();
	let changed = true;
	while (changed) {
		changed = false;
		const survivingFieldMembership = new Set<string>();
		for (const [parentUuid, fieldUuids] of Object.entries(doc.fieldOrder)) {
			if (removedContainers.has(parentUuid)) continue;
			for (const f of fieldUuids) survivingFieldMembership.add(f);
		}
		for (const [parentUuid, fieldUuids] of Object.entries(doc.fieldOrder)) {
			if (!removedContainers.has(parentUuid)) continue;
			for (const uuid of fieldUuids) {
				if (survivingFieldMembership.has(uuid) || removedFields.has(uuid))
					continue;
				const field = doc.fields[uuid];
				if (field === undefined) continue;
				removedFields.add(uuid);
				changed = true;
				const kind = field.kind;
				if (kind === "group" || kind === "repeat") {
					removedContainers.add(uuid);
				}
			}
		}
	}
	for (const uuid of removedModules) {
		delete doc.modules[uuid];
		delete doc.formOrder[uuid];
	}
	for (const uuid of removedForms) {
		delete doc.forms[uuid];
		delete doc.fieldOrder[uuid];
	}
	for (const uuid of removedFields) {
		delete doc.fields[uuid];
		delete doc.fieldOrder[uuid];
	}
	report.prunedModules = removedModules.size;
	report.prunedForms = removedForms.size;
	report.prunedFields = removedFields.size;

	// ── 1. Strip vestigial v0 case-list keys ─────────────────────────────
	for (const mod of Object.values(doc.modules)) {
		let stripped = false;
		for (const key of LEGACY_MODULE_KEYS) {
			if (key in mod) {
				delete mod[key];
				stripped = true;
			}
		}
		if (stripped) report.strippedCaseListKeys++;
	}

	// ── 3. Narrow repeat fields to their mode's slots ────────────────────
	for (const field of Object.values(doc.fields)) {
		if (field.kind !== "repeat") continue;
		const mode = field.repeat_mode;
		const drop: string[] = [];
		if (mode === "user_controlled") drop.push("repeat_count", "data_source");
		else if (mode === "count_bound") drop.push("data_source");
		else if (mode === "query_bound") drop.push("repeat_count");
		let narrowed = false;
		for (const key of drop) {
			if (key in field) {
				delete field[key];
				narrowed = true;
			}
		}
		if (narrowed) report.narrowedRepeats++;
	}

	// ── 4. Seed absent case-property labels ──────────────────────────────
	if (Array.isArray(doc.caseTypes)) {
		for (const caseType of doc.caseTypes) {
			if (!Array.isArray(caseType.properties)) continue;
			for (const property of caseType.properties) {
				if (property.label === undefined && typeof property.name === "string") {
					property.label = property.name;
					report.seededPropertyLabels++;
				}
			}
		}
	}

	return { doc: doc as unknown as PersistableDoc, report };
}
