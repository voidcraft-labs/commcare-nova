/** Temporary, manifest-fenced repair of prose lost in the July 31 cutover. */
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { runValidation } from "../../lib/commcare/validator/runner";
import { appendSyntheticBatchInTransaction } from "../../lib/db/apps";
import {
	loadSchemaAdmittedAppSnapshotFromRowInTransaction,
	lockAppRow,
} from "../../lib/db/canonicalCommitKernel";
import { LEASE_COLUMNS, leaseView } from "../../lib/db/leaseView";
import { parsePersistedJsonText } from "../../lib/db/persistedJson";
import { type AppDatabase, getAppDb, withAppTx } from "../../lib/db/pg";
import { runLeaseState } from "../../lib/db/runLiveness";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "../../lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../../lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	moduleUuidOfForm,
	type PersistableDoc,
	reachableCaseTypes,
	toReachableIndex,
	uuidSchema,
} from "../../lib/domain";
import {
	canonicalProseTemplate,
	type ProseTemplate,
	proseTemplateSchema,
} from "../../lib/domain/prose";
import { collectTranslationUnits } from "../../lib/domain/translationUnits";
import { HASHTAG_REF_PATTERN } from "../../lib/references/config";
import {
	collectFieldEntries,
	ReferenceProvider,
	VALUE_PRODUCING_TYPES,
} from "../../lib/references/provider";
import { canonicalJsonDigest } from "../../lib/utils/canonicalJson";
import { safePersistedSequence } from "../../lib/utils/persistedSequence";
import { loadPersistedBlueprintReadOnly } from "./loadPersistedBlueprint";

export const PROSE_REPAIR_MARKER =
	"fold-baseline:canonical-identity-foundation";
const ACTOR = "system:historical-prose-references";
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const slotSchema = z.enum(["label", "hint", "help", "validate_msg"]);
const changeSchema = z.strictObject({
	fieldUuid: uuidSchema,
	formUuid: uuidSchema,
	slot: slotSchema,
	before: proseTemplateSchema,
	after: proseTemplateSchema,
	tokens: z.array(z.string()).min(1),
});
export const proseRepairEntrySchema = z.strictObject({
	appId: z.string().min(1),
	projectId: z.string().min(1),
	appName: z.string(),
	sequence: z.number().int().nonnegative(),
	baselineDigest: digestSchema,
	sourceDigest: digestSchema,
	targetDigest: digestSchema,
	changes: z.array(changeSchema).min(1),
});
export type ProseRepairEntry = z.infer<typeof proseRepairEntrySchema>;
export const proseRepairManifestSchema = z
	.strictObject({
		version: z.literal(1),
		entries: z.array(proseRepairEntrySchema),
	})
	.superRefine((manifest, ctx) => {
		if (
			new Set(manifest.entries.map((entry) => entry.appId)).size !==
			manifest.entries.length
		)
			ctx.addIssue({ code: "custom", message: "Duplicate manifest app." });
	});
export type ProseRepairManifest = z.infer<typeof proseRepairManifestSchema>;

function tokens(template: ProseTemplate): string[] {
	return template.parts.flatMap((part) =>
		part.kind === "text"
			? [...part.text.matchAll(new RegExp(HASHTAG_REF_PATTERN, "g"))].map(
					(match) => match[0],
				)
			: [],
	);
}
function same(a: unknown, b: unknown): boolean {
	return canonicalJsonDigest(a) === canonicalJsonDigest(b);
}
function provider(doc: BlueprintDoc): ReferenceProvider {
	return new ReferenceProvider((formId) => {
		const formUuid = uuidSchema.parse(formId);
		const form = doc.forms[formUuid];
		if (!form) return undefined;
		const entries = collectFieldEntries(doc, formUuid);
		const moduleUuid = moduleUuidOfForm(doc, formUuid);
		const caseType = moduleUuid && doc.modules[moduleUuid]?.caseType;
		return {
			formUuid,
			formType: form.type,
			validPaths: new Set(entries.map((entry) => `/data/${entry.path}`)),
			formEntries: entries.filter((entry) =>
				VALUE_PRODUCING_TYPES.has(entry.kind),
			),
			reachableCaseTypes: caseType
				? toReachableIndex(
						reachableCaseTypes(caseType, doc.caseTypes ?? []),
						doc,
					)
				: undefined,
			userProperties: Object.values(doc.userProperties ?? {}),
		};
	});
}
function templateAt(
	doc: BlueprintDoc,
	change: Pick<ProseRepairEntry["changes"][number], "fieldUuid" | "slot">,
): ProseTemplate {
	const field = doc.fields[change.fieldUuid];
	return proseTemplateSchema.parse(
		field && (field as unknown as Record<string, unknown>)[change.slot],
	);
}
function replaceTemplate(
	doc: BlueprintDoc,
	change: ProseRepairEntry["changes"][number],
	reverse: boolean,
): void {
	const expected = reverse ? change.after : change.before;
	if (!same(templateAt(doc, change), expected))
		throw new Error("Repair slot changed.");
	(doc.fields[change.fieldUuid] as unknown as Record<string, unknown>)[
		change.slot
	] = structuredClone(reverse ? change.before : change.after);
}

/** Old snapshots remain opaque audit data; only the original reference context
 * is overlaid on a private current document. No compatibility reader ships. */
function historicalContext(
	current: BlueprintDoc,
	baseline: Record<string, unknown>,
): BlueprintDoc {
	const source: Record<string, unknown> = { ...toPersistableDoc(current) };
	for (const key of [
		"fields",
		"forms",
		"modules",
		"fieldOrder",
		"formOrder",
		"moduleOrder",
		"caseTypes",
	])
		if (!Object.hasOwn(baseline, key))
			throw new Error(`Historical context missing ${key}.`);
		else source[key] = baseline[key];
	source.userProperties = baseline.userProperties ?? {};
	source.userPropertyOrder = baseline.userPropertyOrder ?? [];
	return hydratePersistedBlueprint(source as unknown as PersistableDoc);
}

export function planProseReferenceRepair(
	current: PersistableDoc,
	baseline: Record<string, unknown>,
	projectId: string,
	sequence: number,
): ProseRepairEntry | null {
	const doc = hydratePersistedBlueprint(current);
	const units = collectTranslationUnits(doc).filter(
		(unit) =>
			unit.valueKind === "prose" &&
			tokens(unit.source as ProseTemplate).length > 0,
	);
	if (units.length === 0) return null;
	if (doc.localization !== undefined)
		throw new Error(
			"Localized app requires separate review; no overlay may fall back silently.",
		);
	const historical = historicalContext(doc, baseline);
	const oldProvider = provider(historical);
	const currentProvider = provider(doc);
	const changes: ProseRepairEntry["changes"] = [];
	const roleSlots = {
		"field-label": "label",
		"field-hint": "hint",
		"field-help": "help",
		"field-validation-message": "validate_msg",
	} as const;
	for (const unit of units) {
		if (unit.owner.kind !== "field" || !(unit.role in roleSlots))
			throw new Error(`Unreviewed prose carrier ${unit.role}.`);
		const { fieldUuid, formUuid } = unit.owner;
		const slot = roleSlots[unit.role as keyof typeof roleSlots];
		const before = proseTemplateSchema.parse(unit.source);
		const original = templateAt(historical, { fieldUuid, slot });
		const matches = tokens(before);
		if (!same(matches, tokens(original)))
			throw new Error(
				`Historical token inventory changed for ${fieldUuid}.${slot}.`,
			);
		const parts: ProseTemplate["parts"] = [];
		for (const part of before.parts) {
			if (part.kind !== "text") {
				parts.push(part);
				continue;
			}
			let cursor = 0;
			for (const match of part.text.matchAll(
				new RegExp(HASHTAG_REF_PATTERN, "g"),
			)) {
				let token = match[0];
				if (token.startsWith("#case/")) {
					const oldModule = historical.modules[unit.owner.moduleUuid];
					if (!oldModule?.caseType)
						throw new Error("Legacy case alias has no historical case type.");
					token = token.replace("#case/", `#${oldModule.caseType}/`);
				}
				// Explicitly approved defect, not suffix/fuzzy path matching.
				if (
					doc.appId === "Reaz6s4lyn0RYlUwumrM" &&
					fieldUuid === "e00ec2d2-466e-4d3c-b2e7-cd34a71a71e1" &&
					token === "#form/muac"
				)
					token = "#form/measurements/muac";
				const reference = oldProvider.resolve(token, formUuid);
				if (
					!reference ||
					!currentProvider.resolvePart(reference.part, formUuid)
				)
					throw new Error(
						`Reference no longer resolves: ${match[0]} in ${fieldUuid}.`,
					);
				if (match.index > cursor)
					parts.push({
						kind: "text",
						text: part.text.slice(cursor, match.index),
					});
				parts.push(reference.part);
				cursor = match.index + match[0].length;
			}
			if (cursor < part.text.length)
				parts.push({ kind: "text", text: part.text.slice(cursor) });
		}
		const change = {
			fieldUuid,
			formUuid,
			slot,
			before,
			after: canonicalProseTemplate(parts),
			tokens: matches,
		};
		replaceTemplate(doc, change, false);
		changes.push(change);
	}
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length)
		throw new Error(
			findings
				.map((finding) => `${finding.code}: ${finding.message}`)
				.join("\n"),
		);
	return proseRepairEntrySchema.parse({
		appId: doc.appId,
		projectId,
		appName: doc.appName,
		sequence,
		baselineDigest: canonicalJsonDigest(baseline),
		sourceDigest: canonicalJsonDigest(current),
		targetDigest: canonicalJsonDigest(toPersistableDoc(doc)),
		changes,
	});
}

async function baselineFor(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<Record<string, unknown> | null> {
	const row = await tx
		.selectFrom("app_change_fold_baselines as b")
		.innerJoin("app_changes as c", (join) =>
			join.onRef("c.app_id", "=", "b.app_id").onRef("c.seq", "=", "b.seq"),
		)
		.select(sql<string>`b.snapshot::text`.as("snapshot_text"))
		.where("b.app_id", "=", appId)
		.where("c.batch_id", "=", PROSE_REPAIR_MARKER)
		.executeTakeFirst();
	return row
		? z
				.record(z.string(), z.unknown())
				.parse(parsePersistedJsonText(row.snapshot_text))
		: null;
}

export async function scanProseReferenceRepair() {
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const apps = await tx
				.selectFrom("apps")
				.select(["id", "project_id", "mutation_seq", "app_name"])
				.where((eb) =>
					eb.or([
						eb("deleted_at", "is", null),
						eb("recoverable_until", ">", new Date()),
					]),
				)
				.orderBy("id")
				.execute();
			const entries: ProseRepairEntry[] = [];
			const blocked: { appId: string; reason: string }[] = [];
			for (const app of apps) {
				try {
					const current = await loadPersistedBlueprintReadOnly(tx, app.id);
					if (!current) throw new Error("App disappeared.");
					const doc = hydratePersistedBlueprint(current);
					if (
						!collectTranslationUnits(doc).some(
							(unit) =>
								unit.valueKind === "prose" &&
								tokens(unit.source as ProseTemplate).length,
						)
					)
						continue;
					const baseline = await baselineFor(tx, app.id);
					if (!baseline)
						throw new Error(
							"Reference-looking text has no cutover provenance.",
						);
					const entry = planProseReferenceRepair(
						current,
						baseline,
						app.project_id,
						safePersistedSequence(app.mutation_seq, "repair sequence"),
					);
					if (entry) entries.push(entry);
				} catch (error) {
					blocked.push({
						appId: app.id,
						reason: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return {
				scannedApps: apps.length,
				manifest: proseRepairManifestSchema.parse({ version: 1, entries }),
				blocked,
			};
		});
}

export type RepairMode = "execute" | "rollback";
export async function checkProseReferenceRepair(
	entry: ProseRepairEntry,
	manifestDigest: string,
) {
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const app = await tx
				.selectFrom("apps")
				.select([
					"project_id",
					"mutation_seq",
					"deleted_at",
					"recoverable_until",
					...LEASE_COLUMNS,
				])
				.where("id", "=", entry.appId)
				.executeTakeFirst();
			if (!app || app.project_id !== entry.projectId)
				throw new Error("App or Project changed.");
			if (
				app.deleted_at &&
				(!app.recoverable_until || app.recoverable_until <= new Date())
			)
				throw new Error("App is no longer recoverable.");
			if (runLeaseState(leaseView(app)).present)
				throw new Error("App has an occupied agent run.");
			const doc = await loadPersistedBlueprintReadOnly(tx, entry.appId);
			if (!doc) throw new Error("App disappeared.");
			const seq = safePersistedSequence(app.mutation_seq, "repair sequence");
			const digest = canonicalJsonDigest(doc);
			if (digest === entry.targetDigest && seq === entry.sequence + 1) {
				const receipt = await tx
					.selectFrom("app_changes")
					.select("seq")
					.where("app_id", "=", entry.appId)
					.where(
						"batch_id",
						"=",
						`prose-reference-repair:${manifestDigest}:${entry.appId}:execute`,
					)
					.executeTakeFirst();
				if (
					!receipt ||
					safePersistedSequence(receipt.seq, "repair receipt") !== seq
				)
					throw new Error("Repaired state has no matching receipt.");
				return { kind: "already-applied" as const, seq };
			}
			if (digest !== entry.sourceDigest || seq !== entry.sequence)
				throw new Error("Manifest source changed; rescan and review.");
			const baseline = await baselineFor(tx, entry.appId);
			if (
				!baseline ||
				!same(
					planProseReferenceRepair(doc, baseline, app.project_id, seq),
					entry,
				)
			)
				throw new Error("Historical repair plan changed.");
			return { kind: "ready" as const, seq };
		});
}

export async function applyProseReferenceRepair(
	entry: ProseRepairEntry,
	manifestDigest: string,
	mode: RepairMode,
) {
	return withAppTx((tx) =>
		applyProseReferenceRepairInTransaction(tx, entry, manifestDigest, mode),
	);
}

/** Caller owns the transaction; also used to prove rollback against real PG. */
export async function applyProseReferenceRepairInTransaction(
	tx: Transaction<AppDatabase>,
	entry: ProseRepairEntry,
	manifestDigest: string,
	mode: RepairMode,
) {
	proseRepairEntrySchema.parse(entry);
	digestSchema.parse(manifestDigest);
	const fresh = await lockAppRow(tx, entry.appId);
	if (!fresh || fresh.project_id !== entry.projectId)
		throw new Error("App or Project changed.");
	if (
		fresh.deleted_at &&
		(!fresh.recoverable_until || fresh.recoverable_until <= new Date())
	)
		throw new Error("App is no longer recoverable.");
	if (runLeaseState(leaseView(fresh)).present)
		throw new Error("App has an occupied agent run.");
	const snapshot = await loadSchemaAdmittedAppSnapshotFromRowInTransaction(
		tx,
		fresh,
	);
	const batchId = `prose-reference-repair:${manifestDigest}:${entry.appId}:${mode}`;
	const existing = await tx
		.selectFrom("app_changes")
		.select("seq")
		.where("app_id", "=", entry.appId)
		.where("batch_id", "=", batchId)
		.executeTakeFirst();
	const reverse = mode === "rollback";
	const expectedSource = reverse ? entry.targetDigest : entry.sourceDigest;
	const expectedTarget = reverse ? entry.sourceDigest : entry.targetDigest;
	const digest = canonicalJsonDigest(snapshot.app.blueprint);
	if (existing) {
		if (
			digest !== expectedTarget ||
			snapshot.app.mutation_seq !==
				safePersistedSequence(existing.seq, "repair receipt")
		)
			throw new Error(
				"App changed after the recorded repair; inspect its history.",
			);
		return { kind: "deduped" as const, seq: snapshot.app.mutation_seq };
	}
	if (
		digest !== expectedSource ||
		snapshot.app.mutation_seq !== entry.sequence + (reverse ? 1 : 0)
	)
		throw new Error("Manifest source changed; rescan and review.");
	const baseline = await baselineFor(tx, entry.appId);
	if (!baseline || canonicalJsonDigest(baseline) !== entry.baselineDigest)
		throw new Error("Historical evidence changed.");
	if (!reverse) {
		const replanned = planProseReferenceRepair(
			snapshot.app.blueprint,
			baseline,
			fresh.project_id,
			snapshot.app.mutation_seq,
		);
		if (!same(replanned, entry))
			throw new Error("Manifest does not match the historical repair plan.");
	} else {
		const forward = await tx
			.selectFrom("app_changes")
			.select("seq")
			.where("app_id", "=", entry.appId)
			.where(
				"batch_id",
				"=",
				`prose-reference-repair:${manifestDigest}:${entry.appId}:execute`,
			)
			.executeTakeFirst();
		if (
			!forward ||
			safePersistedSequence(forward.seq, "forward receipt") !==
				entry.sequence + 1
		)
			throw new Error("No matching forward repair receipt.");
	}
	for (const change of entry.changes)
		replaceTemplate(snapshot.doc, change, reverse);
	const targetDoc = toPersistableDoc(snapshot.doc);
	if (canonicalJsonDigest(targetDoc) !== expectedTarget)
		throw new Error("Repair target digest mismatch.");
	return appendSyntheticBatchInTransaction(tx, {
		appId: entry.appId,
		expectedBaseSeq: snapshot.app.mutation_seq,
		targetDoc,
		batchId,
		authority: {
			kind: "system",
			actorId: ACTOR,
			reason: reverse
				? "Compensate the exact historical prose repair."
				: "Restore baseline-proven prose references lost in the July 31 cutover.",
		},
	});
}
