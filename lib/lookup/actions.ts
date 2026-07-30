"use server";

import { type ZodError, type ZodType, z } from "zod";
import type { AppCapability } from "@/lib/auth/projectRoles";
import { getSession } from "@/lib/auth-utils";
import { AppAccessError, resolveProjectAccess } from "@/lib/db/appAccess";
import {
	type LookupReferencingApp,
	readLookupReferencingApps,
} from "@/lib/db/lookupReferenceEdges";
import { getAppDb } from "@/lib/db/pg";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { log } from "@/lib/logger";
import { LookupError, lookupFailure } from "./errors";
import {
	addLookupColumnInputSchema,
	createLookupRowInputSchema,
	createLookupTableInputSchema,
	deleteLookupRowInputSchema,
	hasUnpairedUtf16Surrogate,
	lookupExpectedTableRevisionInputSchema,
	lookupResourceReferenceQuerySchema,
	moveLookupColumnInputSchema,
	moveLookupRowInputSchema,
	removeLookupColumnInputSchema,
	retypeLookupColumnInputSchema,
	updateLookupColumnLabelInputSchema,
	updateLookupColumnWireNameInputSchema,
	updateLookupRowInputSchema,
	updateLookupTableNameInputSchema,
	updateLookupTableTagInputSchema,
} from "./schema";
import {
	applyLookupSchemaGovernance,
	LookupSchemaGovernanceError,
	type LookupSchemaGovernanceOperation,
	type LookupSchemaGovernanceResult,
} from "./schemaGovernance";
import {
	addLookupColumn,
	createLookupRow,
	createLookupTable,
	deleteLookupRow,
	getAllLookupDefinitions,
	getLookupDefinitions,
	getLookupManifest,
	getLookupTable,
	moveLookupColumn,
	moveLookupRow,
	updateLookupColumnLabel,
	updateLookupColumnWireName,
	updateLookupRow,
	updateLookupTableName,
	updateLookupTableTag,
} from "./service";
import type {
	LookupActionErrorCode,
	LookupCreatedColumnReceipt,
	LookupCreatedRowReceipt,
	LookupDefinitionsSnapshot,
	LookupFailure,
	LookupGovernanceFailure,
	LookupManifest,
	LookupMutationReceipt,
	LookupResult,
	LookupScope,
	LookupTableSnapshot,
} from "./types";

/** A governance change's outcome: the receipt, or a refusal carrying the
 *  evidence the confirmation surface needs to explain itself. */
type LookupGovernanceResult =
	| { success: true; value: LookupSchemaGovernanceResult }
	| LookupGovernanceFailure;

/** Better Auth Project ids are opaque strings, not UUIDs. This validation only
 * rejects malformed Server Action input; authorization remains authoritative. */
const projectIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(255)
	.refine((value) => !value.includes("\0"), "Project id may not contain NUL.")
	.refine(
		(value) => !hasUnpairedUtf16Surrogate(value),
		"Project id contains invalid Unicode.",
	);

function invalidInput(error: ZodError): LookupFailure {
	const details = error.issues.slice(0, 100).map((issue) => ({
		code: "invalid_input",
		message: `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`,
	}));
	return {
		success: false,
		code: "invalid_input",
		message: "Some lookup-table input is invalid.",
		details,
		totalDetailCount: error.issues.length,
	};
}

function internalFailure(): LookupFailure<LookupActionErrorCode> {
	return {
		success: false,
		code: "internal_error",
		message: "The lookup table could not be updated. Try again.",
	};
}

/** Authenticate, parse the explicit Project id, authorize its exact capability,
 * and contain every expected rejection in the Server Action result wire. */
async function runLookupAction<Value, Input>(
	projectIdInput: unknown,
	input: unknown,
	inputSchema: ZodType<Input>,
	capability: AppCapability,
	operation: (scope: LookupScope, input: Input) => Promise<Value>,
): Promise<LookupResult<Value>> {
	try {
		const session = await getSession();
		if (!session) {
			return {
				success: false,
				code: "unauthenticated",
				message: "Authentication required.",
			};
		}

		// Only this narrow, pre-authorization stage classifies Zod failures as
		// client input. A ZodError thrown by auth, SQL, or the service is an
		// internal fault and must be logged like any other invariant failure.
		const projectResult = projectIdSchema.safeParse(projectIdInput);
		const inputResult = inputSchema.safeParse(input);
		if (!projectResult.success) return invalidInput(projectResult.error);
		if (!inputResult.success) return invalidInput(inputResult.error);
		const projectId = projectResult.data;
		const access = await resolveProjectAccess(
			session.user.id,
			projectId,
			capability,
		);
		const scope: LookupScope = {
			projectId: access.projectId,
			actorId: session.user.id,
			role: access.role,
		};
		return {
			success: true,
			value: await operation(scope, inputResult.data),
		};
	} catch (error) {
		if (error instanceof AppAccessError) {
			return {
				success: false,
				code: "not_found",
				message: "Lookup table not found.",
			};
		}
		if (error instanceof LookupError) return lookupFailure(error);
		log.error("[lookup/action] unhandled", error);
		return internalFailure();
	}
}

/**
 * Run one schema-governance operation: deleting a table, removing a column, or
 * retyping one.
 *
 * A sibling of `runLookupAction` rather than a wrapper around it, because
 * governance rejects for reasons the ordinary lookup result wire has no code
 * for — a set of referencing apps, a last column, values that do not already
 * satisfy the requested type — and each one carries the evidence the
 * confirmation surface needs to explain itself.
 *
 * On `referenced`, the blocking app ids are resolved to names here, in the
 * same request. The transaction is already rolled back at that point, so this
 * is a plain read: it exists so a refusal reads "Household register and
 * Referral follow-up still use this table" rather than handing an author two
 * opaque UUIDs. The pre-flight read and this one produce the same shape on
 * purpose — the author sees the same words before and after.
 */
async function runLookupGovernanceAction<Input>(
	projectIdInput: unknown,
	input: unknown,
	inputSchema: ZodType<Input>,
	toOperation: (input: Input) => LookupSchemaGovernanceOperation,
): Promise<LookupGovernanceResult> {
	/* Declared OUTSIDE the try so the catch names blocking apps against the
	 * AUTHORIZED Project id rather than re-parsing the raw argument. The two
	 * happen to be the same string today — `resolveProjectAccess` returns the id
	 * it was handed — but a naming query filtered on unvalidated input is
	 * authorization by coincidence, and the coincidence is not written down
	 * anywhere it would survive an edit. */
	let scope: LookupScope | undefined;
	try {
		const session = await getSession();
		if (!session) {
			return {
				success: false,
				code: "unauthenticated",
				message: "Authentication required.",
			};
		}
		const projectResult = projectIdSchema.safeParse(projectIdInput);
		const inputResult = inputSchema.safeParse(input);
		if (!projectResult.success) return invalidInput(projectResult.error);
		if (!inputResult.success) return invalidInput(inputResult.error);

		/* `delete` on the EXPLICIT Project id from the displayed state, never the
		 * caller's active Project. The governance seam re-checks the same
		 * capability before it takes a lock, so an insufficient role collapses to
		 * the same not-found shape on both gates. */
		const access = await resolveProjectAccess(
			session.user.id,
			projectResult.data,
			"delete",
		);
		scope = {
			projectId: access.projectId,
			actorId: session.user.id,
			role: access.role,
		};
		const operation = toOperation(inputResult.data);
		return {
			success: true,
			value: await applyLookupSchemaGovernance(scope, operation),
		};
	} catch (error) {
		if (error instanceof AppAccessError) {
			return {
				success: false,
				code: "not_found",
				message: "Lookup table not found.",
			};
		}
		if (error instanceof LookupSchemaGovernanceError) {
			return governanceFailure(error, scope);
		}
		if (error instanceof LookupError) return lookupFailure(error);
		log.error("[lookup/governance] unhandled", error);
		return {
			success: false,
			code: "internal_error",
			message: "The change could not be made. Try again.",
		};
	}
}

/**
 * Map a governance rejection onto the wire, naming the apps that blocked it.
 *
 * Takes the authorized `LookupScope` rather than a Project id, so there is no
 * shape in which an unauthorized identifier can reach the naming query. An
 * absent scope means the failure was raised before authorization completed —
 * unreachable for this error class today — and yields the unnamed refusal
 * rather than a query nobody proved the caller may run.
 */
async function governanceFailure(
	error: LookupSchemaGovernanceError,
	scope: LookupScope | undefined,
): Promise<LookupGovernanceFailure> {
	const base: LookupGovernanceFailure = {
		success: false,
		code:
			error.code === "schema_actions_disabled" ? "internal_error" : error.code,
		message: error.message,
		...(error.currentRevisions === undefined
			? {}
			: { currentRevisions: error.currentRevisions }),
		...(error.incompatibleRowIds === undefined
			? {}
			: { incompatibleRowIds: error.incompatibleRowIds }),
	};
	if (
		error.code !== "referenced" ||
		error.blockingAppIds === undefined ||
		scope === undefined
	) {
		return base;
	}
	const blocking = error.blockingAppIds;
	try {
		const named = await getAppDb()
			.then((db) =>
				db
					.selectFrom("apps")
					.where("apps.project_id", "=", scope.projectId)
					.where("apps.id", "in", [...blocking])
					.select(["apps.id", "apps.app_name", "apps.deleted_at"])
					.orderBy("apps.app_name", "asc")
					.orderBy("apps.id", "asc")
					.execute(),
			)
			.then((rows) =>
				rows.map((row) => ({
					appId: row.id,
					appName: row.app_name,
					deleted: row.deleted_at !== null,
				})),
			);
		return { ...base, blockingApps: named };
	} catch (nameError) {
		/* The refusal is the important half and it already stands. Failing to
		 * put names on it must not turn a clean rejection into a 500. */
		log.warn("[lookup/governance] could not name blocking apps", {
			err: nameError instanceof Error ? nameError.message : "unknown",
		});
		return base;
	}
}

/**
 * The apps a destructive change to this table — or to one of its columns —
 * would break, named.
 *
 * Deliberately gated at `view` rather than `delete`: "which apps use this
 * table" is ordinary information a member should be able to see before
 * deciding anything, and it names only apps in the caller's own authorized
 * Project. This read is ADVISORY. The authority is the transactional edge
 * check inside the governance transaction, which re-proves zero edges under
 * the table lock — a scan cannot authorize a destructive schema change,
 * because it races a concurrent app commit.
 */
export async function getLookupReferencingAppsAction(
	projectId: unknown,
	input: unknown,
): Promise<LookupResult<LookupReferencingApp[]>> {
	return runLookupAction(
		projectId,
		input,
		lookupResourceReferenceQuerySchema,
		"view",
		async (scope, query) =>
			readLookupReferencingApps(await getAppDb(), {
				projectId: scope.projectId,
				tableId: query.tableId,
				...(query.columnId === undefined ? {} : { columnId: query.columnId }),
			}),
	);
}

export async function getLookupManifestAction(
	projectId: unknown,
): Promise<LookupResult<LookupManifest>> {
	return runLookupAction(projectId, undefined, z.undefined(), "view", (scope) =>
		getLookupManifest(scope),
	);
}

/** Complete rows-free Project lookup catalog for builder authoring. */
export async function getAllLookupDefinitionsAction(
	projectId: unknown,
): Promise<LookupResult<LookupDefinitionsSnapshot>> {
	return runLookupAction(projectId, undefined, z.undefined(), "view", (scope) =>
		getAllLookupDefinitions(scope),
	);
}

export async function getLookupTableAction(
	projectId: unknown,
	tableId: unknown,
): Promise<LookupResult<LookupTableSnapshot>> {
	return runLookupAction(
		projectId,
		tableId,
		lookupTableIdSchema,
		"view",
		(scope, id) => getLookupTable(scope, id),
	);
}

/** Rows-free definition read for authoring pickers. Fetching columns must not
 * drag up to 5,000 row payloads into a field inspector. */
export async function getLookupDefinitionAction(
	projectId: unknown,
	tableId: unknown,
): Promise<LookupResult<LookupDefinitionsSnapshot>> {
	return runLookupAction(
		projectId,
		tableId,
		lookupTableIdSchema,
		"view",
		(scope, id) => getLookupDefinitions(scope, [id]),
	);
}

export async function createLookupTableAction(
	projectId: unknown,
	input: unknown,
): Promise<LookupResult<LookupTableSnapshot>> {
	return runLookupAction(
		projectId,
		input,
		createLookupTableInputSchema,
		"edit",
		createLookupTable,
	);
}

export async function updateLookupTableNameAction(
	projectId: unknown,
	input: unknown,
): Promise<LookupResult<LookupMutationReceipt>> {
	return runLookupAction(
		projectId,
		input,
		updateLookupTableNameInputSchema,
		"edit",
		updateLookupTableName,
	);
}

export async function updateLookupTableTagAction(
	projectId: unknown,
	input: unknown,
): Promise<LookupResult<LookupMutationReceipt>> {
	return runLookupAction(
		projectId,
		input,
		updateLookupTableTagInputSchema,
		"delete",
		updateLookupTableTag,
	);
}

export async function addLookupColumnAction(
	projectId: unknown,
	input: unknown,
): Promise<LookupResult<LookupCreatedColumnReceipt>> {
	return runLookupAction(
		projectId,
		input,
		addLookupColumnInputSchema,
		"edit",
		addLookupColumn,
	);
}

export async function updateLookupColumnLabelAction(
	projectId: unknown,
	input: unknown,
): Promise<LookupResult<LookupMutationReceipt>> {
	return runLookupAction(
		projectId,
		input,
		updateLookupColumnLabelInputSchema,
		"edit",
		updateLookupColumnLabel,
	);
}

export async function updateLookupColumnWireNameAction(
	projectId: unknown,
	input: unknown,
): Promise<LookupResult<LookupMutationReceipt>> {
	return runLookupAction(
		projectId,
		input,
		updateLookupColumnWireNameInputSchema,
		"delete",
		updateLookupColumnWireName,
	);
}

export async function moveLookupColumnAction(
	projectId: unknown,
	input: unknown,
): Promise<LookupResult<LookupMutationReceipt>> {
	return runLookupAction(
		projectId,
		input,
		moveLookupColumnInputSchema,
		"edit",
		moveLookupColumn,
	);
}

export async function createLookupRowAction(
	projectId: unknown,
	input: unknown,
): Promise<LookupResult<LookupCreatedRowReceipt>> {
	return runLookupAction(
		projectId,
		input,
		createLookupRowInputSchema,
		"edit",
		createLookupRow,
	);
}

export async function updateLookupRowAction(
	projectId: unknown,
	input: unknown,
): Promise<LookupResult<LookupMutationReceipt>> {
	return runLookupAction(
		projectId,
		input,
		updateLookupRowInputSchema,
		"edit",
		updateLookupRow,
	);
}

export async function deleteLookupRowAction(
	projectId: unknown,
	input: unknown,
): Promise<LookupResult<LookupMutationReceipt>> {
	return runLookupAction(
		projectId,
		input,
		deleteLookupRowInputSchema,
		"edit",
		deleteLookupRow,
	);
}

export async function moveLookupRowAction(
	projectId: unknown,
	input: unknown,
): Promise<LookupResult<LookupMutationReceipt>> {
	return runLookupAction(
		projectId,
		input,
		moveLookupRowInputSchema,
		"edit",
		moveLookupRow,
	);
}

/* ── Schema governance ──────────────────────────────────────────────────
 *
 * The three changes that destroy shared data or rewrite what a referencing
 * app reads. Each requires the Project's `delete` capability AND zero
 * applicable reference edges, proved transactionally under the table lock
 * rather than by the advisory scan the confirmation shows first.
 *
 * These are the callers the governance seam was written for; before them it
 * had none, which is why it stayed package-private with no user surface. */

export async function deleteLookupTableAction(
	projectId: unknown,
	input: unknown,
): Promise<LookupGovernanceResult> {
	return runLookupGovernanceAction(
		projectId,
		input,
		lookupExpectedTableRevisionInputSchema,
		(parsed) => ({ kind: "delete-table", ...parsed }),
	);
}

export async function removeLookupColumnAction(
	projectId: unknown,
	input: unknown,
): Promise<LookupGovernanceResult> {
	return runLookupGovernanceAction(
		projectId,
		input,
		removeLookupColumnInputSchema,
		(parsed) => ({ kind: "remove-column", ...parsed }),
	);
}

export async function retypeLookupColumnAction(
	projectId: unknown,
	input: unknown,
): Promise<LookupGovernanceResult> {
	return runLookupGovernanceAction(
		projectId,
		input,
		retypeLookupColumnInputSchema,
		(parsed) => ({ kind: "retype-column", ...parsed }),
	);
}
