/**
 * Server Action for the builder's platform section: before a change of
 * where the app runs that adds a platform, list every use and every file the
 * new declaration can't run, from one committed snapshot.
 *
 * Explanatory only: it returns the `mutationSeq` it read, never a write
 * token. The builder compares that sequence with its own before committing,
 * the commit runs the client gate again, and the commit kernel's media
 * admission stays the authority. A Server Action on the builder page, not an
 * `/api` route, so it needs no host allowlist entry; its arguments are plain
 * JSON.
 */

"use server";

import { getSession } from "@/lib/auth-utils";
import { log } from "@/lib/logger";
import { readPlatformChangePreflight } from "./platformChangePreflightRead";
import type {
	PlatformChangePreflightInput,
	PlatformChangePreflightResult,
} from "./platformChangePreflightTypes";

export async function platformChangePreflightAction(
	input: PlatformChangePreflightInput,
): Promise<PlatformChangePreflightResult> {
	const session = await getSession();
	if (!session) return { kind: "unauthenticated" };
	try {
		return await readPlatformChangePreflight(input, session.user.id);
	} catch (error) {
		log.error("[platform-change/preflight] unhandled", error, {
			appId: input?.appId,
		});
		throw error;
	}
}
