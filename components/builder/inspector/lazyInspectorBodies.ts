/** Shared lazy imports for heavyweight field-editor surfaces.
 *
 * The rail header stays synchronous so a selection responds immediately.
 * Field properties, section properties, and CodeMirror are useful only around
 * field inspection; idle time and tree intent start those chunks before the
 * route change without adding them to Builder startup.
 */

type FieldInspectorModule =
	typeof import("@/components/builder/editor/FieldInspectorBody");
type XPathEditorModule =
	typeof import("@/components/builder/editor/fields/XPathEditor");

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

const fieldInspector = createRecoverableLazyModule<FieldInspectorModule>(
	() => import("@/components/builder/editor/FieldInspectorBody"),
);
const xpathEditor = createRecoverableLazyModule<XPathEditorModule>(
	() => import("@/components/builder/editor/fields/XPathEditor"),
);

/** One shared promise and resolved snapshot. Unlike a bare dynamic import, the
 * resolved component can be read synchronously by the inspector after an idle
 * or tree-intent preload, so its urgent render never waits behind the form's
 * concurrent first-visit mount. */
export function loadFieldInspectorBody(): Promise<FieldInspectorModule> {
	return fieldInspector.load();
}

export function getFieldInspectorBodySnapshot(): RecoverableLazyModuleSnapshot<FieldInspectorModule> {
	return fieldInspector.getSnapshot();
}

export function getFieldInspectorBodyServerSnapshot(): RecoverableLazyModuleSnapshot<FieldInspectorModule> {
	return getLazyModuleServerSnapshot();
}

export function subscribeFieldInspectorBody(listener: () => void): () => void {
	return fieldInspector.subscribe(listener);
}

export const loadSectionInspectorBody = () =>
	import("@/components/builder/editor/SectionInspectorBody");

/** XPath is the common heavyweight editor for real-world forms. Keeping its
 * loader here lets the field schema and the tree's intent-driven prefetch share
 * one module promise without making CodeMirror part of Builder startup. */
export function loadXPathEditor(): Promise<XPathEditorModule> {
	return xpathEditor.load();
}

export function getXPathEditorSnapshot(): RecoverableLazyModuleSnapshot<XPathEditorModule> {
	return xpathEditor.getSnapshot();
}

export function getXPathEditorServerSnapshot(): RecoverableLazyModuleSnapshot<XPathEditorModule> {
	return getLazyModuleServerSnapshot();
}

export function subscribeXPathEditor(listener: () => void): () => void {
	return xpathEditor.subscribe(listener);
}
