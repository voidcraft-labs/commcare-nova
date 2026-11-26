import "server-only";

import {
	type Selectable,
	sql,
	type Transaction,
	type Updateable,
} from "kysely";
import { type AppCapability, roleAllowsApp } from "@/lib/auth/projectRoles";
import {
	type AppDatabase,
	type LookupTablesTable,
	notifyLookupProject,
} from "@/lib/db/pg";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { managedLookupTableRefusal } from "@/lib/publish/managedData";
import { LookupError } from "./errors";
import { maxLookupRevision, parseLookupRevision } from "./schema";
import type { LookupRevision, LookupTableRevisions } from "./types";
import { assertWorkbookEditAvailable } from "./workbookHold";

export type StoredLookupTable = Selectable<LookupTablesTable>;

export interface LockedLookupProjectState {
	revision: LookupRevision;
}

declare const lookupWriteAuthorityBrand: unique symbol;

/**
 * A member's authority to write a Project's lookup data, read in the one
 * transaction that writes. Only `authorizeLookupWriteInTransaction` makes one,
 * and it is good only on the transaction it was read on: every lock of a
 * lookup writer takes one, so no writer reaches Project state or a table on a
 * role read before its transaction, or in another one.
 */
export interface LookupWriteAuthority {
	readonly projectId: string;
	readonly actorId: string;
	/** The member's role as the transaction read it under the membership gate. */
	readonly role: string;
	readonly [lookupWriteAuthorityBrand]: true;
}

/** Every authority made, with the transaction it was read on. */
const authorityTransactions = new WeakMap<
	LookupWriteAuthority,
	Transaction<AppDatabase>
>();

const destructiveAuthorities = new WeakSet<LookupWriteAuthority>();

/** Receipts retain the strongest capability the successful write used,
 * including authority discovered from the previous definition under lock. */
export function lookupReceiptCapability(
	authority: LookupWriteAuthority,
): "edit" | "delete" {
	return destructiveAuthorities.has(authority) ? "delete" : "edit";
}

/**
 * A write refused because the member's standing, read in the write's own
 * transaction, does not allow it: no longer a member of the Project
 * (`not-a-member`), or a member whose role falls below what the write needs
 * (`below-capability`). Its code is `not_found`, the shape every ordinary
 * lookup boundary gives a resource the caller may not touch; a surface that
 * names who can make the change reads `standing` and `capability`.
 */
export class LookupAuthorityError extends LookupError {
	readonly standing: "not-a-member" | "below-capability";
	readonly capability: Exclude<AppCapability, "view">;
	constructor(
		standing: "not-a-member" | "below-capability",
		capability: Exclude<AppCapability, "view">,
	) {
		super("not_found", "Lookup resource was not found.");
		this.name = "LookupAuthorityError";
		this.standing = standing;
		this.capability = capability;
	}
}

/**
 * Read the member's role in the Project on the write's own transaction, under
 * the shared membership gate with the member row `FOR SHARE`
 * (`projectRoleForInTransaction`), and answer the authority every lookup lock
 * takes, or throw `LookupAuthorityError`. The lock order is the membership
 * gate, then Project state, then tables: an app-bound writer has already
 * taken its app row, and nothing takes the gate after Project state. Reading
 * it twice on one transaction is harmless: the gate is already held and the
 * row already locked.
 */
export async function authorizeLookupWriteInTransaction(
	tx: Transaction<AppDatabase>,
	writer: { readonly projectId: string; readonly actorId: string },
	capability: Exclude<AppCapability, "view">,
): Promise<LookupWriteAuthority> {
	if (
		typeof writer.projectId !== "string" ||
		writer.projectId.length === 0 ||
		typeof writer.actorId !== "string" ||
		writer.actorId.length === 0
	) {
		throw new Error(
			"A lookup write was authorized with no Project or no member to read.",
		);
	}
	const role = await projectRoleForInTransaction(
		tx,
		writer.actorId,
		writer.projectId,
	);
	if (role === null) throw new LookupAuthorityError("not-a-member", capability);
	if (!roleAllowsApp(role, capability)) {
		throw new LookupAuthorityError("below-capability", capability);
	}
	const authority = {
		projectId: writer.projectId,
		actorId: writer.actorId,
		role,
	} as LookupWriteAuthority;
	authorityTransactions.set(authority, tx);
	if (capability === "delete") destructiveAuthorities.add(authority);
	return authority;
}

/**
 * The authority, where it was read on `tx` and allows `capability`; otherwise
 * a fault of the caller (an authority from another transaction) or the
 * write's refusal (a role below what this write needs).
 */
export function requireLookupCapability(
	tx: Transaction<AppDatabase>,
	authority: LookupWriteAuthority,
	capability: Exclude<AppCapability, "view">,
): LookupWriteAuthority {
	if (authorityTransactions.get(authority) !== tx) {
		throw new Error(
			"A lookup write used an authority read on another transaction. Authorize the write on the transaction that makes it (authorizeLookupWriteInTransaction).",
		);
	}
	if (!roleAllowsApp(authority.role, capability)) {
		throw new LookupAuthorityError("below-capability", capability);
	}
	if (capability === "delete") destructiveAuthorities.add(authority);
	return authority;
}

/** The capability each purpose of a table lock needs, at the least. */
const PURPOSE_CAPABILITY: Readonly<
	Record<LookupWritePurpose, Exclude<AppCapability, "view">>
> = {
	author: "edit",
	"remove-table": "delete",
	"hq-refresh": "edit",
	"hq-management": "delete",
};

export function lookupTableRevisions(
	table: StoredLookupTable,
): LookupTableRevisions {
	const definitionRevision = parseLookupRevision(table.definition_revision);
	const rowsRevision = parseLookupRevision(table.rows_revision);
	return {
		definitionRevision,
		rowsRevision,
		tableRevision: maxLookupRevision(definitionRevision, rowsRevision),
	};
}

/**
 * Create-if-missing and lock the Project's lookup state, the first lock of
 * every lookup writer, for the Project the authority was read for.
 */
export async function lockLookupProjectState(
	tx: Transaction<AppDatabase>,
	authority: LookupWriteAuthority,
): Promise<LockedLookupProjectState> {
	requireLookupCapability(tx, authority, "edit");
	const { projectId } = authority;
	await tx
		.insertInto("lookup_project_state")
		.values({ project_id: projectId })
		.onConflict((conflict) => conflict.column("project_id").doNothing())
		.execute();
	const state = await tx
		.selectFrom("lookup_project_state")
		.select("revision")
		.where("project_id", "=", projectId)
		.forUpdate()
		.executeTakeFirst();
	if (!state) {
		throw new Error(
			"Lookup Project state disappeared after its locked upsert.",
		);
	}
	return { revision: parseLookupRevision(state.revision) };
}

/** Why a writer locks a table, which decides what a table CommCare HQ manages allows. */
export type LookupWritePurpose =
	/** A person, the SA or an MCP client changing a table. Refused while CommCare HQ manages it. */
	| "author"
	/** Removing Nova's copy of a table. Allowed in every state: it changes nothing in CommCare HQ. */
	| "remove-table"
	/** Bringing CommCare HQ's content into the copy (`managed.ts`). */
	| "hq-refresh"
	/** Changing who manages the table (`managed.ts`). */
	| "hq-management";

/**
 * Lock one table `FOR UPDATE` for a write, in this order: the capability the
 * purpose needs (`edit` for an author's write and a refresh, `delete` for
 * removing a table and for changing who manages one), held by an authority
 * read on this transaction; the row, or `not_found`; for an `author` write,
 * the refusal of a table CommCare HQ manages (`hq_server` set, no takeover);
 * then the revision compare. The managed check comes first, so a stale tab
 * learns the table is managed rather than being sent to reload. Only
 * `hq-refresh` and `hq-management` skip this compare, with a null
 * `expectedRevision`: `managed.ts` compares what a person reviewed itself,
 * under this lock.
 */
export async function lockLookupTableForUpdate(
	tx: Transaction<AppDatabase>,
	authority: LookupWriteAuthority,
	tableId: LookupTableId,
	expectedRevision: LookupRevision | null,
	purpose: LookupWritePurpose,
): Promise<StoredLookupTable> {
	requireLookupCapability(tx, authority, PURPOSE_CAPABILITY[purpose]);
	const { projectId } = authority;
	if (
		expectedRevision === null &&
		(purpose === "author" || purpose === "remove-table")
	) {
		throw new Error(
			`A lookup table write for "${purpose}" must name the revision it was loaded at.`,
		);
	}
	const table = await tx
		.selectFrom("lookup_tables")
		.selectAll()
		.where("project_id", "=", projectId)
		.where("id", "=", tableId)
		.forUpdate()
		.executeTakeFirst();
	if (!table) {
		throw new LookupError("not_found", "Lookup resource was not found.");
	}
	if (
		purpose === "author" &&
		table.hq_server !== null &&
		table.hq_taken_over_at === null
	) {
		if (table.hq_domain === null) {
			throw new Error(
				"A lookup table's CommCare HQ origin was stored only in part.",
			);
		}
		throw new LookupError(
			"managed_in_hq",
			managedLookupTableRefusal(table.name, table.hq_domain),
		);
	}
	if (purpose === "author" || purpose === "remove-table")
		await assertWorkbookEditAvailable(tx, tableId);
	if (expectedRevision === null) return table;
	const currentRevisions = lookupTableRevisions(table);
	if (currentRevisions.tableRevision !== expectedRevision) {
		throw new LookupError(
			"conflict",
			"This lookup table changed since it was loaded. Refresh and try again.",
			{ currentRevisions },
		);
	}
	return table;
}

export async function advanceLookupProjectRevision(
	tx: Transaction<AppDatabase>,
	projectId: string,
): Promise<LookupRevision> {
	const row = await tx
		.updateTable("lookup_project_state")
		.set({
			revision: sql<string>`revision + 1`,
			updated_at: new Date(),
		})
		.where("project_id", "=", projectId)
		.returning("revision")
		.executeTakeFirst();
	if (!row) {
		throw new Error(
			"Lookup Project state disappeared while advancing revision.",
		);
	}
	return parseLookupRevision(row.revision);
}

export async function updateLockedLookupTable(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	values: Updateable<LookupTablesTable>,
): Promise<StoredLookupTable> {
	const table = await tx
		.updateTable("lookup_tables")
		.set(values)
		.where("project_id", "=", projectId)
		.where("id", "=", tableId)
		.returningAll()
		.executeTakeFirst();
	if (!table) {
		throw new Error("Locked lookup table disappeared before its update.");
	}
	return table;
}

export async function notifyCommittedLookupMutation(
	tx: Transaction<AppDatabase>,
	projectId: string,
	projectRevision: LookupRevision,
): Promise<void> {
	await notifyLookupProject(tx, projectId, projectRevision);
}
