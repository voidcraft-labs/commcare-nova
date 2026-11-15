/**
 * The one write of places at the birth of an app brought in from CommCare HQ.
 */

import type { Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import {
	type ManagedPlacePlan,
	writeManagedPlacesInTransaction,
} from "@/lib/organization/managed";

/**
 * The birth's one call for places, inside the transaction that inserted the
 * app row and before its organization integrity step, which proves the rows
 * this writes against the levels and location properties the same birth
 * saves. `places` null: the app reads none, and nothing is written. A plan
 * with no place is still written: the app reads places, and its copy of
 * CommCare HQ's organization holds none yet.
 */
export async function writeBroughtInPlacesInTransaction(
	tx: Transaction<AppDatabase>,
	scope: {
		readonly appId: string;
		readonly projectId: string;
		readonly actorUserId: string;
	},
	write: {
		readonly origin: { readonly server: string; readonly domain: string };
		readonly places: ManagedPlacePlan | null;
		readonly at: Date;
	},
): Promise<void> {
	if (write.places === null) return;
	await writeManagedPlacesInTransaction(tx, {
		appId: scope.appId,
		actorUserId: scope.actorUserId,
		origin: write.origin,
		plan: write.places,
		at: write.at,
	});
}
