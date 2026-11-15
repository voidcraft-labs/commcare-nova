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
import {
	LOOKUP_TABLE_NOT_FOUND,
	letHqManageLookupTable,
	type ManagedPlacesOutcome,
	type ManagedTableOutcome,
	manageLookupTableInNova,
	readManagedLookupTableView,
	readManagedPlacesView,
	refreshManagedLookupTable,
	refreshManagedPlaces,
} from "./managedData";

/**
 * The browser boundary for data CommCare HQ manages: a lookup table's
 * refresh, Manage in Nova and the hand-back, the table page's view, and the
 * places' refresh and view.
 *
 * Every action takes plain JSON (a Project id and a table id, or an app id),
 * authenticates, and resolves the Project freshly from the id it was given,
 * never the person's active Project, so a stale tab acts on the Project it
 * shows. The scope is built here from what that resolution read; the
 * services decide the capability each action needs. A caller with no
 * session, or no role in that Project, finds nothing there, as for a table
 * or an app that is not there.
 */

const projectIdSchema = z.string().trim().min(1).max(255);
const appIdSchema = z.string().trim().min(1).max(255);

/** The sentence `lib/organization`'s actions give an app the caller cannot reach. */
const APP_NOT_AVAILABLE =
	"That app isn't available. It may have been deleted, or you may not have access to it.";

/** The scope a lookup action runs under, or null where the caller has none in that Project. */
async function lookupScopeFor(
	projectIdInput: unknown,
	tableIdInput: unknown,
): Promise<{
	readonly scope: LookupScope;
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
	) => Promise<ManagedTableOutcome>,
): Promise<ManagedTableOutcome> {
	const resolved = await lookupScopeFor(projectId, tableId);
	if (resolved === null) return TABLE_NOT_FOUND;
	try {
		return await run(resolved.scope, resolved.tableId);
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
	return tableAction("refresh", projectId, tableId, refreshManagedLookupTable);
}

export async function manageLookupTableInNovaAction(
	projectId: string,
	tableId: string,
): Promise<ManagedTableOutcome> {
	return tableAction(
		"manage in Nova",
		projectId,
		tableId,
		manageLookupTableInNova,
	);
}

export async function letHqManageLookupTableAction(
	projectId: string,
	tableId: string,
): Promise<ManagedTableOutcome> {
	return tableAction("hand back", projectId, tableId, letHqManageLookupTable);
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
