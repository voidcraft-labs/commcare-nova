import "server-only";

import { sql, type Transaction } from "kysely";
import { ApiError } from "@/lib/apiError";
import type { ProjectDataGrant } from "@/lib/auth/dataGrant";
import { listHqLookupTables } from "@/lib/commcare/hq/lookupTables";
import {
	lookupJsonDefinition,
	lookupJsonRowContent,
} from "@/lib/commcare/lookup/jsonRows";
import {
	resolveAppAccess,
	resolveAppScopeInTransaction,
} from "@/lib/db/appAccess";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { getHqCredentials } from "@/lib/db/settings";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { PersistableDoc } from "@/lib/domain";
import {
	type PreparedExportBoundary,
	prepareExportBoundary,
} from "@/lib/export/boundaryValidation";
import { authorizeAssignmentExport } from "@/lib/export/privateAssignments";
import type { ManualLookupManifest } from "@/lib/publish/manualLookupManifest";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { readLookupJsonDestination } from "./lookupJsonLedger";
import { lookupJsonDefinitionDigest } from "./lookupJsonPlan";
import type { LookupJsonPushPlan } from "./preflight";
import { pushLookupTablesJson } from "./service";
import {
	type DeploymentScope,
	type DeploymentTargetKey,
	readDeployment,
} from "./store";
import type { WorkbookTableIntent } from "./workbookAuthority";

function tablesToInstall(
	prepared: PreparedExportBoundary,
): LookupJsonPushPlan["tables"] {
	return (prepared.jsonLookupTables ?? []).map((naming) => {
		const paged = prepared.pagedJsonRows?.get(naming.tableId);
		const inline = prepared.lookupSnapshot.rowsByTable.get(naming.tableId);
		if (!paged && !inline)
			throw new Error("The manual lookup plan lost a table.");
		return {
			tableId: naming.tableId,
			tag: naming.tag,
			name:
				prepared.lookupSnapshot.definitions.find(
					({ id }) => id === naming.tableId,
				)?.name ?? naming.tag,
			definition: lookupJsonDefinition(naming),
			rows:
				paged?.rows ??
				(inline ?? []).map((row) => ({
					novaRowId: row.id,
					content: lookupJsonRowContent(naming, row),
				})),
			...(paged && { pagedBytes: paged.bytes }),
		};
	});
}

export function manualLookupManifest(
	appId: string,
	prepared: PreparedExportBoundary,
): ManualLookupManifest {
	return {
		version: 1,
		appId,
		documentRevision: prepared.compiledAtSeq,
		dataRevision: prepared.lookupSnapshot.projectRevision,
		digest: canonicalJsonDigest(tablesToInstall(prepared)),
	};
}

function changed(): never {
	throw new ApiError(
		"This install plan changed. You can download a new import file in Publish.",
		409,
	);
}

export async function installManualLookupData(input: {
	actorUserId: string;
	grant: ProjectDataGrant;
	target: DeploymentTargetKey;
	manifest: ManualLookupManifest;
	confirm?: string;
}) {
	const { actorUserId, grant, target, manifest } = input;
	const access = await resolveAppAccess(manifest.appId, actorUserId, "edit");
	const scope: DeploymentScope = {
		appId: manifest.appId,
		projectId: access.projectId,
		actorUserId,
		role: access.role,
	};
	if (access.app.mutation_seq !== manifest.documentRevision) return changed();
	const connection = await getHqCredentials(actorUserId, target.domain);
	if (!connection.ok || connection.creds.server !== target.server)
		throw new ApiError(
			"Connect to this CommCare HQ project space before installing lookup data.",
			403,
		);
	const grantBinding = await withAppTx((tx) =>
		authorizeAssignmentExport(
			tx,
			scope,
			grant,
			target,
			"publish",
			connection.connectionDigest,
		),
	);
	const checkRevision = async (tx: Transaction<AppDatabase>) => {
		const current = await resolveAppScopeInTransaction(
			tx,
			scope.appId,
			actorUserId,
			"edit",
		);
		const stored = await sql<{
			revision: string;
		}>`SELECT revision::text FROM lookup_project_state WHERE project_id=${scope.projectId} FOR SHARE`.execute(
			tx,
		);
		if (
			current.projectId !== scope.projectId ||
			current.baseSeq !== manifest.documentRevision ||
			(stored.rows[0]?.revision ?? "0") !== manifest.dataRevision
		)
			return changed();
	};
	const requireOperation = (tx?: Transaction<AppDatabase>) =>
		tx ? checkRevision(tx) : withAppTx(checkRevision);
	await requireOperation();
	const prepared = await prepareExportBoundary({
		mode: "hq-json",
		manualLookupInstaller: true,
		access: scope,
		doc: hydratePersistedBlueprint(access.app.blueprint as PersistableDoc),
		compiledAtSeq: manifest.documentRevision,
		attachmentTarget: null,
		streamMedia: true,
		archiveActor: () => ({
			appId: scope.appId,
			grant,
			recheck: requireOperation,
		}),
	});
	if (!prepared.ok) return changed();
	const expected = manualLookupManifest(scope.appId, prepared.prepared);
	if (
		expected.dataRevision !== manifest.dataRevision ||
		expected.digest !== manifest.digest
	)
		return changed();
	const tables = tablesToInstall(prepared.prepared);
	if (!tables.length) return changed();
	const current = await readDeployment(scope, target);
	const expectedEndings = current?.deployment.endings ?? 0;

	// Review all target definitions before the first write. Row-level drift
	// and unresolved writes are handled by the same journal as direct publish.
	const remote = await listHqLookupTables(connection.creds, target.domain);
	if ("success" in remote)
		throw new ApiError(
			"CommCare HQ did not confirm the destination lookup tables.",
			409,
		);
	const db = await getAppDb();
	for (const table of tables) {
		const { ledger, open } = await readLookupJsonDestination(db, {
			projectId: scope.projectId,
			...target,
			tableId: table.tableId,
		});
		const held = remote.find((item) => item.tag === table.tag);
		if (
			(ledger?.tag === table.tag &&
				(held?.id !== ledger.remoteTableId ||
					!held.isGlobal ||
					ledger.definitionDigest !==
						lookupJsonDefinitionDigest(table.definition))) ||
			(ledger?.tag !== table.tag &&
				held &&
				!(open?.kind === "create-table" && open.tag === table.tag))
		)
			throw new ApiError(
				`CommCare HQ already holds “${table.name}” differently. You can review the table in that project space.`,
				409,
			);
	}

	const confirmation = canonicalJsonDigest([
		expected,
		target,
		expectedEndings,
		grantBinding,
		connection.connectionDigest,
	]);
	if (input.confirm === undefined)
		return {
			status: "review" as const,
			confirmation,
			target,
			tables: tables.map(({ name, tag, rows }) => ({
				name,
				tag,
				rows: rows.length,
			})),
		};
	if (input.confirm !== confirmation) return changed();
	const intents = new Map<string, WorkbookTableIntent>();
	for (const table of prepared.prepared.lookupSnapshot.definitions) {
		if (!tables.some(({ tableId }) => table.id === tableId)) continue;
		if (table.rowsRevision === undefined) return changed();
		intents.set(table.id, {
			tag: table.tag,
			definitionRevision: table.definitionRevision,
			rowsRevision: table.rowsRevision,
			isGlobal: true,
		});
	}
	if (intents.size !== tables.length) return changed();
	const result = await pushLookupTablesJson(
		{ ...scope, requireOperation },
		target,
		connection.creds,
		target.domain,
		{
			authority: {
				grant,
				grantBinding,
				connectionDigest: connection.connectionDigest,
				tables: intents,
			},
			tables,
		},
		false,
		{ expectedEndings },
		undefined,
		[],
		true,
	);
	if (result.failure)
		return {
			status:
				result.failure.code === "hq_lookup_publish_checkpoint"
					? ("checkpoint" as const)
					: ("stopped" as const),
			message: result.failure.message,
		};
	await withAppTx(async (tx) => {
		await checkRevision(tx);
		if (
			(await authorizeAssignmentExport(
				tx,
				scope,
				grant,
				target,
				"publish",
				connection.connectionDigest,
			)) !== grantBinding
		)
			return changed();
	});
	return { status: "complete" as const, tables: result.mapped.length };
}
