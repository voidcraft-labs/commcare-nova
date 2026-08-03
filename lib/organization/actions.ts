"use server";

import { type ZodError, type ZodType, z } from "zod";
import { getSession } from "@/lib/auth-utils";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import { uuidSchema } from "@/lib/domain";
import { log } from "@/lib/logger";
import type { OrganizationErrorCode } from "./errors";
import { OrganizationError } from "./errors";
import {
	archiveImpactSchema,
	createLocationInputSchema,
	organizationRevisionSchema,
	updateLocationInputSchema,
} from "./schema";
import {
	createLocation,
	describeArchiveImpact,
	moveLocation,
	readOrganization,
	setLocationArchived,
	updateLocation,
} from "./service";
import type {
	ArchiveImpact,
	OrganizationRevision,
	OrganizationScope,
	OrganizationSnapshot,
	StoredLocation,
} from "./types";

/**
 * The browser boundary for the locations store.
 *
 * Every action does the same four things in the same order: authenticate,
 * runtime-parse the untrusted argument, authorize the EXPLICIT app id the
 * displayed state named, then call the server-only service. The scope is
 * always constructed here from a freshly resolved app row — never from a
 * client-asserted Project, and never from the user's mutable active Project,
 * which would let a stale tab write into whichever Project the user happened
 * to switch to.
 *
 * Typed rejections become discriminated results so the UI can render a
 * sentence; anything else is an infrastructure fault and is logged and
 * reported as one, because telling an author to fix an outage wastes their
 * time.
 */

export type OrganizationResult<T> =
	| { readonly success: true; readonly data: T }
	| {
			readonly success: false;
			readonly code: OrganizationErrorCode | "invalid_input" | "unavailable";
			readonly message: string;
			readonly currentRevision?: OrganizationRevision;
	  };

const appIdSchema = z.string().trim().min(1).max(255);

function invalidInput(error: ZodError): OrganizationResult<never> {
	const first = error.issues[0];
	return {
		success: false,
		code: "invalid_input",
		message:
			first === undefined
				? "That request wasn't in a shape Nova understands."
				: `${first.path.length > 0 ? `${first.path.join(".")}: ` : ""}${first.message}`,
	};
}

/**
 * Resolve and authorize the named app, then run `body` with a scope built from
 * the row that authorization actually read.
 *
 * `view` is the floor even for writes: the writer re-authorizes at `edit`
 * inside its own transaction, under the app lock, which is the decision that
 * counts. Checking `edit` here too would only produce a nicer error a moment
 * earlier — and would be a second authorization that could disagree with the
 * authoritative one.
 */
async function withScope<T>(
	appId: unknown,
	body: (scope: OrganizationScope) => Promise<T>,
): Promise<OrganizationResult<T>> {
	const parsedAppId = appIdSchema.safeParse(appId);
	if (!parsedAppId.success) return invalidInput(parsedAppId.error);
	const session = await getSession();
	if (session === null) {
		return {
			success: false,
			code: "forbidden",
			message: "Sign in to work on this app's organization.",
		};
	}
	try {
		const access = await resolveAppScope(
			parsedAppId.data,
			session.user.id,
			"view",
		);
		return {
			success: true,
			data: await body({
				appId: parsedAppId.data,
				projectId: access.projectId,
				role: access.role,
				actorUserId: session.user.id,
			}),
		};
	} catch (error) {
		if (error instanceof OrganizationError) {
			return {
				success: false,
				code: error.code,
				message: error.message,
				...(error.currentRevision === undefined
					? {}
					: { currentRevision: error.currentRevision }),
			};
		}
		if (error instanceof BlueprintCommitRejectedError) {
			return {
				success: false,
				code: "rejected",
				message: error.message,
			};
		}
		if (error instanceof AppAccessError) {
			return {
				success: false,
				code: "not_found",
				message:
					"That app isn't available. It may have been deleted, or you may not have access to it.",
			};
		}
		log.error("[organization] action failed", error, {
			appId: parsedAppId.data,
			userId: session.user.id,
		});
		return {
			success: false,
			code: "unavailable",
			message:
				"Nova couldn't reach the organization just now. Try again in a moment.",
		};
	}
}

function parsed<T>(schema: ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		// Inside `withScope`, so this surfaces as an `invalid` result rather
		// than an outage — the argument was the caller's, not the server's.
		throw new OrganizationError(
			"invalid",
			result.error.issues[0]?.message ??
				"That request wasn't in a shape Nova understands.",
		);
	}
	return result.data;
}

export async function readOrganizationAction(
	appId: string,
): Promise<OrganizationResult<OrganizationSnapshot>> {
	return withScope(appId, (scope) => readOrganization(scope));
}

export async function createLocationAction(
	appId: string,
	input: unknown,
	expectedRevision: string,
): Promise<OrganizationResult<{ location: StoredLocation; revision: string }>> {
	return withScope(appId, async (scope) =>
		createLocation(
			scope,
			parsed(createLocationInputSchema, input),
			parsed(organizationRevisionSchema, expectedRevision),
		),
	);
}

export async function updateLocationAction(
	appId: string,
	locationId: string,
	patch: unknown,
	expectedRevision: string,
): Promise<OrganizationResult<{ location: StoredLocation; revision: string }>> {
	return withScope(appId, async (scope) =>
		updateLocation(
			scope,
			parsed(uuidSchema, locationId),
			parsed(updateLocationInputSchema, patch),
			parsed(organizationRevisionSchema, expectedRevision),
		),
	);
}

export async function moveLocationAction(
	appId: string,
	locationId: string,
	target: unknown,
	expectedRevision: string,
): Promise<OrganizationResult<{ location: StoredLocation; revision: string }>> {
	const targetSchema = z
		.object({
			parentId: uuidSchema.nullable(),
			afterSiblingId: uuidSchema.nullable().optional(),
		})
		.strict();
	return withScope(appId, async (scope) =>
		moveLocation(
			scope,
			parsed(uuidSchema, locationId),
			parsed(targetSchema, target),
			parsed(organizationRevisionSchema, expectedRevision),
		),
	);
}

export async function describeArchiveImpactAction(
	appId: string,
	locationId: string,
): Promise<OrganizationResult<ArchiveImpact>> {
	return withScope(appId, async (scope) =>
		describeArchiveImpact(scope, parsed(uuidSchema, locationId)),
	);
}

export async function setLocationArchivedAction(
	appId: string,
	locationId: string,
	archived: boolean,
	expectedRevision: string,
	confirmedImpact?: unknown,
): Promise<
	OrganizationResult<{
		revision: string;
		archivedCount: number;
		unassignedPersonaCount: number;
	}>
> {
	return withScope(appId, async (scope) => {
		const parsedArchived = parsed(z.boolean(), archived);
		if (parsedArchived && confirmedImpact === undefined) {
			throw new OrganizationError(
				"invalid",
				"Review the current archive impact before confirming this change.",
			);
		}
		const result = await setLocationArchived(
			scope,
			parsed(uuidSchema, locationId),
			parsedArchived,
			parsed(organizationRevisionSchema, expectedRevision),
			confirmedImpact === undefined
				? undefined
				: parsed(archiveImpactSchema, confirmedImpact),
		);
		return {
			revision: result.revision,
			archivedCount: result.archivedCount,
			unassignedPersonaCount: result.unassignedPersonaCount,
		};
	});
}
