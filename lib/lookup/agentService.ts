import "server-only";

import type { Transaction } from "kysely";
import {
	lockProjectDataGrant,
	type ProjectDataGrant,
} from "@/lib/auth/dataGrant";
import { type AppCapability, roleAllowsApp } from "@/lib/auth/projectRoles";
import { NOVA_MCP_FLOOR_SCOPES } from "@/lib/auth-public";
import { lockPlanForBuild } from "@/lib/db/authoringPlanGuard";
import { assertAuthoringSessionAuthorityInTransaction } from "@/lib/db/authoringSessions";
import {
	AppProjectChangedError,
	CommitReauthError,
	RunHolderLostError,
} from "@/lib/db/commitGuard";
import { assertDesignSessionRunAuthorityInTransaction } from "@/lib/db/designSessions";
import { LEASE_COLUMNS, leaseView } from "@/lib/db/leaseView";
import { readLookupReferencingApps } from "@/lib/db/lookupReferenceEdges";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
import { exactRunHolderMatches } from "@/lib/db/runHolderWrites";
import { runLeaseState } from "@/lib/db/runLiveness";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	applyLookupAuthoringBatchInTransaction,
	lookupBatchNeedsDelete,
} from "./authoringBatch";
import {readRowAssignments,searchAssignmentDirectory} from "./rowAssignments";
import type {AssignmentDirectoryQuery} from "./assignmentVocabulary";
import type {LookupRowId} from "@/lib/domain/lookupIds";
import { LookupError } from "./errors";
import type {
	LookupValueEditRequest,
	LookupValueReadRequest,
} from "./largeValues/input";
import {
	applyLookupValueEditInTransaction,
	readLookupValueInTransaction,
} from "./largeValues/service";
import { maxLookupRevision, parseLookupRevision } from "./schema";
import {
	readAllLookupDefinitionsInTransaction,
	readLookupTableRowsPageInTransaction,
} from "./service";
import type {
	LookupAgentWriteScope,
	LookupAuthoringBatchInput,
	LookupAuthoringBatchReceipt,
	LookupDefinitionsSnapshot,
	LookupRowsPage,
	LookupRowsPageInput,
} from "./types";
import {
	authorizeLookupWriteInTransaction,
	lookupReceiptCapability,
	requireLookupCapability,
} from "./writerTransaction";

interface DatabaseErrorShape {
	code?: unknown;
	constraint?: unknown;
}

function translateExpectedDatabaseError(error: unknown): never {
	if (error instanceof LookupError) throw error;
	const sqlError = error as DatabaseErrorShape;
	const constraint =
		typeof sqlError.constraint === "string" ? sqlError.constraint : "";
	if (
		sqlError.code === "23505" &&
		constraint === "lookup_tables_project_id_tag_key"
	) {
		throw new LookupError(
			"tag_taken",
			"That table tag is already used in this Project.",
			{ cause: error },
		);
	}
	if (
		sqlError.code === "23505" &&
		constraint === "lookup_columns_project_id_table_id_wire_name_key"
	) {
		throw new LookupError(
			"invalid_input",
			"That column wire name is already used in this table.",
			{ cause: error },
		);
	}
	if (
		(sqlError.code === "23514" && constraint.includes("lookup_rows")) ||
		(sqlError.code === "P0001" && constraint === "lookup_storage_capacity")
	) {
		throw new LookupError(
			"storage_limit",
			"A lookup row or table exceeds its storage limit.",
			{ cause: error },
		);
	}
	throw error;
}

export async function authorizeAgentScopeInTransaction(
	tx: Transaction<AppDatabase>,
	scope: LookupAgentWriteScope,
	capability: AppCapability,
): Promise<{ projectId: string; role: string }> {
	if (scope.ordinaryAuthoring !== undefined) {
		const authority = scope.ordinaryAuthoring;
		const session = await assertAuthoringSessionAuthorityInTransaction(tx, {
			sessionId: authority.sessionId,
			actorUserId: scope.actorId,
			expectedProjectId: scope.projectId,
			origin: authority.origin,
			threadId: authority.origin === "chat" ? authority.threadId : undefined,
			chatRunHolder: scope.chatRunHolder,
			allowIdleChat: capability === "view",
		});
		const role = await projectRoleForInTransaction(
			tx,
			scope.actorId,
			session.projectId,
		);
		if (role === null || !roleAllowsApp(role, capability))
			throw new CommitReauthError("You no longer have access to this Project.");
		return { projectId: session.projectId, role };
	}
	if (scope.designSessionId !== undefined) {
		if (scope.chatRunHolder?.mode !== "build")
			throw new RunHolderLostError("released");
		await assertDesignSessionRunAuthorityInTransaction(tx, {
			designSessionId: scope.designSessionId,
			actorUserId: scope.actorId,
			expectedProjectId: scope.projectId,
			holder: scope.chatRunHolder,
		});
		const role = await projectRoleForInTransaction(
			tx,
			scope.actorId,
			scope.projectId,
		);
		if (role === null || !roleAllowsApp(role, capability))
			throw new CommitReauthError("You no longer have access to this Project.");
		if (capability !== "view") {
			await lockPlanForBuild(tx, scope.designSessionId);
			const workspace = await tx
				.selectFrom("authoring_workspaces")
				.select("id")
				.where("design_session_id", "=", scope.designSessionId)
				.where("status", "=", "open")
				.executeTakeFirst();
			if (!workspace)
				throw new LookupError(
					"invalid_input",
					"Start building before changing Project data.",
				);
		}
		return { projectId: scope.projectId, role };
	}
	const app = await tx
		.selectFrom("apps")
		.select(["project_id", "deleted_at", ...LEASE_COLUMNS])
		.where("id", "=", scope.appId)
		.forUpdate()
		.executeTakeFirst();
	if (app === undefined || app.deleted_at !== null) {
		if (scope.chatRunHolder !== undefined) {
			throw new CommitReauthError("App not found.");
		}
		throw new LookupError("not_found", "Lookup resource was not found.");
	}
	if (app.project_id !== scope.projectId) {
		if (scope.chatRunHolder !== undefined) throw new AppProjectChangedError();
		throw new LookupError("not_found", "Lookup resource was not found.");
	}
	const role = await projectRoleForInTransaction(
		tx,
		scope.actorId,
		app.project_id,
	);
	/* A chat holder belongs to an authoring run. Losing edit capability is a
	 * terminal run-authority change even when its next tool happens to be a
	 * read; MCP has no held run and may use ordinary viewer reads. */
	const requiredCapability =
		scope.chatRunHolder === undefined ? capability : "edit";
	if (role === null || !roleAllowsApp(role, requiredCapability)) {
		if (scope.chatRunHolder !== undefined) {
			throw new CommitReauthError(
				requiredCapability === "view"
					? "You no longer have access to this app's Project."
					: "You no longer have edit access to this app's Project.",
			);
		}
		throw new LookupError("not_found", "Lookup resource was not found.");
	}
	if (scope.chatRunHolder !== undefined) {
		const lease = runLeaseState(leaseView(app));
		if (
			!lease.live ||
			!exactRunHolderMatches(lease.holderIdentity, scope.chatRunHolder)
		) {
			throw new RunHolderLostError(lease.present ? "superseded" : "released");
		}
	}
	return { projectId: app.project_id, role };
}

/** Reprove the app tenant, fresh membership, and exact chat holder under one
 * app-row lock before the Project-data transaction takes its Project/table
 * locks. MCP omits the holder and relies on its fresh actor authorization. */
async function applyAuthorized(
	scope: LookupAgentWriteScope,
	input: LookupAuthoringBatchInput,
): Promise<LookupAuthoringBatchReceipt> {
	return withAppTx(async (tx) => {
		const authorized = await authorizeAgentScopeInTransaction(
			tx,
			scope,
			"edit",
		);
		const targetKey =
			scope.ordinaryAuthoring !== undefined
				? `work:${scope.ordinaryAuthoring.sessionId}`
				: scope.designSessionId !== undefined
					? `session:${scope.designSessionId}`
					: `app:${scope.appId}`;
		const inputDigest = canonicalJsonDigest(input);
		/* The role was read just above on this transaction, under the app row;
		 * the lookup authority reads the same locked member row. */
		const authority = await authorizeLookupWriteInTransaction(
			tx,
			{ projectId: authorized.projectId, actorId: scope.actorId },
			"edit",
		);
		const prior = await tx
			.selectFrom("lookup_authoring_receipts")
			.select(["input_digest", "receipt", "actor_id", "required_capability"])
			.where("project_id", "=", authorized.projectId)
			.where("target_key", "=", targetKey)
			.where("request_id", "=", scope.requestId)
			.executeTakeFirst();
		if (prior) {
			if (prior.actor_id !== scope.actorId)
				throw new LookupError("not_found", "Lookup resource was not found.");
			requireLookupCapability(
				tx,
				authority,
				prior.required_capability ??
					(lookupBatchNeedsDelete(input) ? "delete" : "edit"),
			);
			if (prior.input_digest !== inputDigest)
				throw new LookupError(
					"invalid_input",
					"This request already completed with different input.",
				);
			return prior.receipt;
		}
		const receipt = await applyLookupAuthoringBatchInTransaction(
			tx,
			authority,
			input,
		);
		await tx
			.insertInto("lookup_authoring_receipts")
			.values({
				project_id: authorized.projectId,
				target_key: targetKey,
				request_id: scope.requestId,
				input_digest: inputDigest,
				required_capability: lookupReceiptCapability(authority),
				receipt: JSON.stringify(receipt),
				actor_id: scope.actorId,
				run_id: scope.runId,
			})
			.execute();
		return receipt;
	});
}

export async function readAuthorizedLookupCatalog(
	scope: LookupAgentWriteScope,
): Promise<LookupDefinitionsSnapshot> {
	return withAppTx(
		async (tx) => {
			const authorized = await authorizeAgentScopeInTransaction(
				tx,
				scope,
				"view",
			);
			return readAllLookupDefinitionsInTransaction(tx, authorized.projectId);
		},
		{ isolationLevel: "repeatable read" },
	);
}

/** Advisory reader inventory for an explicit review. The writer rechecks the complete set under lock. */
export function readAuthorizedTableReaders(
	scope: LookupAgentWriteScope,
	tableId: LookupTableId,
	page: { offset: number; digest?: string },
) {
	return withAppTx(
		async (tx) => {
			const { projectId } = await authorizeAgentScopeInTransaction(
				tx,
				scope,
				"view",
			);
			const table = await tx
				.selectFrom("lookup_tables")
				.select(["definition_revision", "rows_revision"])
				.where("project_id", "=", projectId)
				.where("id", "=", tableId)
				.executeTakeFirst();
			if (!table) throw new LookupError("not_found", "Lookup table not found.");
			const state = await tx
				.selectFrom("lookup_project_state")
				.select("revision")
				.where("project_id", "=", projectId)
				.executeTakeFirst();
			const apps = await readLookupReferencingApps(tx, { projectId, tableId });
			const projectRevision = parseLookupRevision(state?.revision ?? "0");
			const tableRevision = maxLookupRevision(
				parseLookupRevision(table.definition_revision),
				parseLookupRevision(table.rows_revision),
			);
			const digest = canonicalJsonDigest({
				projectId,
				tableId,
				apps,
				projectRevision,
				tableRevision,
			});
			if ((page.offset && page.digest !== digest) || page.offset > apps.length)
				throw new LookupError(
					"conflict",
					"The list of apps using this table changed. You can read it again from the beginning.",
				);
			const readers = apps
				.slice(page.offset, page.offset + 25)
				.map((app) => ({ ...app, appName: app.appName.slice(0, 256) }));
			const end = page.offset + readers.length;
			return {
				tableId,
				projectRevision,
				tableRevision,
				readers,
				complete: end === apps.length,
				...(end < apps.length && { nextReaderPage: { offset: end, digest } }),
			};
		},
		{ isolationLevel: "repeatable read" },
	);
}

export async function readAuthorizedLookupRowsPage(
	scope: LookupAgentWriteScope,
	input: LookupRowsPageInput,
): Promise<LookupRowsPage> {
	return withAppTx(
		async (tx) => {
			const authorized = await authorizeAgentScopeInTransaction(
				tx,
				scope,
				"view",
			);
			return readLookupTableRowsPageInTransaction(
				tx,
				authorized.projectId,
				input,
				{
					resultEnvelope: (page) => ({ kind: "read", data: page }),
				},
			);
		},
		{ isolationLevel: "repeatable read" },
	);
}

export async function readAuthorizedLookupValue(
	scope: LookupAgentWriteScope,
	input: LookupValueReadRequest,
	grant?: ProjectDataGrant,
) {
	return withAppTx(async (tx) => {
		const auth = await authorizeAgentScopeInTransaction(tx, scope, "view");
		if (grant)
			await lockProjectDataGrant(
				tx,
				scope.actorId,
				grant,
				NOVA_MCP_FLOOR_SCOPES,
			);
		return readLookupValueInTransaction(
			tx,
			{ ...auth, actorId: scope.actorId },
			input,
		);
	});
}

export async function editAuthorizedLookupValue(
	scope: LookupAgentWriteScope,
	input: LookupValueEditRequest,
	grant?: ProjectDataGrant,
) {
	return withAppTx(async (tx) => {
		const auth = await authorizeAgentScopeInTransaction(tx, scope, "edit");
		const authority = await authorizeLookupWriteInTransaction(
			tx,
			{ ...auth, actorId: scope.actorId },
			"edit",
		);
		if (!grant && !scope.chatRunHolder)
			throw new LookupError(
				"not_found",
				"This edit needs a current connection. You can reconnect and reopen the row.",
			);
		const grantKey = grant
			? await lockProjectDataGrant(
					tx,
					scope.actorId,
					grant,
					NOVA_MCP_FLOOR_SCOPES,
				)
			: ["chat", scope.chatRunHolder?.runId, scope.chatRunHolder?.nonce];
		const binding = canonicalJsonDigest([
			scope.projectId,
			scope.actorId,
			scope.ordinaryAuthoring ?? scope.designSessionId ?? scope.appId,
			grantKey,
		]);
		return applyLookupValueEditInTransaction(tx, authority, input, binding);
	});
}

export async function applyAuthorizedLookupAuthoringBatch(
	scope: LookupAgentWriteScope,
	input: LookupAuthoringBatchInput,
): Promise<LookupAuthoringBatchReceipt> {
	try {
		return await applyAuthorized(scope, input);
	} catch (error) {
		translateExpectedDatabaseError(error);
	}
}


export function readAuthorizedRowAssignments(scope:LookupAgentWriteScope,tableId:LookupTableId,rowId:LookupRowId,search:AssignmentDirectoryQuery,grant?:ProjectDataGrant){
	return withAppTx(async tx=>{
		await authorizeAgentScopeInTransaction(tx,scope,"edit");
		if(grant)await lockProjectDataGrant(tx,scope.actorId,grant,NOVA_MCP_FLOOR_SCOPES);
		return {selected:await readRowAssignments(tx,scope.projectId,tableId,rowId),...await searchAssignmentDirectory(tx,scope.projectId,search)};
	},{isolationLevel:"repeatable read"});
}
