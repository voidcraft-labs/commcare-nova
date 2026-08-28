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

let fieldInspectorModule: FieldInspectorModule | null = null;
let fieldInspectorPromise: Promise<FieldInspectorModule> | null = null;
const fieldInspectorListeners = new Set<() => void>();
let xpathEditorModule: XPathEditorModule | null = null;
let xpathEditorPromise: Promise<XPathEditorModule> | null = null;
const xpathEditorListeners = new Set<() => void>();

/** One shared promise and resolved snapshot. Unlike a bare dynamic import, the
 * resolved component can be read synchronously by the inspector after an idle
 * or tree-intent preload, so its urgent render never waits behind the form's
 * concurrent first-visit mount. */
export function loadFieldInspectorBody(): Promise<FieldInspectorModule> {
	if (fieldInspectorModule !== null)
		return Promise.resolve(fieldInspectorModule);
	fieldInspectorPromise ??= import(
		"@/components/builder/editor/FieldInspectorBody"
	)
		.then((module) => {
			fieldInspectorModule = module;
			for (const listener of fieldInspectorListeners) listener();
			return module;
		})
		.catch((error: unknown) => {
			fieldInspectorPromise = null;
			throw error;
		});
	return fieldInspectorPromise;
}

export function getLoadedFieldInspectorBody(): FieldInspectorModule | null {
	return fieldInspectorModule;
}

export function subscribeLoadedFieldInspectorBody(
	listener: () => void,
): () => void {
	fieldInspectorListeners.add(listener);
	return () => fieldInspectorListeners.delete(listener);
}

export const loadSectionInspectorBody = () =>
	import("@/components/builder/editor/SectionInspectorBody");

/** XPath is the common heavyweight editor for real-world forms. Keeping its
 * loader here lets the field schema and the tree's intent-driven prefetch share
 * one module promise without making CodeMirror part of Builder startup. */
export function loadXPathEditor(): Promise<XPathEditorModule> {
	if (xpathEditorModule !== null) return Promise.resolve(xpathEditorModule);
	xpathEditorPromise ??= import(
		"@/components/builder/editor/fields/XPathEditor"
	)
		.then((module) => {
			xpathEditorModule = module;
			for (const listener of xpathEditorListeners) listener();
			return module;
		})
		.catch((error: unknown) => {
			xpathEditorPromise = null;
			throw error;
		});
	return xpathEditorPromise;
}

export function getLoadedXPathEditor(): XPathEditorModule | null {
	return xpathEditorModule;
}

export function subscribeLoadedXPathEditor(listener: () => void): () => void {
	xpathEditorListeners.add(listener);
	return () => xpathEditorListeners.delete(listener);
}
