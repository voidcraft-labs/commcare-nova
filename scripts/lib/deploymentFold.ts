/** Operator boundary for a stored-shape conversion. The immutable app log
 * remains in its original dialect. Only verified deployment reference states
 * and the canonical app at the new horizon enter the new dialect. */

import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import {
	greatestFoldBaselineSeq,
	loadCanonicalBlueprintAtSequence,
} from "@/lib/agent/change-set/baseLoader";
import { isCommCareServer } from "@/lib/commcare/servers";
import { openRemoteWrite } from "@/lib/db/openRemoteWrite";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import type { AppDatabase } from "@/lib/db/pg";
import {
	type FoldedDeploymentReference,
	hasPublishedComparison,
	loadFoldOperatorReference,
	projectDeploymentReference,
	readDeploymentReferenceEvidence,
} from "@/lib/deployment/hqChanges/reference";
import {
	readFoldOperatorBaseline,
	readTargetIdentityRows,
} from "@/lib/deployment/store";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type PersistableDoc,
} from "@/lib/domain";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	nextPersistedSequence,
	safePersistedSequence,
} from "@/lib/utils/persistedSequence";
import type { DeploymentFoldMigration } from "./deploymentFoldArtifacts";
import { deploymentFoldSchema } from "./deploymentFoldSchema";

interface FoldSource {
	readonly appId: string;
	readonly projectId: string;
	readonly headSeq: number;
	readonly migration: DeploymentFoldMigration;
}

export interface DeploymentFoldInventory {
	readonly digest: string;
	readonly usable: number;
	readonly unavailable: number;
}

function converted(input: FoldSource, snapshot: unknown): BlueprintDoc {
	return hydratePersistedBlueprint(
		blueprintDocSchema.parse(
			input.migration.convert(snapshot, {
				appId: input.appId,
				projectId: input.projectId,
			}),
		),
	);
}

function encodeReference(state: FoldedDeploymentReference) {
	return state.kind === "ok"
		? { ...state, doc: toPersistableDoc(state.doc) }
		: state;
}

interface Certificate {
	readonly deploymentId: string;
	readonly mappingId: string;
	readonly remoteAppId: string;
	readonly sourceDigest: string;
	readonly revision: number;
	readonly state: ReturnType<typeof encodeReference>;
}

/** Keyset reads allow queries and writes on the same transaction between
 * targets without retaining their documents, observations or identity maps. */
async function* targets(
	tx: Transaction<AppDatabase>,
	appId: string,
	projectId: string,
	schema: "prior" | "certificates",
) {
	const query = tx
		.selectFrom("app_deployments as d")
		.innerJoin("app_deployment_resources as r", (join) =>
			join
				.onRef("r.deployment_id", "=", "d.id")
				.on("r.kind", "=", "app")
				.on("r.superseded_at", "is", null)
				.on("r.nova_resource_id", "=", appId),
		)
		.leftJoin("app_deployment_baselines as b", "b.deployment_id", "d.id")
		.select([
			"d.id",
			"d.server",
			"d.domain",
			"d.endings",
			"r.id as mappingId",
			"r.remote_id as remoteId",
			"r.pushed_revision",
			"r.push_token",
			"b.observed_at",
			"b.first_publish_changes",
			"b.source_digest",
			sql<string | null>`extract(epoch from r.released_at)::text`.as(
				"released_at",
			),
		])
		.select(
			schema === "prior"
				? sql<null>`NULL`.as("reference_fold_seq")
				: "b.reference_fold_seq",
		)
		.where("d.app_id", "=", appId)
		.where("d.project_id", "=", projectId)
		.orderBy("d.id")
		.limit(1);
	let cursor: string | undefined;
	for (;;) {
		const row = await (cursor === undefined
			? query
			: query.where("d.id", ">", cursor)
		).executeTakeFirst();
		if (!row) return;
		yield row;
		cursor = row.id;
	}
}

async function visitDeploymentReferences(
	tx: Transaction<AppDatabase>,
	input: FoldSource,
	schema: "prior" | "certificates",
	save?: (record: Certificate) => Promise<void>,
) {
	const { appId, projectId, headSeq, migration } = input;
	const root = await tx
		.selectFrom("apps")
		.select("mutation_seq")
		.select(
			sql<string>`public.nova_current_app_change_fold_snapshot(apps.id)::text`.as(
				"snapshot",
			),
		)
		.where("id", "=", appId)
		.where("project_id", "=", projectId)
		.executeTakeFirstOrThrow();
	const storedHeadDigest = canonicalJsonDigest(
		parsePersistedJsonText(root.snapshot, "pre-conversion app"),
	);
	const oldHead = migration.readHead(root.snapshot);
	if (
		safePersistedSequence(root.mutation_seq) !== headSeq ||
		storedHeadDigest !== canonicalJsonDigest(oldHead)
	)
		throw new Error(
			"The fold source decoder did not reproduce the saved app in this Project.",
		);
	const oldFoldSeq = await greatestFoldBaselineSeq(tx, appId);
	const nextHead = converted(input, oldHead);
	// Each update adds one fixed-length hex digest. Both scan and writer
	// consume targets once in database order, including unavailable targets.
	const receipts = createHash("sha256").update(
		canonicalJsonDigest({
			appId,
			projectId,
			headSeq,
			oldFoldSeq,
			nextHead: toPersistableDoc(nextHead),
			source: migration.provenance,
			storedHeadDigest,
		}),
	);
	const states = createHash("sha256");
	let usable = 0;
	let unavailable = 0;
	for await (const row of targets(tx, appId, projectId, schema)) {
		const { server, domain } = row;
		if (!isCommCareServer(server))
			throw new Error("A deployment names an unknown server.");
		const baseline = await readFoldOperatorBaseline(
			tx,
			{ appId, projectId },
			{ server, domain },
			schema,
		);
		const mapping = {
			deploymentId: row.id,
			remoteId: row.remoteId,
			pushedRevision:
				row.pushed_revision === null
					? null
					: safePersistedSequence(row.pushed_revision),
		};
		const hasPair =
			baseline !== null &&
			baseline.remoteAppId === row.remoteId &&
			hasPublishedComparison(baseline, mapping, oldFoldSeq);
		if (!hasPair && row.reference_fold_seq !== null)
			throw new Error(
				"A previously certified deployment no longer matches its baseline, mapping or fold.",
			);
		const identity = await readTargetIdentityRows(tx, row.id, {
			appId,
			server,
		});
		const facts = canonicalJsonDigest({
			row: { ...row, observed_at: row.observed_at?.toISOString() },
			identity,
			media: baseline?.mediaFiles,
			revision: baseline?.novaRevision,
			origin: baseline?.origin,
			ownership:
				baseline && baseline.origin !== "unread" ? baseline.ownership : null,
		});
		if (
			!hasPair ||
			!baseline ||
			baseline.origin === "unread" ||
			baseline.novaRevision === null
		) {
			unavailable++;
			receipts.update(
				canonicalJsonDigest({
					facts,
					reason: baseline?.origin ?? "no-reference",
				}),
			);
			continue;
		}
		const evidence =
			!baseline.foldBinding && headSeq === baseline.novaRevision
				? {
						appId,
						headSeq,
						startSeq: headSeq,
						start: {
							kind: "head" as const,
							snapshotText: root.snapshot,
							projectId,
						},
						suffix: [],
					}
				: await readDeploymentReferenceEvidence(
						tx,
						{
							appId,
							headSeq,
							novaRevision: baseline.novaRevision,
							binding: baseline.foldBinding,
						},
						"preserve-released",
					);
		// The candidate treats every old document and mutation as opaque until
		// the source release has reduced the old history and projected the head.
		const old = migration.readReference(root.snapshot, evidence);
		const state: FoldedDeploymentReference =
			old.kind === "ok"
				? {
						kind: "ok",
						doc: converted(input, old.doc),
						projectId: old.projectId,
						editorBefore: old.editorBefore,
						actors: old.actors,
						renamesSince: old.renamesSince,
						activeRenames: old.activeRenames,
					}
				: old;
		const projected = projectDeploymentReference(state, nextHead);
		if (
			old.kind === "ok" &&
			(projected.kind !== "ok" ||
				old.projectId !== projectId ||
				canonicalJsonDigest(projected.renamesSince) !==
					canonicalJsonDigest(old.renamesSince) ||
				canonicalJsonDigest(projected.actors) !==
					canonicalJsonDigest(old.actors) ||
				canonicalJsonDigest(
					toPersistableDoc(converted(input, old.published)),
				) !== canonicalJsonDigest(toPersistableDoc(projected.doc)) ||
				canonicalJsonDigest(
					toPersistableDoc(converted(input, old.identity)),
				) !== canonicalJsonDigest(toPersistableDoc(projected.identityDoc)))
		)
			throw new Error(
				"The converted deployment reference changes the published comparison or its target identities.",
			);
		if (state.kind === "ok" && row.released_at === null) usable++;
		else unavailable++;
		const record = {
			deploymentId: row.id,
			mappingId: row.mappingId,
			remoteAppId: row.remoteId,
			sourceDigest: baseline.sourceDigest,
			revision: baseline.novaRevision,
			state: encodeReference(state),
		};
		const digest = canonicalJsonDigest(record);
		receipts.update(
			canonicalJsonDigest({
				facts,
				sourceEvidence: canonicalJsonDigest(evidence),
				reference: digest,
			}),
		);
		states.update(digest);
		if (save) await save(record);
	}
	return {
		nextHead,
		statesDigest: states.digest("hex"),
		inventory: { usable, unavailable, digest: receipts.digest("hex") },
	};
}

/** The read-only scan and writer use the same inputs. Keep its digest with
 * the private migration manifest so a changed or missing target blocks writing. */
export async function scanDeploymentFold(
	tx: Transaction<AppDatabase>,
	input: FoldSource,
): Promise<DeploymentFoldInventory> {
	return (
		await visitDeploymentReferences(tx, input, await deploymentFoldSchema(tx))
	).inventory;
}

export async function writeDeploymentAwareFold(
	tx: Transaction<AppDatabase>,
	input: FoldSource,
	expected: DeploymentFoldInventory,
	writeHeadAndHorizon: (head: PersistableDoc, seq: number) => Promise<void>,
): Promise<DeploymentFoldInventory> {
	const { appId, projectId, headSeq } = input;
	const app = await tx
		.selectFrom("apps")
		.select("mutation_seq")
		.where("id", "=", appId)
		.where("project_id", "=", projectId)
		.forUpdate()
		.executeTakeFirstOrThrow();
	if (safePersistedSequence(app.mutation_seq) !== headSeq)
		throw new Error("The app changed after the fold scan.");
	// Every claim-changing operation and deployment writer first locks this app.
	// Lock its deployment rows in the common order, returning only a count.
	await sql`SELECT count(*) FROM (SELECT id FROM app_deployments
		WHERE app_id = ${appId} AND project_id = ${projectId} ORDER BY id FOR UPDATE) AS locked`.execute(
		tx,
	);
	if ((await deploymentFoldSchema(tx)) !== "certificates")
		throw new Error(
			"Install the deployment fold migration before writing references.",
		);
	// App import admission holds the same app row. An admission spanning
	// the fold could publish a revision that the candidate no longer reads.
	const pendingImport = await tx
		.selectFrom("hq_remote_writes")
		.select("id")
		.where("app_id", "=", appId)
		.where("project_id", "=", projectId)
		.where("write_kind", "=", "import")
		.where(openRemoteWrite)
		.executeTakeFirst();
	if (pendingImport)
		throw new Error(
			"An admitted app import is still open. Retry the fold after it settles.",
		);
	const foldSeq = nextPersistedSequence(headSeq);
	const { nextHead, inventory, statesDigest } = await visitDeploymentReferences(
		tx,
		input,
		"certificates",
		async (record) => {
			await tx
				.insertInto("app_deployment_fold_references")
				.values({
					deployment_id: record.deploymentId,
					mapping_id: record.mappingId,
					app_id: appId,
					fold_seq: foldSeq,
					published_revision: record.revision,
					original_source_digest: record.sourceDigest,
					state: JSON.stringify(record.state),
				})
				.execute();
			const updated = await tx
				.updateTable("app_deployment_baselines")
				.set({
					reference_fold_seq: foldSeq,
					reference_source_digest: record.sourceDigest,
				})
				.where("deployment_id", "=", record.deploymentId)
				.where("remote_app_id", "=", record.remoteAppId)
				.where("source_digest", "=", record.sourceDigest)
				.where("nova_revision", "=", record.revision)
				.executeTakeFirst();
			if (updated.numUpdatedRows !== BigInt(1))
				throw new Error(
					"A deployment baseline moved before its comparison was bound.",
				);
		},
	);
	if (inventory.digest !== expected.digest)
		throw new Error("The deployment comparisons changed after the fold scan.");
	await writeHeadAndHorizon(toPersistableDoc(nextHead), foldSeq);
	const head = await loadCanonicalBlueprintAtSequence(tx, {
		appId,
		seq: foldSeq,
		expectedDigest: canonicalJsonDigest(toPersistableDoc(nextHead)),
	});
	if (
		head.projectId !== projectId ||
		(await greatestFoldBaselineSeq(tx, appId)) !== foldSeq
	)
		throw new Error(
			"The new fold does not describe the converted app in this Project.",
		);
	// Read each persisted binding back across the new horizon. Compare the
	// ordered aggregate with the converted inputs, including missing/extra rows.
	const restoredStates = createHash("sha256");
	for await (const row of targets(tx, appId, projectId, "certificates")) {
		if (row.reference_fold_seq === null) continue;
		const { server, domain } = row;
		if (!isCommCareServer(server))
			throw new Error("A deployment names an unknown server.");
		const baseline = await readFoldOperatorBaseline(
			tx,
			{ appId, projectId },
			{ server, domain },
			"certificates",
		);
		const binding =
			baseline && baseline.origin !== "unread"
				? baseline.foldBinding
				: undefined;
		if (binding?.foldSeq !== foldSeq)
			throw new Error("A deployment did not bind the new comparison.");
		const restored = await loadFoldOperatorReference(tx, {
			appId,
			novaRevision: binding.novaRevision,
			headSeq: foldSeq,
			binding,
		});
		restoredStates.update(
			canonicalJsonDigest({
				deploymentId: row.id,
				mappingId: row.mappingId,
				remoteAppId: binding.remoteAppId,
				sourceDigest: binding.sourceDigest,
				revision: binding.novaRevision,
				state: encodeReference(restored),
			} satisfies Certificate),
		);
	}
	if (restoredStates.digest("hex") !== statesDigest)
		throw new Error("The deployment comparisons differ after the fold.");
	return inventory;
}
