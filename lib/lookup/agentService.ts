import "server-only";

import type { Transaction } from "kysely";
import { type AppCapability, roleAllowsApp } from "@/lib/auth/projectRoles";
import {
	AppProjectChangedError,
	CommitReauthError,
	RunHolderLostError,
} from "@/lib/db/commitGuard";
import { LEASE_COLUMNS, leaseView } from "@/lib/db/leaseView";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
import { exactRunHolderMatches } from "@/lib/db/runHolderWrites";
import { runLeaseState } from "@/lib/db/runLiveness";
import { applyLookupAuthoringBatchInTransaction } from "./authoringBatch";
import { LookupError } from "./errors";
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
	if (sqlError.code === "23514" && constraint.includes("lookup_rows")) {
		throw new LookupError(
			"storage_limit",
			"A lookup row or table exceeds its storage limit.",
			{ cause: error },
		);
	}
	throw error;
}

async function authorizeAgentScopeInTransaction(
	tx: Transaction<AppDatabase>,
	scope: LookupAgentWriteScope,
	capability: AppCapability,
): Promise<{ projectId: string; role: string }> {
	const app = await tx
		.selectFrom("apps")
		.select(["project_id", "deleted_at", ...LEASE_COLUMNS])
		.where("id", "=", scope.appId)
		.forShare()
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
		if (!exactRunHolderMatches(lease.holderIdentity, scope.chatRunHolder)) {
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
		return applyLookupAuthoringBatchInTransaction(
			tx,
			{
				projectId: authorized.projectId,
				actorId: scope.actorId,
				role: authorized.role,
			},
			input,
		);
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
				{ resultEnvelope: (page) => ({ kind: "read", data: page }) },
			);
		},
		{ isolationLevel: "repeatable read" },
	);
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
