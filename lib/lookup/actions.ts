"use server";

import { type ZodError, type ZodType, z } from "zod";
import type { AppCapability } from "@/lib/auth/projectRoles";
import { getSession } from "@/lib/auth-utils";
import { AppAccessError, resolveProjectAccess } from "@/lib/db/appAccess";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { log } from "@/lib/logger";
import { LookupError, lookupFailure } from "./errors";
import {
	addLookupColumnInputSchema,
	createLookupRowInputSchema,
	createLookupTableInputSchema,
	deleteLookupRowInputSchema,
	hasUnpairedUtf16Surrogate,
	moveLookupColumnInputSchema,
	moveLookupRowInputSchema,
	updateLookupColumnLabelInputSchema,
	updateLookupColumnWireNameInputSchema,
	updateLookupRowInputSchema,
	updateLookupTableNameInputSchema,
	updateLookupTableTagInputSchema,
} from "./schema";
import {
	addLookupColumn,
	createLookupRow,
	createLookupTable,
	deleteLookupRow,
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
	LookupFailure,
	LookupManifest,
	LookupMutationReceipt,
	LookupResult,
	LookupScope,
	LookupTableSnapshot,
} from "./types";

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

export async function getLookupManifestAction(
	projectId: unknown,
): Promise<LookupResult<LookupManifest>> {
	return runLookupAction(projectId, undefined, z.undefined(), "view", (scope) =>
		getLookupManifest(scope),
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
