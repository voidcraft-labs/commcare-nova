/**
 * The birth of an app brought in from CommCare HQ, as the create's one
 * transaction writes it: the HQ app's claim, the production genesis writer,
 * then `recordAdoptedDeploymentInTransaction`. Shared by the Postgres suites
 * that read or end what that birth records.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Transaction } from "kysely";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import type { AppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	prepareGenesisCandidate,
	writePreparedGenesisInTransaction,
} from "@/lib/db/appGenesis";
import { claimHqAppInTransaction } from "@/lib/db/hqAppClaims";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { canonicalAppGenesis, emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import type { Uuid } from "@/lib/domain/uuid";
import type { HqMediaRecord } from "../hqMedia";
import {
	type AdoptedDeploymentWrite,
	type DeploymentScope,
	type DeploymentTargetKey,
	recordAdoptedDeploymentInTransaction,
} from "../store";
import type {
	AppOwnership,
	DeploymentConfirmationKey,
	DeploymentWithResources,
} from "../types";

export const BIRTH_AT = new Date("2026-11-10T09:30:00.000Z");
export const READ_AT = "2026-11-10T09:29:00.000Z";
export const HELD_PATH = "commcare/image/logo.png";
export const HELD_FILE_ID = "hq-file-1";
export const MEDIA_FILES: HqMediaRecord = { [HELD_PATH]: HELD_FILE_ID };
export const OWNERSHIP: AppOwnership = {
	addOns: ["display_conditions"],
	profileProperties: ["cc-content-valid", "cc-gps-auto-capture"],
	profileCustomProperties: [],
	autoGpsCapture: false,
};
export const CONFIRMATIONS: readonly DeploymentConfirmationKey[] = [
	{ kind: "plan-feature", subject: "web-apps" },
];
export const SOURCE = { name: "Clinic visits", modules: [], langs: ["en"] };

/** The normalized source's text as a baseline stores it. */
const SOURCE_TEXT = JSON.stringify(SOURCE);

export interface AdoptedBirth {
	readonly scope: DeploymentScope;
	readonly target: DeploymentTargetKey;
	readonly remoteAppId: string;
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly operationUuid: Uuid;
	readonly prefix: string;
	readonly assetId: MediaAssetId;
	readonly deployment: DeploymentWithResources;
}

/** A ready media asset of the Project, which a held path names. */
export async function seedAsset(
	h: AppStateTestDb,
	projectId: string,
	actorUserId: string,
	label: string,
): Promise<MediaAssetId> {
	const assetId = testMediaAssetId(`asset-${label}`);
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id: assetId,
			project_id: projectId,
			owner: actorUserId,
			content_hash: testUuid(`hash-${label}`).replaceAll("-", "").repeat(2),
			mime_type: "image/png",
			extension: ".png",
			size_bytes: 256,
			dimensions: JSON.stringify({ width: 32, height: 32 }),
			duration_ms: null,
			kind: "image",
			gcs_object_key: `projects/${projectId}/${assetId}.png`,
			original_filename: "logo.png",
			display_name: "Logo",
			status: "ready",
			media_format: "png",
			extract: null,
		})
		.execute();
	return assetId;
}

/**
 * Birth `appId` in `projectId` from the HQ app `remoteAppId` on `target`, in
 * one transaction. `afterWrite` runs inside that transaction once the writer
 * has returned, so a throw there rolls the whole birth back. The actor must
 * already be a member of the Project with `edit`.
 */
export async function birthAdoptedApp(
	h: AppStateTestDb,
	input: {
		readonly appId: string;
		readonly projectId: string;
		readonly actorUserId: string;
		readonly target: DeploymentTargetKey;
		readonly remoteAppId: string;
		/** Leave out the claim, to meet the index the claim stands on. */
		readonly skipClaim?: boolean;
		readonly writeOverrides?: Partial<AdoptedDeploymentWrite>;
		readonly afterWrite?: (tx: Transaction<AppDatabase>) => Promise<void>;
	},
): Promise<AdoptedBirth> {
	const label = `${input.appId}-${input.target.domain}`;
	const assetId = await seedAsset(h, input.projectId, input.actorUserId, label);
	const genesis = canonicalAppGenesis(emptyBlueprintDoc(input.appId));
	const candidate = prepareGenesisCandidate({
		appId: input.appId,
		projectId: input.projectId,
		mutations: genesis.mutations,
	});
	const operationUuid = testUuid(`operation-${label}`);
	const prefix = `nova-case-v1:${testUuid(`prefix-${label}`)}:`;
	const write: AdoptedDeploymentWrite = {
		appId: input.appId,
		projectId: input.projectId,
		actorUserId: input.actorUserId,
		target: input.target,
		remoteAppId: input.remoteAppId,
		remoteRevision: 41,
		pushedRevision: 1,
		baseline: {
			origin: "read",
			remoteAppId: input.remoteAppId,
			sourceGzip: gzipSync(Buffer.from(SOURCE_TEXT, "utf8")),
			sourceBytes: Buffer.byteLength(SOURCE_TEXT, "utf8"),
			sourceDigest: createHash("sha256").update(SOURCE_TEXT).digest("hex"),
			ownership: OWNERSHIP,
			observedAt: READ_AT,
			discard: null,
			novaRevision: 1,
			mediaFiles: { kind: "set", files: MEDIA_FILES },
			firstPublish: {
				kind: "set",
				list: {
					ids: ["forms-and-settings-rewritten"],
					webAppsOnInHq: true,
					of: "first-publish",
				},
			},
		},
		identities: [
			{
				entityKind: "form",
				novaEntityUuid: genesis.formUuid,
				uniqueId: "b".repeat(32),
				xmlns:
					"http://openrosa.org/formdesigner/5A2C1F0E-0000-4000-8000-000000000001",
			},
			{
				entityKind: "module",
				novaEntityUuid: genesis.moduleUuid,
				uniqueId: "a".repeat(32),
				xmlns: null,
			},
		],
		mediaPaths: [{ assetId, wirePath: HELD_PATH }],
		keyedCaseIds: [{ operationUuid, caseType: "patient", prefix }],
		confirmations: CONFIRMATIONS,
		at: BIRTH_AT,
		...input.writeOverrides,
	};
	const deployment = await withAppTx(async (tx) => {
		if (input.skipClaim !== true) {
			await claimHqAppInTransaction(tx, {
				server: input.target.server,
				domain: input.target.domain,
				remoteAppId: input.remoteAppId,
			});
		}
		await writePreparedGenesisInTransaction(tx, {
			candidate,
			actorUserId: input.actorUserId,
			runId: testUuid(`run-${label}`),
			status: "complete",
		});
		const written = await recordAdoptedDeploymentInTransaction(tx, write);
		await input.afterWrite?.(tx);
		return written;
	});
	return {
		scope: {
			appId: input.appId,
			projectId: input.projectId,
			role: "owner",
			actorUserId: input.actorUserId,
		},
		target: input.target,
		remoteAppId: input.remoteAppId,
		moduleUuid: genesis.moduleUuid,
		formUuid: genesis.formUuid,
		operationUuid,
		prefix,
		assetId,
		deployment,
	};
}
