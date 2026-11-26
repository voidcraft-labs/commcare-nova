"use server";

import { z } from "zod";
import { getSession } from "@/lib/auth-utils";
import {
	AppAccessError,
	resolveAppScope,
	resolveProjectAccess,
} from "@/lib/db/appAccess";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { log } from "@/lib/logger";
import type { LookupScope } from "@/lib/lookup/types";
import { OrganizationError } from "@/lib/organization/errors";
import type { OrganizationScope } from "@/lib/organization/types";
import { MANAGEMENT_REVIEW_MOVED } from "@/lib/publish/managedData";
import {
	LOOKUP_TABLE_NOT_FOUND,
	letHqManageLookupTable,
	type ManagedPlacesOutcome,
	type ManagedTableOutcome,
	manageLookupTableInNova,
	readHqTableSourcesView,
	readManagedLookupTableView,
	readManagedPlacesView,
	refreshManagedLookupTable,
	refreshManagedPlaces,
	reviewUseHqTable,
	takeHqTableForLookupTable,
} from "./managedData";
import { sourceWorkbookBytes } from "./managedLookupObservation";
import {
	reviewSeparateTable,
	type SeparateTableOutcome,
	separateLookupTable,
} from "./separateTable";

/**
 * The browser boundary for data CommCare HQ manages: a lookup table's
 * refresh, Manage in Nova and the hand-back, the table page's view, and the
 * places' refresh and view.
 *
 * Every action takes plain JSON (a Project id and a table id, or an app id,
 * and for a change of who manages a table the review digest the table's view
 * answered), authenticates, and resolves the Project freshly from the id it
 * was given,
 * never the person's active Project, so a stale tab acts on the Project it
 * shows. The scope is built here from what that resolution read; the
 * services decide the capability each action needs, and read the member's
 * role again on the transaction that writes. A caller with no
 * session, or no role in that Project, finds nothing there, as for a table
 * or an app that is not there.
 */

const projectIdSchema = z.string().trim().min(1).max(255);
const appIdSchema = z.string().trim().min(1).max(255);
const reviewDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** The sentence `lib/organization`'s actions give an app the caller cannot reach. */
const APP_NOT_AVAILABLE =
	"That app isn't available. It may have been deleted, or you may not have access to it.";

/** The scope a lookup action runs under, or null where the caller has none in that Project. */
async function lookupScopeFor(
	projectIdInput: unknown,
	tableIdInput: unknown,
): Promise<{
	readonly scope: LookupScope;
	readonly sessionId: string;
	readonly tableId: ReturnType<typeof lookupTableIdSchema.parse>;
} | null> {
	const projectId = projectIdSchema.safeParse(projectIdInput);
	const tableId = lookupTableIdSchema.safeParse(tableIdInput);
	if (!projectId.success || !tableId.success) return null;
	const session = await getSession();
	if (session === null) return null;
	try {
		const access = await resolveProjectAccess(
			session.user.id,
			projectId.data,
			"view",
		);
		return {
			sessionId: session.session.id,
			scope: {
				projectId: access.projectId,
				actorId: session.user.id,
				role: access.role,
			},
			tableId: tableId.data,
		};
	} catch (error) {
		if (error instanceof AppAccessError) return null;
		throw error;
	}
}

/** The scope a places action runs under, or null where the caller cannot see the app. */
async function organizationScopeFor(
	appIdInput: unknown,
): Promise<OrganizationScope | null> {
	const appId = appIdSchema.safeParse(appIdInput);
	if (!appId.success) return null;
	const session = await getSession();
	if (session === null) return null;
	try {
		const access = await resolveAppScope(appId.data, session.user.id, "view");
		return {
			appId: appId.data,
			projectId: access.projectId,
			role: access.role,
			actorUserId: session.user.id,
		};
	} catch (error) {
		if (error instanceof AppAccessError) return null;
		throw error;
	}
}

const TABLE_NOT_FOUND: ManagedTableOutcome = {
	ok: false,
	reason: "not-found",
	message: LOOKUP_TABLE_NOT_FOUND,
};

/** Run one table action, logging a fault the person can do nothing about before it propagates. */
async function tableAction(
	name: string,
	projectId: unknown,
	tableId: unknown,
	run: (
		scope: LookupScope,
		tableId: ReturnType<typeof lookupTableIdSchema.parse>,
		sessionId: string,
	) => Promise<ManagedTableOutcome>,
): Promise<ManagedTableOutcome> {
	const resolved = await lookupScopeFor(projectId, tableId);
	if (resolved === null) return TABLE_NOT_FOUND;
	try {
		return await run(resolved.scope, resolved.tableId, resolved.sessionId);
	} catch (error) {
		log.error(`[deployment/managed-data] ${name} failed`, error, {
			projectId: resolved.scope.projectId,
			tableId: resolved.tableId,
		});
		throw error;
	}
}

export async function refreshManagedLookupTableAction(
	projectId: string,
	tableId: string,
): Promise<ManagedTableOutcome> {
	return tableAction("refresh", projectId, tableId, (scope, id, sessionId) =>
		refreshManagedLookupTable(scope, id, { kind: "session", sessionId }),
	);
}

/** The review digest a confirmation carries back, or null where it is no digest. */
function parsedReviewDigest(input: unknown): string | null {
	const parsed = reviewDigestSchema.safeParse(input);
	return parsed.success ? parsed.data : null;
}

/** The answer to a confirmation that carried no digest the view gave. */
const REVIEW_NOT_READ: ManagedTableOutcome = {
	ok: false,
	reason: "review-moved",
	message: MANAGEMENT_REVIEW_MOVED,
};

export async function manageLookupTableInNovaAction(
	projectId: string,
	tableId: string,
	reviewDigest: string,
	form?: FormData,
): Promise<ManagedTableOutcome> {
	const digest = parsedReviewDigest(reviewDigest);
	if (digest === null) return REVIEW_NOT_READ;
	return tableAction(
		"manage in Nova",
		projectId,
		tableId,
		async (scope, id, sessionId) => {
			let workbook: Buffer | undefined;
			if (form) {
				const file = form.get("workbook");
				if (
					!(file instanceof File) ||
					!file.size ||
					file.size > sourceWorkbookBytes
				)
					return {
						ok: false,
						reason: "unsupported",
						message: "You can choose a selected-table workbook up to 768 KiB.",
					} as const;
				workbook = Buffer.from(await file.arrayBuffer());
			}
			return manageLookupTableInNova(
				scope,
				id,
				digest,
				{
					kind: "session",
					sessionId,
				},
				workbook,
			);
		},
	);
}

export async function letHqManageLookupTableAction(
	projectId: string,
	tableId: string,
	reviewDigest: string,
): Promise<ManagedTableOutcome> {
	const digest = parsedReviewDigest(reviewDigest);
	if (digest === null) return REVIEW_NOT_READ;
	return tableAction("hand back", projectId, tableId, (scope, id) =>
		letHqManageLookupTable(scope, id, digest),
	);
}

export async function readManagedLookupTableViewAction(
	projectId: string,
	tableId: string,
): Promise<Awaited<ReturnType<typeof readManagedLookupTableView>>> {
	const resolved = await lookupScopeFor(projectId, tableId);
	if (resolved === null) return null;
	return readManagedLookupTableView(resolved.scope, resolved.tableId);
}

export async function refreshManagedPlacesAction(
	appId: string,
): Promise<ManagedPlacesOutcome> {
	const scope = await organizationScopeFor(appId);
	if (scope === null) {
		return { ok: false, reason: "not-found", message: APP_NOT_AVAILABLE };
	}
	try {
		return await refreshManagedPlaces(scope);
	} catch (error) {
		if (error instanceof OrganizationError && error.code === "not_found") {
			return { ok: false, reason: "not-found", message: error.message };
		}
		log.error("[deployment/managed-data] places refresh failed", error, {
			appId: scope.appId,
		});
		throw error;
	}
}

export async function readManagedPlacesViewAction(
	appId: string,
): Promise<Awaited<ReturnType<typeof readManagedPlacesView>>> {
	const scope = await organizationScopeFor(appId);
	if (scope === null) return null;
	try {
		return await readManagedPlacesView(scope);
	} catch (error) {
		if (error instanceof OrganizationError && error.code === "not_found") {
			return null;
		}
		throw error;
	}
}

const domainSchema = z.string().trim().min(1).max(255);
const serverSchema = z.string().trim().min(1).max(64);

/** The project space a person chose, or null where the input names none. */
function parsedChoice(
	server: unknown,
	domain: unknown,
): { readonly server: string; readonly domain: string } | null {
	const parsedServer = serverSchema.safeParse(server);
	const parsedDomain = domainSchema.safeParse(domain);
	return parsedServer.success && parsedDomain.success
		? { server: parsedServer.data, domain: parsedDomain.data }
		: null;
}

/** The project spaces a publish put a Nova table in, for its page's Use the table from CommCare HQ. */
export async function readHqTableSourcesViewAction(
	projectId: string,
	tableId: string,
): Promise<Awaited<ReturnType<typeof readHqTableSourcesView>>> {
	const resolved = await lookupScopeFor(projectId, tableId);
	if (resolved === null) return null;
	return readHqTableSourcesView(resolved.scope, resolved.tableId);
}

/** What Use the table from CommCare HQ would do with the table in one project space. */
export async function reviewUseHqTableAction(
	projectId: string,
	tableId: string,
	server: string,
	domain: string,
): Promise<Awaited<ReturnType<typeof reviewUseHqTable>>> {
	const resolved = await lookupScopeFor(projectId, tableId);
	const choice = parsedChoice(server, domain);
	if (resolved === null || choice === null)
		return { ok: false, reason: "not-found", message: LOOKUP_TABLE_NOT_FOUND };
	return reviewUseHqTable(resolved.scope, resolved.tableId, choice);
}

export async function takeHqTableAction(
	projectId: string,
	tableId: string,
	server: string,
	domain: string,
	reviewDigest: string,
): Promise<ManagedTableOutcome> {
	const digest = parsedReviewDigest(reviewDigest);
	const choice = parsedChoice(server, domain);
	if (digest === null || choice === null) return REVIEW_NOT_READ;
	return tableAction(
		"use the table from CommCare HQ",
		projectId,
		tableId,
		(scope, id) => takeHqTableForLookupTable(scope, id, choice, digest),
	);
}

const SEPARATE_NOT_FOUND = {
	ok: false,
	reason: "not-found",
	message: LOOKUP_TABLE_NOT_FOUND,
} as const satisfies SeparateTableOutcome;

/** What Create a separate table would do with the table. */
export async function reviewSeparateTableAction(
	projectId: string,
	tableId: string,
): Promise<Awaited<ReturnType<typeof reviewSeparateTable>>> {
	const resolved = await lookupScopeFor(projectId, tableId);
	if (resolved === null) return SEPARATE_NOT_FOUND;
	return reviewSeparateTable(resolved.scope, resolved.tableId);
}

const separateInputSchema = z.strictObject({
	name: z.string().max(500),
	tag: z.string().max(500),
	appIds: z.array(appIdSchema).max(500),
	reviewDigest: reviewDigestSchema,
});

export async function separateTableAction(
	projectId: string,
	tableId: string,
	input: {
		readonly name: string;
		readonly tag: string;
		readonly appIds: readonly string[];
		readonly reviewDigest: string;
	},
): Promise<SeparateTableOutcome> {
	const parsed = separateInputSchema.safeParse(input);
	if (!parsed.success)
		return {
			ok: false,
			reason: "review-moved",
			message: MANAGEMENT_REVIEW_MOVED,
		};
	const resolved = await lookupScopeFor(projectId, tableId);
	if (resolved === null) return SEPARATE_NOT_FOUND;
	try {
		return await separateLookupTable(
			resolved.scope,
			resolved.tableId,
			parsed.data,
		);
	} catch (error) {
		log.error("[deployment/managed-data] separate table failed", error, {
			projectId: resolved.scope.projectId,
			tableId: resolved.tableId,
		});
		throw error;
	}
}
