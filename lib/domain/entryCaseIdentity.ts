// lib/domain/entryCaseIdentity.ts
//
// The id each `uuid()` session datum of one form entry holds.
//
// CommCare evaluates a function datum once, when the session reaches it, so
// every read of `session/data/case_id_new_<type>_0` during the entry, and the
// case block that creates the case, see one id. Preview mints that id from
// the entry key instead of at random: the browser's form, the server that
// saves the submission and the next-task evaluation after it derive the same
// id for the same entry, and an exact retry carries the same entry key, so it
// derives the same ids.

import { v5 as uuidv5 } from "uuid";
import { type DatumRef, datumRefKey } from "./expression/types";

/** Fixed namespace of Nova's entry case ids. Changing it changes every id a
 *  retried submission derives, so it never changes. */
const ENTRY_CASE_ID_NAMESPACE = "3c1d7e52-9a4f-4b6e-8d21-5f0a7b9c2e64";

/**
 * The key of one function datum within an entry: the created case it names
 * (`new-case`, `new-child-case:<type>`), or, for a `uuid()` datum that names
 * no case Nova creates, its datum id.
 */
export function entryDatumCaseKey(
	ref: Extract<DatumRef, { kind: "new-case" | "new-child-case" }> | undefined,
	datumId: string,
): string {
	return ref === undefined ? `placeholder:${datumId}` : datumRefKey(ref);
}

/**
 * Numbers the keys of an entry's new-case datums, met in entry order. An
 * entry can give several new cases of one type a datum (an advanced form's
 * open actions, a basic form's subcases outside a repeat), and each needs its
 * own id, so the first datum of a key keeps it plain (`new-child-case:<type>`)
 * and each later one takes its position among them (`new-child-case:<type>:1`,
 * `:2`, …). The entry's session and the submission number the same datums
 * in the same order, so they derive the same ids.
 */
export function entryNewCaseKeyNumbering(): (
	ref: Extract<DatumRef, { kind: "new-case" | "new-child-case" }>,
) => string {
	const seen = new Map<string, number>();
	return (ref) => {
		const key = datumRefKey(ref);
		const earlier = seen.get(key) ?? 0;
		seen.set(key, earlier + 1);
		return earlier === 0 ? key : `${key}:${earlier}`;
	};
}

/** The case id the datum keyed `key` holds in entry `entryKey` of app `appId`. */
export function entryDatumCaseId(
	appId: string,
	entryKey: string,
	key: string,
): string {
	return uuidv5(`${appId}\0${entryKey}\0${key}`, ENTRY_CASE_ID_NAMESPACE);
}
