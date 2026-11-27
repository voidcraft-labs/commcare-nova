import "server-only";
import type { Transaction } from "kysely";
import { dataAccessLost, type ProjectDataGrant } from "@/lib/auth/dataGrant";
import type { ExpectedLookupData } from "@/lib/commcare/lookup/workbookReceipt";
import type { AppDatabase } from "@/lib/db/pg";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import {
	type AssignmentWitness,
	authorizeAssignmentExport,
} from "@/lib/export/privateAssignments";
import type { PublishedLookupTableLock } from "@/lib/lookup/managed";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import { destinationOwnerDigestInTransaction } from "./destinationRowOwners";
import type { DeploymentScope, DeploymentTargetKey } from "./store";

type WorkbookTableIntent = {
	tag: string;
	definitionRevision: string;
	rowsRevision: string;
	isGlobal: boolean;
	assignment?: AssignmentWitness["tables"][number];
};

export interface WorkbookAuthority {
	grant: ProjectDataGrant;
	connectionDigest: string;
	grantBinding: string;
	tables: ReadonlyMap<string, WorkbookTableIntent>;
}

export function plannedWorkbookTables(
	snapshot: LookupFixtureDataSnapshot,
	receipts: ReadonlyMap<string, ExpectedLookupData>,
	assignment?: AssignmentWitness,
): WorkbookAuthority["tables"] {
	const tables = new Map<string, WorkbookTableIntent>();
	for (const table of snapshot.definitions) {
		const receipt = receipts.get(table.id);
		if (!receipt) continue;
		const owners = assignment?.tables.find((item) => item.tableId === table.id);
		if (table.rowsRevision === undefined || (!receipt.isGlobal && !owners))
			return dataAccessLost();
		tables.set(table.id, {
			tag: table.tag,
			definitionRevision: table.definitionRevision,
			rowsRevision: table.rowsRevision,
			isGlobal: receipt.isGlobal,
			assignment: owners,
		});
	}
	if (tables.size !== receipts.size) return dataAccessLost();
	return tables;
}

/** The carrier and remote principal checks precede this transaction. Rebind
 * their exact local inputs under the same locks that record the outbound write. */
export async function workbookAuthorityMatches(
	tx: Transaction<AppDatabase>,
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	authority: WorkbookAuthority,
	tableIds: readonly LookupTableId[],
	locked: readonly PublishedLookupTableLock[],
) {
	const current = await authorizeAssignmentExport(
		tx,
		scope,
		authority.grant,
		target,
		"publish",
		authority.connectionDigest,
	);
	if (current !== authority.grantBinding) return dataAccessLost();
	if (!tableIds.length || locked.length !== tableIds.length) return false;
	for (const table of locked) {
		const planned = authority.tables.get(table.id);
		if (
			!planned ||
			planned.tag !== table.tag ||
			planned.isGlobal !== table.isGlobal ||
			planned.definitionRevision !== table.definitionRevision ||
			planned.rowsRevision !== table.rowsRevision
		)
			return false;
		if (!planned.isGlobal) {
			if (!planned.assignment) return false;
			const local = await destinationOwnerDigestInTransaction(
				tx,
				{ scope, target, grant: authority.grant, purpose: "publish" },
				planned.assignment.tableId,
			);
			if (local !== planned.assignment.localDigest) return false;
		}
	}
	return true;
}
