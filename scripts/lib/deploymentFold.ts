/** Operator boundary for a stored-shape conversion. The immutable app log
 * remains in its original dialect. Only verified deployment reference states
 * and the canonical app at the new horizon enter the new dialect. */
import { sql, type Transaction } from "kysely";
import {
	greatestFoldBaselineSeq,
	loadCanonicalBlueprintAtSequence,
} from "@/lib/agent/change-set/baseLoader";
import { isCommCareServer } from "@/lib/commcare/servers";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import type { AppDatabase } from "@/lib/db/pg";
import {
	type FoldedDeploymentReference,
	loadFoldedDeploymentReference,
	projectDeploymentReference,
	usablePair,
} from "@/lib/deployment/hqChanges/reference";
import {
	readAppBaselineIn,
	readTargetIdentityRows,
} from "@/lib/deployment/store";
import type { DeploymentFoldBinding } from "@/lib/deployment/types";
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

interface FoldSource {
	readonly appId: string;
	readonly projectId: string;
	readonly headSeq: number;
	readonly oldHead: BlueprintDoc;
	/** Converts a server-folded document, an identity projection, or the head.
	 * All occurrences of an identity must receive the same converted identity. */
	readonly convert: (snapshot: PersistableDoc) => PersistableDoc;
}

export interface DeploymentFoldInventory {
	readonly digest: string;
	readonly usable: number;
	readonly unavailable: number;
}

function converted(input: FoldSource, doc: BlueprintDoc): BlueprintDoc {
	return hydratePersistedBlueprint(
		blueprintDocSchema.parse(input.convert(toPersistableDoc(doc))),
	);
}

async function planDeploymentReferences(
	tx: Transaction<AppDatabase>,
	input: FoldSource,
) {
	const { appId, projectId, headSeq, oldHead } = input;
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
	if (
		safePersistedSequence(root.mutation_seq) !== headSeq ||
		canonicalJsonDigest(
			parsePersistedJsonText(root.snapshot, "pre-conversion app"),
		) !== canonicalJsonDigest(toPersistableDoc(oldHead))
	)
		throw new Error(
			"The fold input differs from the saved app in this Project.",
		);
	const oldFoldSeq = await greatestFoldBaselineSeq(tx, appId);
	const deployments = await tx
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
			"b.reference_fold_seq",
		])
		.where("d.app_id", "=", appId)
		.where("d.project_id", "=", projectId)
		.orderBy("d.id")
		.execute();

	const records = [];
	const receipts = [];
	const nextHead = converted(input, oldHead);
	let unavailable = 0;
	for (const row of deployments) {
		const { server, domain } = row;
		if (!isCommCareServer(server))
			throw new Error("A deployment names an unknown server.");
		const baseline = await readAppBaselineIn(
			tx,
			{ appId, projectId },
			{ server, domain },
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
			usablePair(baseline, mapping, oldFoldSeq);
		if (!hasPair && row.reference_fold_seq !== null)
			throw new Error(
				"A previously certified deployment no longer matches its baseline, mapping or fold.",
			);
		const identity = await readTargetIdentityRows(tx, row.id, {
			appId,
			server,
		});
		const facts = {
			row: { ...row, observed_at: row.observed_at?.toISOString() },
			identity,
			media: baseline?.mediaFiles,
			revision: baseline?.novaRevision,
			origin: baseline?.origin,
		};
		if (
			!hasPair ||
			!baseline ||
			baseline.origin === "unread" ||
			baseline.novaRevision === null
		) {
			unavailable++;
			receipts.push({ ...facts, reason: baseline?.origin ?? "no-reference" });
			continue;
		}
		const start: FoldedDeploymentReference =
			!baseline.foldBinding && headSeq === baseline.novaRevision
				? {
						kind: "ok",
						doc: oldHead,
						projectId,
						editorBefore: false,
						actors: [],
						renamesSince: [],
					}
				: await loadFoldedDeploymentReference(tx, {
						appId,
						headSeq,
						novaRevision: baseline.novaRevision,
						binding: baseline.foldBinding,
					});
		const state =
			start.kind === "ok"
				? { ...start, doc: converted(input, start.doc) }
				: start;
		const old = projectDeploymentReference(start, oldHead);
		const projected = projectDeploymentReference(state, nextHead);
		if (old.kind === "ok" && projected.kind === "ok") {
			if (
				state.kind !== "ok" ||
				state.projectId !== projectId ||
				canonicalJsonDigest(toPersistableDoc(converted(input, old.doc))) !==
					canonicalJsonDigest(toPersistableDoc(projected.doc)) ||
				canonicalJsonDigest(
					toPersistableDoc(converted(input, old.identityDoc)),
				) !== canonicalJsonDigest(toPersistableDoc(projected.identityDoc))
			)
				throw new Error(
					"The converted deployment reference changes the published comparison or its target identities.",
				);
		}
		if (start.kind !== "ok") unavailable++;
		const encoded =
			state.kind === "ok"
				? { ...state, doc: toPersistableDoc(state.doc) }
				: state;
		const record = {
			deploymentId: row.id,
			mappingId: row.mappingId,
			remoteAppId: row.remoteId,
			sourceDigest: baseline.sourceDigest,
			revision: baseline.novaRevision,
			state: encoded,
		};
		records.push(record);
		receipts.push({ ...facts, reference: canonicalJsonDigest(record) });
	}
	return {
		records,
		nextHead,
		inventory: {
			usable: deployments.length - unavailable,
			unavailable,
			digest: canonicalJsonDigest({
				appId,
				projectId,
				headSeq,
				oldFoldSeq,
				receipts,
				nextHead: toPersistableDoc(nextHead),
			}),
		},
	};
}

/** The read-only scan and writer use the same inputs. Keep its digest with
 * the private migration manifest so a changed or missing target blocks writing. */
export async function scanDeploymentFold(
	tx: Transaction<AppDatabase>,
	input: FoldSource,
): Promise<DeploymentFoldInventory> {
	return (await planDeploymentReferences(tx, input)).inventory;
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
	await tx
		.selectFrom("app_deployments")
		.select("id")
		.where("app_id", "=", appId)
		.where("project_id", "=", projectId)
		.orderBy("id")
		.forUpdate()
		.execute();
	const { records, nextHead, inventory } = await planDeploymentReferences(
		tx,
		input,
	);
	if (inventory.digest !== expected.digest)
		throw new Error("The deployment comparisons changed after the fold scan.");
	const foldSeq = nextPersistedSequence(headSeq);
	for (const record of records) {
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
	}
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
	for (const record of records) {
		const binding: DeploymentFoldBinding = {
			deploymentId: record.deploymentId,
			appId,
			projectId,
			remoteAppId: record.remoteAppId,
			sourceDigest: record.sourceDigest,
			novaRevision: record.revision,
			foldSeq,
		};
		const restored = await loadFoldedDeploymentReference(tx, {
			appId,
			novaRevision: record.revision,
			headSeq: foldSeq,
			binding,
		});
		const encoded =
			restored.kind === "ok"
				? { ...restored, doc: toPersistableDoc(restored.doc) }
				: restored;
		if (canonicalJsonDigest(encoded) !== canonicalJsonDigest(record.state))
			throw new Error("The deployment comparison differs after the fold.");
	}
	return inventory;
}
