import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type Kysely, sql, type Transaction } from "kysely";
import { type Migration, Migrator } from "kysely/migration";
import { z } from "zod";
import {
	decomposeBlueprint,
	entityRowStatements,
} from "@/lib/db/blueprintRows";
import {
	blueprintMediaRequirements,
	denormalize,
	loadAppInTransaction,
	replaceExactMediaReferencesForApp,
} from "@/lib/db/canonicalCommitKernel";
import { LEASE_COLUMNS, leaseView } from "@/lib/db/leaseView";
import {
	lockLookupTablesForReferenceWrite,
	readStoredLookupReferenceTargets,
	replaceLookupReferenceEdges,
} from "@/lib/db/lookupReferenceEdges";
import {
	loadAssetsByIds,
	validateMediaReferenceRows,
} from "@/lib/db/mediaAssets";
import { openRemoteWrite } from "@/lib/db/openRemoteWrite";
import type { AppDatabase } from "@/lib/db/pg";
import { readDatabasePrivilegeRoleConfig } from "@/lib/db/privilegeConvergence";
import { designSessionLeaseState, runLeaseState } from "@/lib/db/runLiveness";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema, type PersistableDoc } from "@/lib/domain";
import type { LookupDefinitionsSnapshot } from "@/lib/lookup/types";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	nextPersistedSequence,
	safePersistedSequence,
} from "@/lib/utils/persistedSequence";
import {
	type CompletionMigration,
	installPrivateWorkspaces,
	openWorkspaceIds,
	privatePlanEntry,
	scanPrivateWorkspaces,
	verifyPrivateWorkspaces,
} from "./completionWorkspaces";
import { assertCutoverRuntimeStopped } from "./cutoverRuntime";
import {
	scanDeploymentFold,
	verifyDeploymentFold,
	writeDeploymentAwareFold,
} from "./deploymentFold";
import {
	importExactArtifact,
	openDeploymentFoldMigration,
} from "./deploymentFoldArtifacts";

const marker = "fold-baseline:hq-round-trip-completion";
const actor = "system:hq-round-trip-completion";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const artifact = z.strictObject({ path: z.string().min(1), sha256: digest });
const artifacts = z.strictObject({
	sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
	sourceTree: z.string().regex(/^[a-f0-9]{40}$/),
	sourceLockSha256: digest,
	reader: artifact,
	converter: artifact,
});

export async function completionArtifacts(
	path: string,
	conversionSettings: z.core.util.JSONType = {},
): Promise<CompletionMigration> {
	const source = artifacts.parse(JSON.parse(await readFile(path, "utf8")));
	const reader = {
		...source.reader,
		path: resolve(dirname(path), source.reader.path),
	};
	const dialect = await openDeploymentFoldMigration({
		...source,
		settings: conversionSettings,
		reader,
		converter: {
			...source.converter,
			path: resolve(dirname(path), source.converter.path),
		},
	});
	const { releasedLookups, privateBase, privateStep, privateOverlay } =
		await importExactArtifact(reader);
	if (
		typeof releasedLookups !== "function" ||
		typeof privateBase !== "function" ||
		typeof privateStep !== "function" ||
		typeof privateOverlay !== "function"
	)
		throw new Error(
			"The selected decoder does not read the released private authoring steps.",
		);
	return {
		...dialect,
		conversionSettings,
		async releasedLookups(tx, projectId, tableIds) {
			const lookup: LookupDefinitionsSnapshot = await releasedLookups(
				tx,
				projectId,
				tableIds,
			);
			if (
				lookup.projectId !== projectId ||
				lookup.definitions.some((table) => !tableIds.includes(table.id))
			)
				throw new Error(
					"The released lookup read returned a different Project or table.",
				);
			// Match the candidate lookup DDL. A table copied from HQ retains no
			// released observation of its indexes, even after Nova took ownership.
			return {
				...lookup,
				definitions: lookup.definitions.map((table) =>
					table.hq
						? {
								...table,
								columns: table.columns.map((column) => ({
									...column,
									index: "unobserved" as const,
								})),
							}
						: table,
				),
			};
		},
		privateBase(input) {
			const result = privateBase(input);
			if (!result || typeof result.projectId !== "string" || !result.snapshot)
				throw new Error(
					"The selected reader returned an incomplete private base.",
				);
			return { projectId: result.projectId, snapshot: result.snapshot };
		},
		privateStep(text, digest) {
			const step = privateStep(text, digest);
			if (!Array.isArray(step))
				throw new Error(
					"The selected reader returned an incomplete admitted step.",
				);
			return step;
		},
		privateOverlay(base, mutations) {
			return privateOverlay(base, mutations);
		},
	};
}

const entry = z.strictObject({
	appId: z.string().min(1),
	projectId: z.string().min(1),
	headSeq: z.number().int().nonnegative(),
	inventory: z.strictObject({
		usable: z.number().int().nonnegative(),
		unavailable: z.number().int().nonnegative(),
		digest,
		headDigest: digest,
		statesDigest: digest,
	}),
});
export const completionPlanSchema = z.strictObject({
	version: z.literal(3),
	conversionSettings: z.json(),
	workspaces: z.array(privatePlanEntry),
	provenance: digest,
	apps: z.array(entry),
});
export type CompletionPlan = z.infer<typeof completionPlanSchema>;

type CompletionProgress = (
	part: "apps" | "workspaces",
	completed: number,
	total: number,
) => void;

/** The release provides the old SQL projection and its evidence checks.
 * They operate in the caller's transaction, before any candidate DDL.
 * The named last migration retires the released carrier and creates the
 * singleton receipt table. The Postgres rehearsal supplies an equivalent pipeline
 * without importing the pending Connect representation. */
export interface CompletionStorage {
	readonly migrations: Readonly<Record<string, Migration>>;
	readonly completionMigration: string;
	readReleasedHead(
		tx: Transaction<AppDatabase>,
		appId: string,
	): Promise<string>;
	checkSourceFacts(
		tx: Transaction<AppDatabase>,
		migration: CompletionMigration,
	): Promise<void>;
}
type CompletionEntry = z.infer<typeof entry>;

/** The database restore action can resolve any physically retained app by ID.
 * Scan all roots, including deleted ones. Keep the output to identities,
 * counts and digests. Only one document is in memory at a time. */
async function fleet(tx: Transaction<AppDatabase>) {
	return tx
		.selectFrom("apps")
		.select(["id", "project_id", "mutation_seq"])
		.orderBy("id")
		.execute();
}

export async function scanCompletion(
	db: Kysely<AppDatabase>,
	migration: CompletionMigration,
	storage: CompletionStorage,
	progress?: CompletionProgress,
): Promise<CompletionPlan> {
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			await storage.checkSourceFacts(tx, migration);
			const apps: CompletionEntry[] = [];
			const roots = await fleet(tx);
			for (const row of roots) {
				const source = {
					appId: row.id,
					projectId: row.project_id,
					headSeq: safePersistedSequence(row.mutation_seq),
					migration,
				};
				const text = await storage.readReleasedHead(tx, row.id);
				const candidate = hydratePersistedBlueprint(
					blueprintDocSchema.parse(
						migration.convert(migration.readHead(text), source),
					),
				);
				const requirements = blueprintMediaRequirements(candidate);
				const assets = await loadAssetsByIds(
					requirements.map((item) => item.assetId),
					row.project_id,
					tx,
				);
				validateMediaReferenceRows(
					row.project_id,
					requirements,
					new Map(assets.map((asset) => [asset.id, asset])),
				);
				const lookup = await migration.releasedLookups(
					tx,
					row.project_id,
					extractLookupReferenceTargets(candidate).tableIds,
				);
				const verdict = mutationCommitVerdict(candidate, [], {
					kind: "available",
					...lookup,
				});
				if (!verdict.ok)
					throw new Error(
						`App ${row.id} cannot cross the horizon (${[...new Set(verdict.findings.map((f) => f.code))].join(", ")}).`,
					);
				const inventory = await scanDeploymentFold(tx, source, text);
				if (
					canonicalJsonDigest(toPersistableDoc(verdict.nextDoc)) !==
					inventory.headDigest
				)
					throw new Error(
						`App ${row.id} changes under its candidate validation.`,
					);
				apps.push({
					appId: row.id,
					projectId: row.project_id,
					headSeq: source.headSeq,
					inventory,
				});
				progress?.("apps", apps.length, roots.length);
			}
			const workspaces = await scanPrivateWorkspaces(
				tx,
				new Map(apps.map((a) => [a.appId, a.headSeq])),
				migration,
				(done, total) => progress?.("workspaces", done, total),
			);
			return {
				version: 3,
				conversionSettings: migration.conversionSettings,
				provenance: migration.provenance,
				apps,
				workspaces,
			};
		});
}

async function writeHorizon(
	tx: Transaction<AppDatabase>,
	entry: CompletionEntry,
	doc: PersistableDoc,
	seq: number,
): Promise<void> {
	const { appId, projectId } = entry;
	// Baseline admission requires every entity's xmin to be this transaction.
	// Holding the root makes replacement invisible until the new horizon commits.
	const targets = extractLookupReferenceTargets(hydratePersistedBlueprint(doc));
	await lockLookupTablesForReferenceWrite(tx, projectId, targets.tableIds);
	await replaceLookupReferenceEdges(tx, { appId, projectId, targets });
	await replaceExactMediaReferencesForApp(tx, {
		appId,
		projectId,
		candidateDoc: doc,
	});
	const entities = decomposeBlueprint(doc);
	await tx
		.deleteFrom("blueprint_entities")
		.where("app_id", "=", appId)
		.execute();
	for (const batch of entityRowStatements(entities)) {
		await tx
			.insertInto("blueprint_entities")
			.values(
				batch.map((row) => ({
					app_id: appId,
					uuid: row.uuid,
					kind: row.kind,
					parent_uuid: row.parent_uuid,
					ordinal: row.ordinal,
					data: JSON.stringify(row.data),
				})),
			)
			.execute();
	}
	await tx
		.updateTable("apps")
		.set({ ...denormalize(doc), mutation_seq: seq })
		.where("id", "=", appId)
		.where("project_id", "=", projectId)
		.executeTakeFirstOrThrow();
	await tx
		.insertInto("app_changes")
		.values({
			app_id: appId,
			seq,
			kind: "fold-baseline",
			batch_id: marker,
			actor_id: actor,
			mutations: "[]",
			run_id: null,
			from_project_id: null,
			to_project_id: null,
		})
		.execute();
	await sql`INSERT INTO public.app_change_fold_baselines (app_id, seq, project_id, snapshot, snapshot_digest)
		SELECT ${appId}, ${seq}, ${projectId}, stored.doc, public.nova_app_change_fold_snapshot_digest(stored.doc)
		FROM (SELECT public.nova_current_app_change_fold_snapshot(${appId}) AS doc) AS stored`.execute(
		tx,
	);
	// The serving loader also enforces the whole-document rule over the actual
	// persisted entity rows and the Project's lookup definitions.
	const stored = await loadAppInTransaction(tx, appId);
	if (
		!stored ||
		stored.project_id !== projectId ||
		canonicalJsonDigest(stored.blueprint) !== entry.inventory.headDigest
	)
		throw new Error(
			`The app saved at the new horizon differs from the reviewed conversion for ${appId}.`,
		);
	await verifyExternalReferences(tx, appId, projectId, doc);
	await sql`SELECT pg_notify('nova_app_stream', ${JSON.stringify({ appId, seq })})`.execute(
		tx,
	);
}

async function verifyExternalReferences(
	tx: Transaction<AppDatabase>,
	appId: string,
	projectId: string,
	doc: PersistableDoc,
) {
	const expected = extractLookupReferenceTargets(
		hydratePersistedBlueprint(doc),
	);
	const stored = await readStoredLookupReferenceTargets(tx, appId);
	const expectedAssets = [
		...new Set(blueprintMediaRequirements(doc).map((item) => item.assetId)),
	].sort();
	const edges = await tx
		.selectFrom("media_asset_refs")
		.select(["asset_id", "project_id"])
		.where("app_id", "=", appId)
		.orderBy("asset_id")
		.execute();
	if (
		canonicalJsonDigest(stored) !== canonicalJsonDigest(expected) ||
		edges.some((row) => row.project_id !== projectId) ||
		canonicalJsonDigest(edges.map((row) => row.asset_id)) !==
			canonicalJsonDigest(expectedAssets)
	) {
		throw new Error(
			`The converted lookup or media references differ from the saved app ${appId}.`,
		);
	}
}

/** Every app and deployment either crosses together or stays on the source
 * dialect. A retry verifies an already committed horizon and its exact
 * target certificates, including when the operator lost the commit reply. */
export async function applyCompletion(
	db: Kysely<AppDatabase>,
	migration: CompletionMigration,
	plan: CompletionPlan,
	storage: CompletionStorage,
): Promise<"converted" | "verified"> {
	if (
		plan.provenance !== migration.provenance ||
		canonicalJsonDigest(plan.conversionSettings) !==
			canonicalJsonDigest(migration.conversionSettings)
	)
		throw new Error(
			"The reviewed plan names a different decoder, converter or conversion settings.",
		);
	const completion = storage.completionMigration;
	if (Object.keys(storage.migrations).sort().at(-1) !== completion)
		throw new Error(
			"The completion migration must be the last registered migration.",
		);
	const planDigest = canonicalJsonDigest(plan);
	let sourceChecked = false;
	let installed: "converted" | "verified" | undefined;
	// Let Kysely acquire its PostgreSQL migration lock on the connection
	// before our transaction locks any app or deployment. On a SQL error
	// Kysely rolls the transaction back before releasing its session lock.
	const steps = Object.fromEntries(
		Object.entries(storage.migrations).map(([name, step]) => [
			name,
			{
				...step,
				async up(database: Kysely<AppDatabase>) {
					if (!database.isTransaction)
						throw new Error(
							"The round-trip conversion requires a transactional migration.",
						);
					const tx = database as Transaction<AppDatabase>;
					if (!sourceChecked) {
						await lockCompletionSources(tx);
						await storage.checkSourceFacts(tx, migration);
						sourceChecked = true;
					}
					if (name === completion)
						installed = await convertFleet(tx, migration, plan, true);
					await step.up(tx);
					if (name === completion) {
						// Reopen the saved documents and comparisons under the final
						// projection while a failure can still roll back the DDL.
						await convertFleet(tx, migration, plan, false);
						await sql`INSERT INTO public.hq_round_trip_completion_receipt
                        (plan_digest, source_provenance)
                        VALUES (${planDigest}, ${migration.provenance})`.execute(
							tx,
						);
					}
				},
			},
		]),
	);
	const migrator = new Migrator({
		db,
		provider: { getMigrations: async () => steps },
	});
	const report = await migrator.migrateToLatest();
	if (report.error !== undefined) throw report.error;
	if (installed !== undefined) return installed;
	return db.transaction().execute(async (tx) => {
		await lockCompletionSources(tx);
		// Only the immutable receipt can identify all pre-DDL inputs after the
		// scalar is retired. Reopen each converted app and comparison as well.
		const receipt = await sql<{
			plan_digest: string;
			source_provenance: string;
		}>`
            SELECT plan_digest, source_provenance
            FROM public.hq_round_trip_completion_receipt WHERE singleton
        `.execute(tx);
		if (
			receipt.rows[0]?.plan_digest !== planDigest ||
			receipt.rows[0].source_provenance !== migration.provenance
		)
			throw new Error(
				"The stored completion receipt does not match the reviewed source plan.",
			);
		return convertFleet(tx, migration, plan, false);
	});
}

async function lockCompletionSources(tx: Transaction<AppDatabase>) {
	await sql`SET LOCAL lock_timeout = '5s'`.execute(tx);
	const roles = readDatabasePrivilegeRoleConfig();
	if (roles) {
		await assertCutoverRuntimeStopped(tx, roles.runtimeRole);
		await assertCutoverRuntimeStopped(tx, roles.cleanupRole);
	}
	await sql`LOCK TABLE public.apps, public.design_sessions, public.authoring_sessions,
        public.authoring_workspaces, public.authoring_requests, public.authoring_steps,
        public.authoring_step_stages, public.app_deployments, public.app_deployment_resources,
        public.app_deployment_baselines, public.hq_remote_writes IN SHARE ROW EXCLUSIVE MODE`.execute(
		tx,
	);
}

async function convertFleet(
	tx: Transaction<AppDatabase>,
	migration: CompletionMigration,
	plan: CompletionPlan,
	mayInstall: boolean,
): Promise<"converted" | "verified"> {
	const designClaims = await tx
		.selectFrom("design_sessions")
		.selectAll()
		.where("run_holder_nonce", "is not", null)
		.execute();
	if (designClaims.some((row) => designSessionLeaseState(row).live))
		throw new Error(
			"A design session is still executing. Wait for its admitted work before converting.",
		);
	if (
		canonicalJsonDigest(await openWorkspaceIds(tx)) !==
		canonicalJsonDigest(plan.workspaces.map((w) => w.id))
	)
		throw new Error(
			"The set of open private workspaces changed after the scan.",
		);
	const existing = await fleet(tx);
	if (
		existing.length !== plan.apps.length ||
		existing.some(
			(row, i) =>
				row.id !== plan.apps[i]?.appId ||
				row.project_id !== plan.apps[i]?.projectId,
		)
	)
		throw new Error(
			"The set of apps or their Projects changed after the scan. Scan again.",
		);
	const pending = await tx
		.selectFrom("hq_remote_writes")
		.select("id")
		.where(openRemoteWrite)
		.limit(1)
		.executeTakeFirst();
	if (pending)
		throw new Error(
			"An admitted HQ write is still in flight. Verify it has settled before converting.",
		);
	const completed = await tx
		.selectFrom("app_changes")
		.select(["app_id", "seq"])
		.where("kind", "=", "fold-baseline")
		.where("batch_id", "=", marker)
		.where("actor_id", "=", actor)
		.execute();
	const markers = new Map(
		completed.map((row) => [row.app_id, safePersistedSequence(row.seq)]),
	);
	if (
		markers.size !== completed.length ||
		(markers.size && markers.size !== plan.apps.length)
	)
		throw new Error(
			"The reviewed fleet has duplicate or incomplete completion horizons. Verify the restore state.",
		);
	const installed = await tx
		.selectFrom("authoring_workspace_folds")
		.select("change_set_id")
		.orderBy("change_set_id")
		.execute();
	const verifying =
		markers.size > 0 || (plan.apps.length === 0 && installed.length > 0);
	if (
		verifying &&
		canonicalJsonDigest(installed.map((r) => r.change_set_id)) !==
			canonicalJsonDigest(plan.workspaces.map((w) => w.id))
	)
		throw new Error(
			"The stored private horizons differ from the reviewed workspace set.",
		);
	if (!verifying) {
		if (!mayInstall && (plan.apps.length || plan.workspaces.length))
			throw new Error(
				"The ledger records completion without the reviewed horizons.",
			);
		if (installed.length)
			throw new Error("Only a part of the fleet has already been converted.");
		await installPrivateWorkspaces(
			tx,
			plan.workspaces,
			new Map(plan.apps.map((a) => [a.appId, a.headSeq])),
			migration,
		);
	}
	for (const item of plan.apps) {
		const app = await tx
			.selectFrom("apps")
			.select(["mutation_seq", ...LEASE_COLUMNS])
			.where("id", "=", item.appId)
			.forUpdate()
			.executeTakeFirstOrThrow();
		const foldSeq = nextPersistedSequence(item.headSeq);
		if (markers.size) {
			if (
				markers.get(item.appId) !== foldSeq ||
				safePersistedSequence(app.mutation_seq) !== foldSeq
			)
				throw new Error(`App ${item.appId} moved beyond the reviewed horizon.`);
			await verifyDeploymentFold(
				tx,
				{ appId: item.appId, projectId: item.projectId, foldSeq },
				item.inventory,
			);
			const stored = await loadAppInTransaction(tx, item.appId);
			if (
				!stored ||
				stored.project_id !== item.projectId ||
				canonicalJsonDigest(stored.blueprint) !== item.inventory.headDigest
			)
				throw new Error(
					`The serving document differs from the converted horizon for ${item.appId}.`,
				);
			await verifyExternalReferences(
				tx,
				item.appId,
				item.projectId,
				stored.blueprint,
			);
			continue;
		}
		const lease = runLeaseState(leaseView(app));
		if (lease.live)
			throw new Error(
				`App ${item.appId} still has an executing run. Wait for it to finish before converting.`,
			);
		await writeDeploymentAwareFold(
			tx,
			{ ...item, migration },
			item.inventory,
			(doc, seq) => writeHorizon(tx, item, doc, seq),
		);
	}
	await verifyPrivateWorkspaces(tx, plan.workspaces);
	return verifying || (!plan.apps.length && !plan.workspaces.length)
		? "verified"
		: "converted";
}
