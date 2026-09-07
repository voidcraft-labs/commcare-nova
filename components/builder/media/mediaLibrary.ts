import type { AssetKind } from "@/lib/domain/multimedia";
import { fetchMediaLibrary, type MediaAssetView } from "./mediaClient";

export interface MediaLibraryState {
	assets: MediaAssetView[];
	isLoading: boolean;
	error: string | null;
	hasMore: boolean;
}

/** One immutable app/Project/search scope. Retiring it aborts its request and
 * fences callbacks synchronously, before React renders a replacement scope. */
export function createMediaLibrary(options: {
	kinds?: readonly AssetKind[];
	appId?: string;
	query?: string;
	authorized: boolean;
}) {
	let state: MediaLibraryState = {
		assets: [],
		isLoading: options.authorized,
		error: null,
		hasMore: false,
	};
	const listeners = new Set<() => void>();
	let active = false;
	let cursor: string | undefined;
	let nextCursor: string | null = null;
	let append = false;
	let request: { controller: AbortController; promise: Promise<void> } | null =
		null;
	function publish(patch: Partial<MediaLibraryState>) {
		state = { ...state, ...patch };
		for (const notify of listeners) notify();
	}
	function fetchPage(): Promise<void> {
		if (!active || !options.authorized) return Promise.resolve();
		if (request) return request.promise;
		const controller = new AbortController();
		const current = { controller, promise: Promise.resolve() };
		request = current;
		publish({ isLoading: true, error: null });
		current.promise = (async () => {
			try {
				const page = await fetchMediaLibrary({
					kinds: options.kinds,
					query: options.query,
					appId: options.appId,
					cursor,
					signal: controller.signal,
				});
				if (!active || request !== current) return;
				nextCursor = page.nextCursor;
				publish({
					assets: append ? [...state.assets, ...page.assets] : page.assets,
					hasMore: nextCursor !== null,
				});
			} catch (error) {
				if (!active || request !== current || controller.signal.aborted) return;
				publish({
					error:
						error instanceof Error
							? error.message
							: "Couldn't load your media library.",
				});
			} finally {
				if (request === current) {
					request = null;
					if (active) publish({ isLoading: false });
				}
			}
		})();
		return current.promise;
	}
	return {
		getSnapshot: () => state,
		subscribe: (notify: () => void) => {
			listeners.add(notify);
			return () => {
				listeners.delete(notify);
			};
		},
		start() {
			active = true;
			return fetchPage();
		},
		stop() {
			active = false;
			request?.controller.abort();
			request = null;
		},
		loadMore() {
			if (request || !nextCursor) return request?.promise ?? Promise.resolve();
			cursor = nextCursor;
			append = true;
			return fetchPage();
		},
		retry: fetchPage,
		addUploaded(asset: MediaAssetView) {
			if (active && !state.assets.some((row) => row.id === asset.id))
				publish({ assets: [asset, ...state.assets] });
		},
		removeAsset(id: string) {
			if (active)
				publish({ assets: state.assets.filter((row) => row.id !== id) });
		},
		updateAsset(id: string, patch: Partial<MediaAssetView>) {
			if (active)
				publish({
					assets: state.assets.map((row) =>
						row.id === id ? { ...row, ...patch } : row,
					),
				});
		},
	};
}
