// components/builder/media/useReferencedAssetRows.ts
//
// The asset rows a media display needs, read from the session's registry
// (`assetMeta`, filled by every library page, upload confirm and budget
// check) and fetched once for the ids it lacks. Every caller in one tick asks
// one shared batch, so a form of many media slots makes one resolve request,
// and a Project scope reset aborts the batch in flight and forgets what it
// asked, as the attach budget guard does.
//
// Each id reads as its row, `undefined` while the row is unknown and being
// resolved, or `null` when the resolve failed or no builder session is
// mounted (the chat's file previews): a caller then shows the file as it
// would without the row, so a transient failure never hides media.

"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import { isBuiltinIconRef } from "@/lib/domain/builtinIcons";
import {
	type AssetMetaRow,
	type BuilderSessionStoreApi,
	useOptionalBuilderSessionApi,
} from "@/lib/session/provider";
import { fetchAssetsByIds } from "./mediaClient";

type SessionApi = BuilderSessionStoreApi;

/** One session's shared resolve batch. */
class AssetRowBatch {
	private readonly asked = new Set<string>();
	private readonly failed = new Set<string>();
	private queued = new Set<string>();
	private flushScheduled = false;
	private readonly inFlight = new Set<AbortController>();
	private readonly listeners = new Set<() => void>();
	private version = 0;

	constructor(private readonly session: SessionApi) {}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	snapshot = (): number => this.version;

	hasFailed(id: string): boolean {
		return this.failed.has(id);
	}

	/** Ask for the rows of ids the registry lacks; each id is asked once. */
	request(ids: readonly string[]): void {
		const known = this.session.getState().assetMeta;
		for (const id of ids) {
			if (known[id] !== undefined || this.asked.has(id)) continue;
			this.asked.add(id);
			this.queued.add(id);
		}
		if (this.queued.size === 0 || this.flushScheduled) return;
		this.flushScheduled = true;
		queueMicrotask(() => {
			this.flushScheduled = false;
			void this.flush();
		});
	}

	private async flush(): Promise<void> {
		const ids = [...this.queued];
		this.queued = new Set();
		if (ids.length === 0) return;
		const controller = new AbortController();
		this.inFlight.add(controller);
		const scopeEpoch = this.session.getState().scopeEpoch;
		try {
			const rows = await fetchAssetsByIds(
				ids,
				this.session.getState().appId,
				controller.signal,
			);
			if (this.session.getState().scopeEpoch !== scopeEpoch) return;
			this.session.getState().recordAssetMeta(rows);
			const resolved = new Set<string>(rows.map((row) => row.id));
			for (const id of ids) if (!resolved.has(id)) this.failed.add(id);
		} catch {
			if (controller.signal.aborted) return;
			for (const id of ids) this.failed.add(id);
		} finally {
			this.inFlight.delete(controller);
			this.version += 1;
			for (const listener of this.listeners) listener();
		}
	}

	/** Forget every request and abort the one in flight: the Project changed. */
	reset(): void {
		for (const controller of this.inFlight) controller.abort();
		this.inFlight.clear();
		this.asked.clear();
		this.failed.clear();
		this.queued = new Set();
		this.version += 1;
		for (const listener of this.listeners) listener();
	}
}

const batches = new WeakMap<SessionApi, AssetRowBatch>();

function batchFor(session: SessionApi): AssetRowBatch {
	let batch = batches.get(session);
	if (batch === undefined) {
		batch = new AssetRowBatch(session);
		batches.set(session, batch);
	}
	return batch;
}

const NO_ROWS: Readonly<Record<string, AssetMetaRow>> = {};
const subscribeNothing = () => () => {};
const noVersion = () => 0;

/** The rows of `assetIds`: each a row, `undefined` while resolving, or `null` when it could not be. */
export function useReferencedAssetRows(
	assetIds: readonly string[],
): Readonly<Record<string, AssetMetaRow | null | undefined>> {
	const session = useOptionalBuilderSessionApi();
	const reconciler = useReconcilerContext();
	const batch = session === null ? null : batchFor(session);
	useSyncExternalStore(
		batch?.subscribe ?? subscribeNothing,
		batch?.snapshot ?? noVersion,
		batch?.snapshot ?? noVersion,
	);
	const readMeta = () => session?.getState().assetMeta ?? NO_ROWS;
	const assetMeta = useSyncExternalStore(
		session?.subscribe ?? subscribeNothing,
		readMeta,
		readMeta,
	);
	const ids = assetIds.filter((id) => !isBuiltinIconRef(id));
	const key = ids.join(",");

	useEffect(() => {
		if (batch === null) return;
		return reconciler?.subscribeProjectScopeReset(() => batch.reset());
	}, [reconciler, batch]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the ids it joins
	useEffect(() => {
		batch?.request(ids);
	}, [batch, key]);

	const rows: Record<string, AssetMetaRow | null | undefined> = {};
	for (const id of ids) {
		rows[id] =
			assetMeta[id] ??
			(batch === null || batch.hasFailed(id) ? null : undefined);
	}
	return rows;
}
