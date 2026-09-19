/** Frozen, one-time conversion of the former inferred parent selectors.
 * Runtime code never calls this inference. Resume the original manifest; a
 * newly scanned app may already contain intentionally flat selection routes. */
import type { Transaction } from "kysely";
import { z } from "zod";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import { emissionPlan } from "@/lib/commcare/emissionPlan";
import { moduleCaseTypeForActions } from "@/lib/commcare/formLinkProjection";
import { lockActorGenerationGateForAppHolder } from "@/lib/db/actorGenerationGate";
import {
	appendSyntheticBatchInTransaction,
	loadAppInTransaction,
} from "@/lib/db/apps";
import { LEASE_COLUMNS, leaseView } from "@/lib/db/leaseView";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { designSessionLeaseState, runLeaseState } from "@/lib/db/runLiveness";
import {
	describeCommitFindings,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	projectedModulePreorder,
	uuidSchema,
} from "@/lib/domain";
import { caseParentSelectionVerdict } from "@/lib/domain/caseParentSelection";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	nextPersistedSequence,
	safePersistedSequence,
} from "@/lib/utils/persistedSequence";

import { loadAuthoringMigrationApp } from "./repairAuthoringBaselines";

const ACTOR = "system:case-selection-cutover";
const routeSchema = z.strictObject({
	moduleUuid: uuidSchema,
	parentModuleUuid: uuidSchema,
});
const entrySchema = z.strictObject({
	appId: z.string().min(1),
	projectId: z.string().min(1),
	baseSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	baseDigest: z.string(),
	targetDigest: z.string(),
	mutationDigest: z.string(),
	routes: z.array(routeSchema),
	refusals: z.array(z.string()),
});
const bodySchema = z.strictObject({
	format: z.literal("explicit-case-selection-1"),
	sourceRevision: z.string().min(1),
	entries: z.array(entrySchema),
});
export const caseSelectionManifestSchema = bodySchema
	.extend({ digest: z.string() })
	.strict();
export type CaseSelectionManifest = z.infer<typeof caseSelectionManifestSchema>;
export type CaseSelectionMigrationEntry = z.infer<typeof entrySchema>;

export function legacyCaseSelection(doc: BlueprintDoc) {
	const projected = emissionPlan(doc).doc;
	const order = projectedModulePreorder(projected);
	const routes: z.infer<typeof routeSchema>[] = [];
	const refusals: string[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		const module = doc.modules[moduleUuid];
		if (module.parentCaseModuleUuid !== undefined) {
			refusals.push(
				`${module.name}: already has explicit parent selection; use the original manifest.`,
			);
			continue;
		}
		const parentType = doc.caseTypes?.find(
			(type) => type.name === module.caseType,
		)?.parent_type;
		if (!parentType) continue;
		const parentModuleUuid = order.find(
			(uuid) => moduleCaseTypeForActions(projected, uuid) === parentType,
		);
		if (!parentModuleUuid || parentModuleUuid === moduleUuid) continue;
		if (!doc.modules[parentModuleUuid]) {
			refusals.push(
				`${module.name}: legacy selector belongs to a synthetic registration module.`,
			);
			continue;
		}
		routes.push({ moduleUuid, parentModuleUuid });
	}
	const target = structuredClone(doc);
	for (const route of routes)
		target.modules[route.moduleUuid].parentCaseModuleUuid =
			route.parentModuleUuid;
	for (const route of routes) {
		const verdict = caseParentSelectionVerdict(
			target,
			route.moduleUuid,
			route.parentModuleUuid,
		);
		if (!verdict.ok)
			refusals.push(
				`${doc.modules[route.moduleUuid].name}: ${verdict.message}`,
			);
	}
	return { routes, refusals, target };
}

async function readApp(tx: Transaction<AppDatabase>, appId: string) {
	const app = await loadAuthoringMigrationApp(tx, appId);
	if (!app) throw new Error(`App ${appId} is unavailable.`);
	return app;
}

async function assertQuiescent(tx: Transaction<AppDatabase>, appId: string) {
	const row = await tx
		.selectFrom("apps")
		.select(LEASE_COLUMNS)
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
	const lease = runLeaseState(leaseView(row));
	const sessions = await tx
		.selectFrom("design_sessions")
		.selectAll()
		.where("app_id", "=", appId)
		.execute();
	if (
		lease.present ||
		lease.markerSettleable ||
		sessions.some((session) => {
			const state = designSessionLeaseState(session);
			return state.present || state.markerSettleable;
		})
	)
		throw new Error(`App ${appId} still has a run or unsettled reservation.`);
}

export async function scanCaseSelection(
	sourceRevision: string,
	appIds?: readonly string[],
): Promise<CaseSelectionManifest> {
	const db = await getAppDb();
	const ids =
		appIds ??
		(await db.selectFrom("apps").select("id").orderBy("id").execute()).map(
			(row) => row.id,
		);
	const entries: CaseSelectionMigrationEntry[] = [];
	for (const appId of ids)
		entries.push(
			await db
				.transaction()
				.setIsolationLevel("repeatable read")
				.setAccessMode("read only")
				.execute(async (tx) => {
					await assertQuiescent(tx, appId);
					const app = await readApp(tx, appId);
					const baseDigest = canonicalJsonDigest(app.blueprint);
					await loadCanonicalBlueprintAtSequence(tx, {
						appId,
						seq: app.mutation_seq,
						expectedDigest: baseDigest,
					});
					const doc = hydratePersistedBlueprint(app.blueprint);
					const { routes, refusals, target } = legacyCaseSelection(doc);
					const definitions = await readLookupDefinitionsInTransaction(
						tx,
						app.project_id,
						extractLookupReferenceTargets(target).tableIds,
					);
					const verdict = mutationCommitVerdict(target, [], {
						kind: "available",
						...definitions,
					});
					if (!verdict.ok)
						refusals.push(describeCommitFindings(verdict.findings));
					return {
						appId,
						projectId: app.project_id,
						baseSeq: app.mutation_seq,
						baseDigest,
						routes,
						refusals,
						targetDigest: canonicalJsonDigest(toPersistableDoc(target)),
						mutationDigest: canonicalJsonDigest(
							diffDocsToMutations(doc, target),
						),
					};
				}),
		);
	const body = bodySchema.parse({
		format: "explicit-case-selection-1",
		sourceRevision,
		entries,
	});
	return { ...body, digest: canonicalJsonDigest(body) };
}

export function verifyCaseSelectionManifest(
	input: unknown,
): CaseSelectionManifest {
	const manifest = caseSelectionManifestSchema.parse(input);
	const { digest, ...body } = manifest;
	if (canonicalJsonDigest(body) !== digest)
		throw new Error("Migration manifest fingerprint does not match.");
	if (
		new Set(manifest.entries.map((entry) => entry.appId)).size !==
		manifest.entries.length
	)
		throw new Error("Migration manifest repeats an app.");
	if (manifest.entries.some((entry) => entry.refusals.length))
		throw new Error("Resolve migration scan refusals before execution.");
	return manifest;
}

export async function migrateCaseSelectionEntry(
	entry: CaseSelectionMigrationEntry,
) {
	return withAppTx(async (tx) => {
		await lockActorGenerationGateForAppHolder(tx, entry.appId);
		await tx
			.selectFrom("apps")
			.select("id")
			.where("id", "=", entry.appId)
			.forUpdate()
			.executeTakeFirstOrThrow();
		await tx
			.selectFrom("design_sessions")
			.select("id")
			.where("app_id", "=", entry.appId)
			.orderBy("id")
			.forUpdate()
			.execute();
		await assertQuiescent(tx, entry.appId);
		const batchId = `case-selection:${canonicalJsonDigest(entry)}`;
		const receipt = await tx
			.selectFrom("app_changes")
			.selectAll()
			.where("app_id", "=", entry.appId)
			.where("batch_id", "=", batchId)
			.executeTakeFirst();
		if (receipt) {
			if (
				receipt.actor_id !== ACTOR ||
				receipt.kind !== "blueprint-migration" ||
				receipt.run_id !== null ||
				safePersistedSequence(receipt.seq) !==
					nextPersistedSequence(entry.baseSeq) ||
				canonicalJsonDigest(receipt.mutations) !== entry.mutationDigest
			)
				throw new Error("Migration receipt does not match its frozen plan.");
			const historical = await loadCanonicalBlueprintAtSequence(tx, {
				appId: entry.appId,
				seq: nextPersistedSequence(entry.baseSeq),
				expectedDigest: entry.targetDigest,
			});
			if (historical.projectId !== entry.projectId)
				throw new Error("Migration receipt has the wrong Project.");
			return { appId: entry.appId, status: "already-applied" as const };
		}
		const app = await readApp(tx, entry.appId);
		if (
			app.project_id !== entry.projectId ||
			app.mutation_seq !== entry.baseSeq ||
			canonicalJsonDigest(app.blueprint) !== entry.baseDigest
		)
			throw new Error("App differs from its frozen migration basis.");
		const doc = hydratePersistedBlueprint(app.blueprint);
		const { routes, refusals, target } = legacyCaseSelection(doc);
		if (
			refusals.length ||
			canonicalJsonDigest(routes) !== canonicalJsonDigest(entry.routes) ||
			canonicalJsonDigest(diffDocsToMutations(doc, target)) !==
				entry.mutationDigest ||
			canonicalJsonDigest(toPersistableDoc(target)) !== entry.targetDigest
		)
			throw new Error("Migration target differs from its frozen plan.");
		if (routes.length === 0) {
			await loadAppInTransaction(tx, entry.appId);
			return { appId: entry.appId, status: "unchanged" as const };
		}
		const result = await appendSyntheticBatchInTransaction(tx, {
			appId: entry.appId,
			expectedBaseSeq: entry.baseSeq,
			targetDoc: toPersistableDoc(target),
			batchId,
			authority: {
				kind: "system",
				actorId: ACTOR,
				reason:
					"Preserve parent selectors used before explicit record selection",
			},
		});
		await tx
			.updateTable("authoring_workspaces")
			.set({ status: "abandoned", updated_at: new Date() })
			.where("app_id", "=", entry.appId)
			.where("status", "=", "open")
			.execute();
		await loadCanonicalBlueprintAtSequence(tx, {
			appId: entry.appId,
			seq: result.seq,
			expectedDigest: entry.targetDigest,
		});
		const saved = await loadAppInTransaction(tx, entry.appId);
		if (canonicalJsonDigest(saved?.blueprint) !== entry.targetDigest)
			throw new Error("Migration snapshot differs from replay.");
		return { appId: entry.appId, status: "migrated" as const };
	});
}
