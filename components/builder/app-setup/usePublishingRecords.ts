/**
 * The app's deployment records, as every builder surface that reads them
 * holds them: the Publishing section, and the Connect id fields whose notes
 * say what a change means once the app is published.
 *
 * One read for all of them: every mounted surface subscribes to the one held
 * copy in `publishingRecordsStore.ts`, which reads through
 * `readDeploymentsAction` once per `useDeploymentRecordsRevision` (the
 * Publish dialog bumps it on every record it writes) and folds each answer
 * with the pure model in `publishingSectionModel.ts`, which owns the
 * stale-response guard.
 */
"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
	type DeploymentView,
	readDeploymentsAction,
} from "@/lib/deployment/actions";
import { useAppId, useDeploymentRecordsRevision } from "@/lib/session/hooks";
import { createPublishingRecordsStore } from "./publishingRecordsStore";
import {
	INITIAL_PUBLISHING_RECORDS,
	mayBePublished,
	type PublishingRecords,
} from "./publishingSectionModel";

const LOAD_FAILED_MESSAGE =
	"Nova couldn't load where this app has been published. Try again in a moment.";

/* A rejected Server Action lands in the records' own error slot through the
 * store's rejection arm. Without it the records sit on "loading" forever,
 * which reads as "you have published nowhere". */
const store = createPublishingRecordsStore(async (appId) => {
	const result = await readDeploymentsAction(appId);
	return result.success
		? { ok: true, views: result.data }
		: { ok: false, message: result.message };
}, LOAD_FAILED_MESSAGE);

const noSubscription = () => () => {};
const initialRecords = () => INITIAL_PUBLISHING_RECORDS;

export interface PublishingRecordsHandle {
	readonly records: PublishingRecords;
	/** Load the records again. */
	readonly load: () => void;
	/** Fold a refresh, publish or provisioning answer into the held records. */
	readonly upsert: (next: DeploymentView) => void;
}

export function usePublishingRecords(): PublishingRecordsHandle {
	// Absent only on a brand-new build before its app row exists, where
	// nothing has been published and there is no record to read.
	const appId = useAppId();
	const recordsRevision = useDeploymentRecordsRevision();

	const subscribe = useCallback(
		(listener: () => void) =>
			appId === undefined ? noSubscription() : store.subscribe(appId, listener),
		[appId],
	);
	const snapshot = useCallback(
		() =>
			appId === undefined ? INITIAL_PUBLISHING_RECORDS : store.snapshot(appId),
		[appId],
	);
	const records = useSyncExternalStore(subscribe, snapshot, initialRecords);

	useEffect(() => {
		if (appId !== undefined) store.ensureLoaded(appId, recordsRevision);
	}, [appId, recordsRevision]);

	const load = useCallback(() => {
		if (appId !== undefined) store.reload(appId);
	}, [appId]);
	const upsert = useCallback(
		(next: DeploymentView) => {
			if (appId !== undefined) store.upsert(appId, next);
		},
		[appId],
	);

	return { records, load, upsert };
}

/**
 * Whether a note that warns what a change does once the app is published
 * shows (`mayBePublished`): what the held records say, and also when the
 * read failed with nothing held, since the failure can't rule it out.
 */
export function useAppPublishedAnywhere(): boolean {
	const { records } = usePublishingRecords();
	return mayBePublished(records);
}
