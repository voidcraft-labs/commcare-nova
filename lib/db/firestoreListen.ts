/**
 * Dedicated gRPC Firestore client for the relay route's `onSnapshot` listens.
 *
 * The main `getDb()` singleton runs `preferRest: true` (`firestoreClientOptions`),
 * and the REST transport has NO listen channel — an `onSnapshot` built on it
 * silently never fires in prod (localhost masks it, since the emulator is
 * always gRPC). This client re-uses the shared options but overrides the
 * transport back to gRPC (the trailing `preferRest: false` wins), so every
 * listen query the stream route builds actually delivers changes.
 *
 * A separate module-level singleton (not `getDb()`) so the whole app keeps the
 * REST client for its ordinary reads/writes — the gRPC channel is paid for only
 * by the long-lived relay connections that need a live listen.
 */

import { Firestore } from "@google-cloud/firestore";
import { firestoreClientOptions } from "./firestoreClientOptions";

let _db: Firestore | null = null;

/**
 * The gRPC-transport Firestore singleton, lazily built on first connect.
 *
 * Every `onSnapshot` in the relay route MUST be built on this client, never
 * `getDb()` — see the module comment for why a REST-client listen never fires.
 */
export function getListenDb(): Firestore {
	if (!_db) {
		_db = new Firestore({
			projectId: process.env.GOOGLE_CLOUD_PROJECT,
			...firestoreClientOptions(),
			// gRPC is required for `onSnapshot`; this trailing override wins over
			// the `preferRest` the shared options set for the REST-preferring
			// `getDb()`.
			preferRest: false,
		});
	}
	return _db;
}
