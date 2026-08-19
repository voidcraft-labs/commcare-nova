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

import type { CaseStore, JsonObject } from "@/lib/case-store";
import {
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

/**
 * The worker's case id IS their own id.
 *
 * Nova picks this id freely — the wire finds a usercase by a `casedb` join on
 * `hq_user_id` (`app_manager/xpath.py::UsercaseXPath.case()`), never by
 * matching an id HQ chose — so the useful choice is the one that makes the
 * sync idempotent BY CONSTRUCTION rather than by care. `cases` is keyed on
 * `case_id` alone, so two concurrent syncs for one worker cannot produce two
 * usercases; the second collides with the first instead of racing it.
 *
 * Safe because a persona uuid is never reissued. A removed persona's row is
 * CLOSED rather than deleted, and a reissued uuid would collide with that
 * closed row instead of quietly reopening someone else's history.
 */
function usercaseIdFor(worker: UsercaseWorker): string {
	return worker.id;
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
): Promise<{ readonly created: boolean; readonly changed: number }> {
	const { appId, worker, authored, doc, projectSpace } = args;
	const caseId = usercaseIdFor(worker);
	const record = usercaseRecord(worker, authored, doc, projectSpace);
	const { caseName, properties } = splitRecord(record);
	const caseTypeSchemas = new Map([
		[USERCASE_CASE_TYPE, usercaseCaseType(doc)],
	]);

	// `includeHeld` so a usercase whose value is parked still counts as
	// existing. Without it a held row is invisible here and the insert below
	// collides with its own primary key rather than updating it.
	const existing = await store.query({
		appId,
		caseType: USERCASE_CASE_TYPE,
		caseTypeSchemas,
		predicate: eq(prop(USERCASE_CASE_TYPE, "case_id"), literal(caseId)),
		limit: 1,
		includeHeld: true,
	});

	const current = existing[0];
	if (current === undefined) {
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
		return { created: true, changed: Object.keys(properties).length };
	}

	const changed = usercaseChangedFields(
		(current.properties ?? {}) as Record<string, unknown>,
		// The split above emits strings only; the JSONB round-trip is what
		// widens the type, and `usercaseChangedFields` coerces to text to
		// absorb exactly that.
		properties as Record<string, string>,
	);
	const renamed = current.case_name !== caseName;
	if (Object.keys(changed).length === 0 && !renamed) {
		return { created: false, changed: 0 };
	}
	await store.update({
		appId,
		caseId,
		patch: {
			...(renamed && { case_name: caseName }),
			...(Object.keys(changed).length > 0 && { properties: changed }),
		},
	});
	return { created: false, changed: Object.keys(changed).length };
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
 * here because a persona uuid is never reissued — which is also what makes the
 * worker's id safe to use as the case id.
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
