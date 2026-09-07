// lib/db/syncUsercaseRow.ts
//
// Keep one worker's `commcare-user` row in step with the document.
//
// HQ's trigger is "each time a user is saved" (`sync_usercase.py::sync_usercases`),
// and Nova's equivalents are the commit that edits a persona and the preview
// that resolves one. Both call this; it is idempotent, so calling it twice
// costs a read and writes nothing.
//
// The row is Nova-managed. No author creates or closes one, and nothing here
// invents a value — the contents come from `usercaseRecord`, the same
// derivation Preview answers `#user/<prop>` from, because the wire resolves
// that hashtag against `casedb` and a projection that drifted from the row
// would make Preview disagree with a device.

import "server-only";

import { v5 as uuidv5 } from "uuid";
import type { CaseStore, JsonObject } from "@/lib/case-store";
import {
	assignedLocationUuids,
	isStandardCaseListProperty,
	type Persona,
	personasOf,
	personaUserData,
	USERCASE_CASE_TYPE,
	type UserCollections,
	type UsercaseWorker,
	usercaseCaseType,
	usercaseChangedFields,
	usercaseRecord,
} from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate";

/** New records are stable per app and worker. Existing rows are always found
 * by hq_user_id, so their historical case identity is preserved. Project is
 * deliberately absent: moving an app does not create a new worker record. */
function usercaseIdFor(appId: string, worker: UsercaseWorker): string {
	return uuidv5(
		JSON.stringify(["nova-usercase-v1", appId, worker.id]),
		uuidv5.URL,
	);
}

/** The semantic identity used by the device: case type plus hq_user_id inside
 * this app's tenant scope. Held and closed rows still exist; materialization
 * must not replace or reopen them. A duplicate is an invariant failure, never
 * an arbitrary first-row choice. */
export async function findUsercaseRow(
	store: CaseStore,
	args: {
		readonly appId: string;
		readonly workerId: string;
		readonly doc: UserCollections;
	},
) {
	const rows = await store.query({
		appId: args.appId,
		caseType: USERCASE_CASE_TYPE,
		caseTypeSchemas: new Map([
			[USERCASE_CASE_TYPE, usercaseCaseType(args.doc)],
		]),
		predicate: eq(
			prop(USERCASE_CASE_TYPE, "hq_user_id"),
			literal(args.workerId),
		),
		limit: 2,
		includeHeld: true,
	});
	if (rows.length > 1)
		throw new Error("More than one worker record exists for this app.");
	if (rows[0] !== undefined && rows[0].owner_id !== args.workerId) {
		throw new Error("The worker record belongs to a different owner.");
	}
	return rows[0];
}

/** The record split the way the case store stores it: reserved scalars to
 *  their own columns, everything else to the JSONB document. */
function splitRecord(record: Record<string, string>): {
	readonly caseName: string;
	readonly properties: JsonObject;
} {
	const properties: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		if (isStandardCaseListProperty(key)) continue;
		properties[key] = value;
	}
	return { caseName: record.case_name ?? "", properties };
}

export interface SyncUsercaseRowArgs {
	readonly appId: string;
	/**
	 * The worker this case belongs to. `store` MUST be bound with the same id
	 * as its `ownerId`: `CaseInsert` carries no `owner_id`, the store stamps it
	 * from the identity it holds, and a usercase owned by anyone else is
	 * outside its own worker's restore.
	 */
	readonly worker: UsercaseWorker;
	/** Authored worker-property values, keyed by property uuid. */
	readonly authored: Record<string, string>;
	readonly doc: UserCollections;
	readonly projectSpace: string | null;
	/**
	 * Create the row when it is missing and otherwise leave it alone.
	 *
	 * The trigger is what this protects. HQ syncs a usercase when a USER IS
	 * SAVED, and Nova's equivalent is the commit that edits a persona. Preview
	 * calls this on every resolve for a different reason — to guarantee the row
	 * EXISTS for a worker no commit ever described — and a full sync on that
	 * path would erase a value a form had just written: a declared property the
	 * persona has no value for is blank in the derived record, so the diff
	 * would overwrite the answer with `""` seconds after the worker gave it.
	 *
	 * Nothing is lost by holding back. The row is what a device reads, the
	 * commit path keeps it in step whenever the document says something new
	 * about that worker, and this returns the STORED properties either way.
	 */
	readonly ensureOnly?: boolean;
}

/**
 * Create the worker's case if it is missing, otherwise write only what
 * changed.
 *
 * The update path is HQ's `_get_changed_fields` twice over: this picks the
 * differing keys, and `CaseStore.update` JSONB-MERGES the patch rather than
 * replacing the document, so nothing the sync did not name is disturbed.
 *
 * What that does NOT buy, and it is worth being exact: a DECLARED property the
 * persona has no value for is blank in the desired record, and blank is a real
 * value HQ writes on purpose (`UserData.to_dict()` seeds every declared field
 * before anything is layered on). So the sync overwrites it, exactly as a user
 * save does in the field. The never-remove rule protects keys OUTSIDE the
 * record, and the case type's `additionalProperties: false` means the only way
 * to have one is for the catalog to have dropped a property whose values are
 * still on the rows — which `applySchemaChange` parks. An undeclared write
 * destination is therefore unstorable rather than merely unwise, and refusing
 * one belongs in `caseWrite` admission where an author can be told why.
 */
export async function syncUsercaseRow(
	store: CaseStore,
	args: SyncUsercaseRowArgs,
): Promise<{
	readonly created: boolean;
	readonly changed: number;
	/** The row's properties AFTER the sync — what `casedb` would hand a
	 *  device, which is not always what the projection derived. */
	readonly stored: Record<string, string>;
}> {
	const { appId, worker, authored, doc, projectSpace } = args;
	const caseId = usercaseIdFor(appId, worker);
	const record = usercaseRecord(worker, authored, doc, projectSpace);
	const { caseName, properties } = splitRecord(record);
	const lookup = { appId, workerId: worker.id, doc };
	let current = await findUsercaseRow(store, lookup);
	if (current === undefined) {
		try {
			await store.insert({
				appId,
				row: {
					case_id: caseId,
					case_type: USERCASE_CASE_TYPE,
					case_name: caseName,
					status: "open",
					properties,
				},
			});
			return {
				created: true,
				changed: Object.keys(properties).length,
				stored: properties as Record<string, string>,
			};
		} catch (error) {
			// insert owns its transaction, which has rolled back before rejecting.
			// A concurrent ensure may have created this exact row after our read.
			// Re-query by semantic identity; never accept an unrelated PK collision.
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				error.code !== "23505" ||
				!("constraint" in error) ||
				error.constraint !== "cases_pkey"
			)
				throw error;
			current = await findUsercaseRow(store, lookup);
			if (current === undefined || current.case_id !== caseId) throw error;
		}
	}

	if (args.ensureOnly === true) {
		const held: Record<string, string> = {};
		for (const [key, value] of Object.entries(current.properties ?? {})) {
			if (value !== null && value !== undefined) held[key] = String(value);
		}
		return { created: false, changed: 0, stored: held };
	}

	const changed = usercaseChangedFields(
		(current.properties ?? {}) as Record<string, unknown>,
		// The split above emits strings only; the JSONB round-trip is what
		// widens the type, and `usercaseChangedFields` coerces to text to
		// absorb exactly that.
		properties as Record<string, string>,
	);
	const storedBefore = (current.properties ?? {}) as Record<string, unknown>;
	// What the row holds once this sync lands: everything already on it, with
	// the changed keys over the top. A MERGE, matching what `update` does —
	// keys outside the desired record stay, which is exactly why the row and
	// the projection can differ and why the row is the one to believe.
	const stored: Record<string, string> = {};
	for (const [key, value] of Object.entries(storedBefore)) {
		if (value !== null && value !== undefined) stored[key] = String(value);
	}
	Object.assign(stored, changed);
	const renamed = current.case_name !== caseName;
	if (Object.keys(changed).length === 0 && !renamed) {
		return { created: false, changed: 0, stored };
	}
	await store.update({
		appId,
		caseId: current.case_id,
		patch: {
			...(renamed && { case_name: caseName }),
			...(Object.keys(changed).length > 0 && { properties: changed }),
		},
	});
	return { created: false, changed: Object.keys(changed).length, stored };
}

/**
 * The workers whose case a commit would change.
 *
 * Pure, and that is the point: the overwhelmingly common commit edits a field
 * and touches no worker at all, so it must cost ZERO queries. Syncing every
 * persona on every save would put one read per persona on the autosave path,
 * which fires constantly.
 *
 * A persona qualifies when its derived record differs from the one the prior
 * document implied, or when it is new. That catches every input at once — the
 * name, an authored value, its user type's defaults, and the worker-property
 * catalog itself — without enumerating which mutation kinds matter, a list
 * that would rot the first time a new one is added.
 */
export function workersNeedingUsercaseSync(args: {
	readonly prior: UserCollections;
	readonly next: UserCollections;
	readonly projectSpace: string | null;
}): ReadonlyArray<{
	readonly worker: UsercaseWorker;
	readonly authored: Record<string, string>;
}> {
	const { prior, next, projectSpace } = args;
	const priorPersonas = personasOf(prior);
	const changed: Array<{
		worker: UsercaseWorker;
		authored: Record<string, string>;
	}> = [];
	for (const persona of Object.values(personasOf(next))) {
		const worker = workerFromPersona(persona);
		const authored = personaUserData(persona, next);
		const desired = usercaseRecord(worker, authored, next, projectSpace);
		const before = priorPersonas[persona.uuid];
		const had =
			before === undefined
				? undefined
				: usercaseRecord(
						workerFromPersona(before),
						personaUserData(before, prior),
						prior,
						projectSpace,
					);
		if (had === undefined || !recordsEqual(had, desired)) {
			changed.push({ worker, authored });
		}
	}
	return changed;
}

/** The worker facts a persona supplies, matching what Preview resolves. */
export function workerFromPersona(persona: Persona): UsercaseWorker {
	return {
		id: persona.uuid,
		username: persona.name,
		personName: persona.name,
		email: "",
		locationIds: assignedLocationUuids(persona.locations),
	};
}

function recordsEqual(
	a: Record<string, string>,
	b: Record<string, string>,
): boolean {
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

/**
 * The workers a commit removed, whose case must be CLOSED rather than deleted.
 *
 * Matches HQ's deactivation path
 * (`sync_usercase.py::_get_sync_usercase_helper` closes the usercase and
 * leaves the cases that worker owned alone), and it matches Nova's own shipped
 * policy of preserving rows. HQ's reopen-on-return branch has no counterpart
 * here because a persona uuid is never reissued. The row is resolved by its
 * app-scoped hq_user_id; its case id may predate the current allocator.
 */
export function workersWithRemovedUsercases(args: {
	readonly prior: UserCollections;
	readonly next: UserCollections;
}): readonly string[] {
	const remaining = personasOf(args.next);
	return Object.keys(personasOf(args.prior)).filter(
		(uuid) => !Object.hasOwn(remaining, uuid),
	);
}
