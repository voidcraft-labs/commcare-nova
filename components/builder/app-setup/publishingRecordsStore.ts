/**
 * One held copy of each app's deployment records for every builder surface
 * mounted at once: the Publishing section, and each Connect id field whose
 * note says what a change means once the app is published. They share one
 * read per records revision instead of each sending its own.
 *
 * An app's entry lives while some surface subscribes to it. `ensureLoaded`
 * reads once per revision (the Publish dialog bumps the revision on every
 * record it writes), `reload` reads again on request, and `upsert` folds an
 * answer a surface already holds. Every state change goes through the pure
 * fold in `publishingSectionModel.ts`, whose generation guard drops the
 * answer of a superseded read.
 */

import type { DeploymentView } from "@/lib/deployment/actions";
import {
	applyRecordUpsert,
	beginRecordsLoad,
	INITIAL_PUBLISHING_RECORDS,
	type PublishingRecords,
	resolveRecordsLoad,
} from "./publishingSectionModel";

/** One read of an app's records: its views, or why they couldn't load. */
export type DeploymentsRead = (
	appId: string,
) => Promise<
	| { readonly ok: true; readonly views: readonly DeploymentView[] }
	| { readonly ok: false; readonly message: string }
>;

interface Entry {
	records: PublishingRecords;
	/** The records revision the latest read answers, once one started. */
	revision: number | undefined;
	readonly listeners: Set<() => void>;
}

export interface PublishingRecordsStore {
	subscribe(appId: string, listener: () => void): () => void;
	snapshot(appId: string): PublishingRecords;
	/** Read the app's records unless a read for `revision` already started. */
	ensureLoaded(appId: string, revision: number): void;
	/** Read the app's records again. */
	reload(appId: string): void;
	/** Fold a refresh, publish or provisioning answer into the held records. */
	upsert(appId: string, view: DeploymentView): void;
}

/** `failureMessage` is what the records say when the read itself rejects. */
export function createPublishingRecordsStore(
	read: DeploymentsRead,
	failureMessage: string,
): PublishingRecordsStore {
	const entries = new Map<string, Entry>();

	const set = (appId: string, entry: Entry, next: PublishingRecords) => {
		// A read that lands after its last subscriber left settles nothing.
		if (entries.get(appId) !== entry || next === entry.records) return;
		entry.records = next;
		for (const listener of entry.listeners) listener();
	};

	const startRead = (appId: string, entry: Entry) => {
		const generation = entry.records.generation + 1;
		set(appId, entry, beginRecordsLoad(entry.records, generation));
		read(appId).then(
			(outcome) =>
				set(
					appId,
					entry,
					resolveRecordsLoad(entry.records, generation, outcome),
				),
			() =>
				set(
					appId,
					entry,
					resolveRecordsLoad(entry.records, generation, {
						ok: false,
						message: failureMessage,
					}),
				),
		);
	};

	const entryFor = (appId: string): Entry => {
		let entry = entries.get(appId);
		if (entry === undefined) {
			entry = {
				records: INITIAL_PUBLISHING_RECORDS,
				revision: undefined,
				listeners: new Set(),
			};
			entries.set(appId, entry);
		}
		return entry;
	};

	return {
		subscribe(appId, listener) {
			const entry = entryFor(appId);
			entry.listeners.add(listener);
			return () => {
				entry.listeners.delete(listener);
				if (entry.listeners.size === 0 && entries.get(appId) === entry)
					entries.delete(appId);
			};
		},
		snapshot(appId) {
			return entries.get(appId)?.records ?? INITIAL_PUBLISHING_RECORDS;
		},
		ensureLoaded(appId, revision) {
			const entry = entryFor(appId);
			if (entry.revision === revision) return;
			entry.revision = revision;
			startRead(appId, entry);
		},
		reload(appId) {
			startRead(appId, entryFor(appId));
		},
		upsert(appId, view) {
			/* The answer an upsert carries is newer than any read in flight,
			 * so it takes a fresh generation and the superseded read's
			 * answer is dropped. */
			const entry = entryFor(appId);
			set(
				appId,
				entry,
				applyRecordUpsert(entry.records, view, entry.records.generation + 1),
			);
		},
	};
}
