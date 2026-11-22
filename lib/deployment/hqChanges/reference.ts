import "server-only";

/**
 * The reference document of a deployment, `D_ref`: the Nova document the
 * stored baseline's source describes, as a publish now would send it had
 * nobody changed the app's content since. And `usablePair`, the one rule of
 * whether a deployment's baseline and revision are a pair a comparison can
 * stand on.
 *
 * A change in Nova is measured against this document. A server's own writes
 * after the publish (a hold a publish recorded, a repair a deploy ran, a
 * move of the app to another Project) are part of it, and so is everything
 * a publish never sends, taken from the head: the kinds no reading holds,
 * the worker setup, where the app runs and its logo.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import {
	greatestFoldBaselineSeq,
	readCanonicalFoldInputs,
} from "@/lib/agent/change-set/baseLoader";
import { readAppChangeStreamRowsSince } from "@/lib/db/appChangeStream";
import type {
	BoundedCanonicalAppChangeFoldInput,
	CanonicalAppChangeSuffixRow,
} from "@/lib/db/canonicalMutationFold";
import { type AppDatabase, getAppDb } from "@/lib/db/pg";
import type { BlueprintDoc } from "@/lib/domain";
import type {
	AppBaseline,
	DeploymentFoldBinding,
	DeploymentResource,
} from "../types";
import { foldReferenceEvidence } from "./referenceEvidence";
import {
	type FoldedDeploymentReference,
	foldBaselineInRange,
	projectDeploymentReference,
	type ReferenceDocument,
} from "./referenceFold";

export {
	type FoldedDeploymentReference,
	projectDeploymentReference,
	type ReferenceDocument,
	withHeadUnsent,
} from "./referenceFold";

function headAhead(appId: string, novaRevision: number, seq: number): string {
	return `Nova was asked for the reference document of app ${appId} at revision ${novaRevision}, and the head it was handed is at ${seq}, before it. Pass the head read after the deployment's baseline, which no publish writes ahead of the app.`;
}

export class DeploymentFoldBindingChangedError extends Error {}

export async function loadReferenceDocument(input: {
	readonly db?: Kysely<AppDatabase>;
	readonly appId: string;
	readonly novaRevision: number;
	readonly head: { readonly doc: BlueprintDoc; readonly seq: number };
	readonly binding?: DeploymentFoldBinding;
}): Promise<ReferenceDocument> {
	const { appId, novaRevision, head, binding } = input;
	if (head.seq === novaRevision && !binding)
		return {
			kind: "ok",
			doc: head.doc,
			identityDoc: head.doc,
			renamesSince: [],
			actors: [],
		};
	return projectDeploymentReference(
		await loadFoldedDeploymentReference(input.db ?? (await getAppDb()), {
			appId,
			novaRevision,
			headSeq: head.seq,
			binding,
		}),
		head.doc,
	);
}

/** A released claim can be taken back on restore. Its maintenance-only read
 * keeps the original comparison available for that later holder. */
export function loadFoldOperatorReference(
	db: Transaction<AppDatabase>,
	input: Parameters<typeof loadFoldedDeploymentReference>[1],
) {
	return loadFoldedDeploymentReference(db, input, "preserve-released");
}

async function loadFoldedDeploymentReference(
	db: Kysely<AppDatabase>,
	input: {
		readonly appId: string;
		readonly novaRevision: number;
		readonly headSeq: number;
		readonly binding?: DeploymentFoldBinding;
	},
	claim: "held" | "preserve-released" = "held",
): Promise<FoldedDeploymentReference> {
	return foldReferenceEvidence(
		await readDeploymentReferenceEvidence(db, input, claim),
	);
}

/** Undecoded storage for exactly one authorized app, target and published comparison. */
export interface DeploymentReferenceEvidence {
	readonly appId: string;
	readonly headSeq: number;
	readonly startSeq: number;
	readonly start:
		| { readonly kind: "certificate"; readonly stateText: string }
		| {
				readonly kind: "published";
				readonly canonical: BoundedCanonicalAppChangeFoldInput;
		  }
		| {
				readonly kind: "head";
				readonly snapshotText: string;
				readonly projectId: string;
		  };
	readonly suffix: readonly CanonicalAppChangeSuffixRow[];
}

export async function readDeploymentReferenceEvidence(
	db: Kysely<AppDatabase>,
	input: {
		readonly appId: string;
		readonly novaRevision: number;
		readonly headSeq: number;
		readonly binding?: DeploymentFoldBinding;
	},
	claim: "held" | "preserve-released",
): Promise<DeploymentReferenceEvidence> {
	const { appId, novaRevision, headSeq, binding } = input;
	if (headSeq < novaRevision)
		throw new Error(headAhead(appId, novaRevision, headSeq));
	// A fold may land while the HQ request is in flight. No part of an
	// obsolete mutation dialect is decoded just to detect that race.
	const latest = await greatestFoldBaselineSeq(db, appId);
	if (
		latest !== null &&
		(latest > headSeq || (novaRevision < latest && binding?.foldSeq !== latest))
	)
		throw new DeploymentFoldBindingChangedError(
			foldBaselineInRange(appId, latest),
		);
	let start = novaRevision;
	let source: DeploymentReferenceEvidence["start"];
	if (binding !== undefined) {
		if (
			binding.appId !== appId ||
			binding.novaRevision !== novaRevision ||
			binding.foldSeq > headSeq
		)
			throw new Error(
				"The deployment reference does not match the app revision being compared.",
			);
		const held = await db
			.selectFrom("app_deployment_fold_references as f")
			.innerJoin("app_deployments as d", "d.id", "f.deployment_id")
			.innerJoin("app_deployment_baselines as b", "b.deployment_id", "d.id")
			.innerJoin("app_deployment_resources as r", "r.id", "f.mapping_id")
			.select(sql<string>`f.state::text`.as("state"))
			.where("d.id", "=", binding.deploymentId)
			.where("d.app_id", "=", appId)
			.where("d.project_id", "=", binding.projectId)
			.where("f.app_id", "=", appId)
			.where("f.fold_seq", "=", binding.foldSeq)
			.where("f.published_revision", "=", novaRevision)
			.where("b.nova_revision", "=", novaRevision)
			.where("b.reference_fold_seq", "=", binding.foldSeq)
			.where("b.source_digest", "=", binding.sourceDigest)
			.where("b.reference_source_digest", "=", binding.sourceDigest)
			.whereRef("r.deployment_id", "=", "d.id")
			.where("r.kind", "=", "app")
			.where("r.nova_resource_id", "=", appId)
			.where("r.remote_id", "=", binding.remoteAppId)
			.where("r.push_token", "=", binding.mappingToken)
			.where("r.superseded_at", "is", null)
			.$if(claim === "held", (q) => q.where("r.released_at", "is", null))
			.whereRef("b.remote_app_id", "=", "r.remote_id")
			.executeTakeFirst();
		if (!held)
			throw new DeploymentFoldBindingChangedError(
				"The deployment comparison changed while its reference was being read.",
			);
		source = { kind: "certificate", stateText: held.state };
		start = binding.foldSeq;
	} else {
		source = {
			kind: "published",
			canonical: await readCanonicalFoldInputs(db, {
				appId,
				seq: novaRevision,
			}),
		};
	}
	const suffix = (
		await readAppChangeStreamRowsSince(db, appId, start, headSeq)
	).map((row) => ({
		seq: row.seq,
		batch_id: row.batch_id,
		run_id: row.run_id,
		actor_id: row.actor_id,
		kind: row.kind,
		mutationsText: row.mutations_text,
		from_project_id: row.from_project_id,
		to_project_id: row.to_project_id,
	}));
	return { appId, headSeq, startSeq: start, start: source, suffix };
}

/**
 * Whether a deployment's baseline and revision are a pair a comparison can
 * stand on: the baseline holds a source that still verifies (origin `push`,
 * `read` or `changes`), it names a revision, a `push` baseline's revision is
 * the live app mapping's `pushed_revision`. Revisions before the current
 * horizon need the certified comparison which the verified baseline binds.
 */
type ReferenceMapping = Pick<
	DeploymentResource,
	"pushedRevision" | "deploymentId" | "remoteId"
>;

export function usablePair(
	baseline: AppBaseline | null,
	mapping: (ReferenceMapping & Pick<DeploymentResource, "releasedAt">) | null,
	foldSeq: number | null,
): boolean {
	return (
		mapping !== null &&
		mapping.releasedAt === null &&
		mapping.remoteId === baseline?.remoteAppId &&
		hasPublishedComparison(baseline, mapping, foldSeq)
	);
}

/** Whether this mapping has a comparison to preserve even while its claim is released. */
export function hasPublishedComparison(
	baseline: AppBaseline | null,
	mapping: ReferenceMapping,
	foldSeq: number | null,
): boolean {
	if (baseline === null) return false;
	if (
		baseline.origin !== "push" &&
		baseline.origin !== "read" &&
		baseline.origin !== "changes"
	)
		return false;
	const revision = baseline.novaRevision;
	if (revision === null) return false;
	if (baseline.origin === "push" && mapping.pushedRevision !== revision)
		return false;
	if (foldSeq === null) return false;
	if (revision >= foldSeq) return true;
	const binding = baseline.foldBinding;
	return (
		binding !== undefined &&
		binding.foldSeq === foldSeq &&
		binding.novaRevision === revision &&
		binding.sourceDigest === baseline.sourceDigest &&
		binding.remoteAppId === baseline.remoteAppId &&
		binding.deploymentId === mapping.deploymentId &&
		binding.remoteAppId === mapping.remoteId
	);
}
