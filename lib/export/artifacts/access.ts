import "server-only";
import { sql, type Transaction } from "kysely";
import { ApiError } from "@/lib/apiError";
import {
	dataAccessLost,
	lockProjectDataGrant,
	type ProjectDataGrant,
} from "@/lib/auth/dataGrant";
import { NOVA_MCP_FLOOR_SCOPES } from "@/lib/auth-public";
import { resolveAppScopeInTransaction } from "@/lib/db/appAccess";
import type { AppDatabase } from "@/lib/db/pg";
import type { DownloadTarget } from "@/lib/deployment/downloadTarget";
import { exportTargetRevision } from "@/lib/deployment/exportTargetRevision";
import type { PlaceWorkbookWitness } from "@/lib/deployment/placeWorkbook";
import type { PreparedExportBoundary } from "@/lib/export/boundaryValidation";
import {
	type AssignmentWitness,
	authorizeAssignmentExport,
} from "@/lib/export/privateAssignments";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

export interface ExportActor {
	userId: string;
	grant: ProjectDataGrant;
}

export interface ExportSpec {
	appId: string;
	projectId: string;
	documentRevision: number;
	dataRevision: string;
	targetRevision: string;
	target: { server: string; domain: string; appId: string } | null;
	format: "zip" | "ccz";
	filename: string;
	assignments?: AssignmentWitness;
	places?: PlaceWorkbookWitness;
}

export function compileExportSpec(
	appId: string,
	prepared: PreparedExportBoundary,
	download: DownloadTarget,
	filename: string,
): ExportSpec {
	if (download.targetRevision === undefined)
		throw new Error("A retained export needs its deployment revision.");
	return {
		appId,
		projectId: prepared.lookupSnapshot.projectId,
		documentRevision: prepared.compiledAtSeq,
		dataRevision: prepared.lookupSnapshot.projectRevision,
		targetRevision: download.targetRevision,
		target: download.format === "ccz" ? download.runtimeTarget : null,
		assignments: prepared.assignmentWitness,
		format: download.format === "ccz" ? "ccz" : "zip",
		filename,
	};
}

export function artifactUnavailable(): never {
	throw new ApiError(
		"This download is no longer available. You can prepare a new file in Publish.",
		404,
	);
}

export async function lockExportAccess(
	tx: Transaction<AppDatabase>,
	actor: ExportActor,
	spec: ExportSpec,
): Promise<string> {
	const scope = await resolveAppScopeInTransaction(
		tx,
		spec.appId,
		actor.userId,
		spec.assignments || spec.places ? "edit" : "view",
	);
	if (scope.projectId !== spec.projectId) return artifactUnavailable();
	const grant = await lockProjectDataGrant(
		tx,
		actor.userId,
		actor.grant,
		NOVA_MCP_FLOOR_SCOPES,
	);
	const protectedTarget = spec.places?.target ?? spec.assignments?.target;
	const destination = protectedTarget
		? await authorizeAssignmentExport(
				tx,
				{
					appId: spec.appId,
					projectId: spec.projectId,
					actorUserId: actor.userId,
				},
				actor.grant,
				protectedTarget,
			)
		: null;
	if (spec.places) {
		const org = await sql<{ revision: string }>`
			SELECT revision::text FROM app_organization_state WHERE app_id=${spec.appId} FOR SHARE
		`.execute(tx);
		if (org.rows[0]?.revision !== spec.places.organizationRevision)
			return artifactUnavailable();
	}
	const member = await sql<{
		id: string;
		version: string;
	}>`SELECT id, xmin::text AS version FROM auth_member WHERE "userId"=${actor.userId} AND "organizationId"=${scope.projectId}`.execute(
		tx,
	);
	if (!member.rows[0]) return dataAccessLost();
	const result = await sql<{
		revision: string;
	}>`SELECT revision::text AS revision FROM lookup_project_state WHERE project_id=${scope.projectId} FOR SHARE`.execute(
		tx,
	);
	if (
		scope.baseSeq !== spec.documentRevision ||
		(result.rows[0]?.revision ?? "0") !== spec.dataRevision ||
		(await exportTargetRevision(tx, scope.projectId, spec.appId)) !==
			spec.targetRevision
	)
		return artifactUnavailable();
	return canonicalJsonDigest([
		actor.userId,
		grant,
		destination,
		actor.grant.kind === "oauth"
			? [actor.grant.issuedAt, actor.grant.expiresAt]
			: null,
		member.rows[0],
	]);
}
