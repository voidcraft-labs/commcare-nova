/** Shared import ownership for surfaces that keep their shell usable while code loads. */

export type RecoverableLazyModuleSnapshot<T> =
	| { readonly status: "idle" }
	| { readonly status: "loading" }
	| { readonly status: "error" }
	| { readonly status: "ready"; readonly module: T };

const SERVER_LAZY_MODULE_SNAPSHOT = { status: "idle" } as const;

export function getLazyModuleServerSnapshot<
	T,
>(): RecoverableLazyModuleSnapshot<T> {
	return SERVER_LAZY_MODULE_SNAPSHOT;
}

/** A dynamic import cache that is also a complete external-store snapshot.
 * Rejections are published instead of leaving a mounted consumer subscribed to
 * the unchanged `null` value forever; calling `load` from the error state starts
 * a fresh import and publishes the retry transition. */
export function createRecoverableLazyModule<T>(importer: () => Promise<T>): {
	readonly load: () => Promise<T>;
	readonly getSnapshot: () => RecoverableLazyModuleSnapshot<T>;
	readonly subscribe: (listener: () => void) => () => void;
} {
	let snapshot: RecoverableLazyModuleSnapshot<T> = { status: "idle" };
	let pending: Promise<T> | null = null;
	const listeners = new Set<() => void>();
	const publish = (next: RecoverableLazyModuleSnapshot<T>) => {
		snapshot = next;
		for (const listener of listeners) listener();
	};
	const load = (): Promise<T> => {
		if (snapshot.status === "ready") return Promise.resolve(snapshot.module);
		if (pending !== null) return pending;
		publish({ status: "loading" });
		const request = Promise.resolve()
			.then(importer)
			.then((module) => {
				pending = null;
				publish({ status: "ready", module });
				return module;
			})
			.catch((error: unknown) => {
				pending = null;
				publish({ status: "error" });
				throw error;
			});
		pending = request;
		return request;
	};
	return {
		load,
		getSnapshot: () => snapshot,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
