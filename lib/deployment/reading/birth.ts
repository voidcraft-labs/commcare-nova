import "server-only";

/**
 * The `hq-adoption` birth: an app brought in from CommCare HQ is born in one
 * transaction with the claim on its HQ app, its lookup tables and places, and
 * its adopted deployment. Also the activation receipt such a birth hands the
 * client, made at the birth or read back for a create that already happened.
 */

import type { Transaction } from "kysely";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import { resolveAuthorizedAppSnapshot } from "@/lib/db/appAccess";
import {
	type AdoptedAppReceipt,
	genesisBatchId,
	type PreparedGenesisCandidate,
	writePreparedGenesisInTransaction,
} from "@/lib/db/appGenesis";
import {
	claimHqAppInTransaction,
	HqAppAlreadyClaimedError,
	type HqAppKey,
} from "@/lib/db/hqAppClaims";
import type { AppDatabase } from "@/lib/db/pg";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	adoptedAppBaselineWrite,
	adoptedIdentityRows,
	adoptedKeyedCaseIdRows,
	adoptionPlanFeatureConfirmations,
	assignMediaPaths,
} from "../adoption";
import { hqMediaRecordFromSource } from "../hqMedia";
import {
	type AdoptedDeploymentWrite,
	recordAdoptedDeploymentInTransaction,
} from "../store";
import type { AcceptedDeclaration } from "./acceptance";
import { adoptionExportBoundary } from "./adoptionBoundary";
import { firstPublishListToStore } from "./firstPublishChanges";
import type { Gathered } from "./gather";
import type { ReadingProjectDataWrite } from "./projectData";
import { writeBroughtInLookupTablesInTransaction } from "./projectData/lookupTableStore";
import { writeBroughtInPlacesInTransaction } from "./projectData/placeStore";
import type { ReadingKey } from "./types";

// ---------------------------------------------------------------------------
// The adopted deployment's write
// ---------------------------------------------------------------------------

/**
 * Where the app came from, as its birth records it, from the run the birth
 * is made from and the declaration the person chose. `remoteRevision` is the
 * save counter this create's own bracketed read held, never the review's: the
 * digest leaves the counter out, so recording an earlier one beside this
 * create's baseline would make the first publish's drift check stop for a
 * save nobody needs to see. `ok: false` where a form of the reading has no
 * real CommCare HQ id.
 */
export function adoptedDeploymentWrite(input: {
	readonly appId: string;
	readonly key: ReadingKey;
	readonly actorUserId: string;
	readonly gathered: Gathered;
	/** The declaration the person chose, from `gathered.accepted.declarations`. */
	readonly chosen: AcceptedDeclaration;
	readonly candidate: PreparedGenesisCandidate;
}):
	| { readonly ok: true; readonly write: Omit<AdoptedDeploymentWrite, "at"> }
	| { readonly ok: false } {
	const { key, gathered, chosen, candidate } = input;
	const { fetched, draft } = gathered;
	const identities = adoptedIdentityRows(draft.identities, fetched.modules);
	if (!identities.ok) return { ok: false };
	const target = { server: key.server, domain: key.domain };
	const mediaPaths = assignMediaPaths(gathered.mediaFiles).rows;
	const doc = candidate.prepared.nextDoc;
	const baseline = adoptedAppBaselineWrite({
		remoteAppId: key.remoteAppId,
		source: fetched.source,
		prepared: adoptionExportBoundary(
			doc,
			gathered.lookup.definitions,
			gathered.mediaFiles,
			{ origin: COMMCARE_SERVERS[key.server].baseUrl, domain: key.domain },
		),
		target,
		identity: targetWireIdentity(identities.rows),
		novaRevision: 1,
		mediaFiles: hqMediaRecordFromSource(
			mediaPaths.map((row) => row.wirePath),
			fetched.source.multimediaMap ?? [],
		),
		observedAt: fetched.readAt,
		firstPublish: firstPublishListToStore(chosen.firstPublish, draft.facts),
	});
	return {
		ok: true,
		write: {
			appId: input.appId,
			projectId: key.projectId,
			actorUserId: input.actorUserId,
			target,
			remoteAppId: key.remoteAppId,
			remoteRevision: fetched.hqVersion,
			pushedRevision: 1,
			baseline,
			identities: identities.rows,
			mediaPaths,
			keyedCaseIds: adoptedKeyedCaseIdRows(draft.identities),
			confirmations: adoptionPlanFeatureConfirmations({
				doc,
				target,
				sourceWebAppsOn: fetched.source.cloudcareEnabled,
				sourceHoldsSaveToCase: gathered.accepted.sourceHoldsSaveToCase,
			}),
		},
	};
}

// ---------------------------------------------------------------------------
// The one transaction
// ---------------------------------------------------------------------------

export interface AdoptionBirth {
	readonly actorUserId: string;
	/** Attribution only: an adoption holds no run. Minted outside the transaction. */
	readonly runId: string;
	readonly candidate: PreparedGenesisCandidate;
	readonly hqApp: HqAppKey;
	/** The origin, the tables to create or refresh, and the places to copy (null where the app
	 *  reads none). */
	readonly projectData: ReadingProjectDataWrite;
	/** The adopted deployment's write, less its time. */
	readonly deployment: Omit<AdoptedDeploymentWrite, "at">;
	readonly at: Date;
}

export type AdoptionOutcome =
	| { readonly kind: "born"; readonly role: string }
	/** This reading's create already committed: answer from the saved app. */
	| { readonly kind: "replay" };

/**
 * The birth, inside the caller's transaction, in one lock order: the HQ
 * app's claim (its advisory lock, and the row of a holder in recently
 * deleted), then the genesis tail (the shared membership gate, the app row,
 * then in its seam the Project's lookup state with the tables and the new
 * app's places, then the gate, export readiness, media, entities, the
 * baseline and the case schemas), then the adopted deployment. After Project
 * state nothing here asks for an existing app's row. The body has no side
 * effect of its own, so a retry runs the same statements.
 */
export async function adoptHqAppInTransaction(
	tx: Transaction<AppDatabase>,
	birth: AdoptionBirth,
): Promise<AdoptionOutcome> {
	const { candidate, actorUserId, projectData, at } = birth;
	const { appId, projectId } = candidate;
	try {
		await claimHqAppInTransaction(tx, birth.hqApp);
	} catch (error) {
		if (
			error instanceof HqAppAlreadyClaimedError &&
			error.holder?.appId === appId
		)
			return { kind: "replay" };
		throw error;
	}
	await writePreparedGenesisInTransaction(tx, {
		candidate,
		actorUserId,
		runId: birth.runId,
		status: "complete",
		afterAppInsert: async (inner) => {
			await writeBroughtInLookupTablesInTransaction(
				inner,
				{ projectId, actorUserId, appId },
				{
					origin: projectData.origin,
					tables: projectData.tables,
					readAt: projectData.tablesReadAt,
				},
			);
			await writeBroughtInPlacesInTransaction(
				inner,
				{ appId, projectId, actorUserId },
				{ origin: projectData.origin, places: projectData.places, at },
			);
		},
	});
	await recordAdoptedDeploymentInTransaction(tx, { ...birth.deployment, at });
	const role = await projectRoleForInTransaction(tx, actorUserId, projectId);
	if (role === null) {
		throw new Error(
			"Nova brought an app in for a person the same transaction had just found able to edit its Project, and then found no role for them. The membership gate is held from the genesis tail to the commit, so look at lib/db/projectMembership.ts.",
		);
	}
	return { kind: "born", role };
}

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

function adoptionOf(key: ReadingKey): AdoptedAppReceipt["adoption"] {
	return {
		server: key.server,
		domain: key.domain,
		remoteAppId: key.remoteAppId,
	};
}

/** The receipt of the birth that just committed: the candidate at sequence 1. */
export function adoptedAppReceipt(
	candidate: PreparedGenesisCandidate,
	key: ReadingKey,
	role: string,
): AdoptedAppReceipt {
	return {
		eventVersion: 1,
		designSessionId: null,
		appId: candidate.appId,
		projectId: candidate.projectId,
		role,
		canEdit: roleAllowsApp(role, "edit"),
		seq: 1,
		batchId: genesisBatchId(candidate.appId),
		changeSetId: null,
		snapshotDigest: candidate.candidateDigest,
		blueprint: candidate.persistable,
		starter: null,
		adoption: adoptionOf(key),
	};
}

/**
 * The receipt of a create that already happened, from the saved app as the
 * builder's own hydration reads it: its current sequence and document (it
 * may have been edited since), and the Project and role that read resolved,
 * which is the app's Project today. Rejects with `AppAccessError` where the
 * person can no longer open the app.
 */
export async function readBackAdoptedAppReceipt(
	appId: string,
	key: ReadingKey,
	actorUserId: string,
): Promise<AdoptedAppReceipt> {
	const snapshot = await resolveAuthorizedAppSnapshot(
		appId,
		actorUserId,
		"view",
	);
	const blueprint = snapshot.app.blueprint;
	return {
		eventVersion: 1,
		designSessionId: null,
		appId,
		projectId: snapshot.projectId,
		role: snapshot.role,
		canEdit: snapshot.canEdit,
		seq: snapshot.baseSeq,
		batchId: genesisBatchId(appId),
		changeSetId: null,
		snapshotDigest: canonicalJsonDigest(blueprint),
		blueprint,
		starter: null,
		adoption: adoptionOf(key),
	};
}
