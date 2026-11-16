/**
 * The tab's create key (`nova:bring-in-create`), and which mounted flow it
 * belongs to.
 *
 * The key is one per tab, but a tab can mount the flow more than once over
 * the same create: Bring it in, Go to your apps while the create runs, then
 * Back to the app's address, whose new flow resumes the key and joins the
 * create still running (one create sent twice answers one app). The first
 * flow's request is still open, and when it ends that flow is gone. If its end removed the key, it
 * would take it from under the creating screen that now stands on it, and a
 * reload there would read the app instead of sending the create again.
 *
 * So the key names the flow that holds it (`flow`, one id per mounted flow),
 * a flow that resumes the key takes it over, and a flow removes the key only
 * where it still names that flow. Within one flow a create is never sent
 * beside another (`nextAct` waits on any call in flight), so the flow's id is
 * enough to say whose the key is.
 */

import type { BringInInput } from "@/lib/deployment";

/** The tab's storage of the key, every access already inside `try`/`catch`. */
export interface CreateKeyStore {
	readonly read: () => string | null;
	readonly write: (value: string) => void;
	readonly remove: () => void;
}

function storedRecord(raw: string | null): Record<string, unknown> | null {
	if (raw === null) return null;
	try {
		const stored: unknown = JSON.parse(raw);
		return typeof stored === "object" &&
			stored !== null &&
			!Array.isArray(stored)
			? (stored as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** Writes the create the person asked for, held by `flow`: `{ at, input, flow }`. */
export function rememberCreate(
	store: CreateKeyStore,
	flow: string,
	input: BringInInput,
	at: number,
): void {
	store.write(JSON.stringify({ at, input, flow }));
}

/**
 * Takes over a key `resumableCreate` answered: the same `at` and `input`,
 * now held by `flow`. `at` is kept, so going Back and forth never stretches
 * the window a create is sent again in.
 */
export function adoptCreate(store: CreateKeyStore, flow: string): void {
	const stored = storedRecord(store.read());
	if (stored === null) return;
	store.write(JSON.stringify({ ...stored, flow }));
}

/** Removes the key where `flow` still holds it, and leaves another flow's key alone. */
export function forgetCreate(store: CreateKeyStore, flow: string): void {
	const stored = storedRecord(store.read());
	if (stored !== null && stored.flow === flow) store.remove();
}
