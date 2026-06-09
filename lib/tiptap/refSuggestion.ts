/**
 * TipTap Suggestion configuration for CommCare hashtag references.
 *
 * Wires the # trigger character to ReferenceProvider.search() for autocomplete,
 * and renders the ReferenceAutocomplete dropdown via a React portal managed
 * through the Suggestion lifecycle callbacks (onStart, onUpdate, onKeyDown, onExit).
 *
 * Two-phase autocomplete:
 *   1. Bare "#" or "#f" → shows namespace options (#form/, #user/, and one
 *      per readable case type — #mother/, …)
 *   2. After namespace "#form/pat" → shows filtered references
 */

import type { Editor, Range } from "@tiptap/core";
import type {
	SuggestionKeyDownProps,
	SuggestionOptions,
	SuggestionProps,
} from "@tiptap/suggestion";
import { createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	ReferenceAutocomplete,
	type ReferenceAutocompleteHandle,
} from "@/components/builder/ReferenceAutocomplete";
import { classifyNamespace, namespaceOf } from "@/lib/references/config";
import type { ReferenceProvider } from "@/lib/references/provider";
import type { Reference, ReferenceType } from "@/lib/references/types";

/** A namespace option for the namespace stage (before "/" is typed). `namespace`
 *  is the wire token (`form`/`user`/case-type name); `type` is the coarse family
 *  driving the icon + color. */
export interface NamespaceItem {
	kind: "namespace";
	namespace: string;
	type: ReferenceType;
	label: string;
}

/** Union of item types the suggestion can return and pass to command(). */
type SuggestionItem = Reference | NamespaceItem;

/**
 * Parse the suggestion query text into a namespace + partial path, validating
 * the namespace against the live list (`form`/`user` + readable case types).
 * The query is everything after the trigger char "#".
 *   - "fo" → { namespace: null, partial: "fo" } (still typing namespace)
 *   - "form/" → { namespace: "form", partial: "" }
 *   - "mother/hou" → { namespace: "mother", partial: "hou" }
 */
function parseQuery(
	query: string,
	namespaces: string[],
): { namespace: string | null; partial: string } {
	const slashIdx = query.indexOf("/");
	if (slashIdx < 0) return { namespace: null, partial: query };
	const ns = query.slice(0, slashIdx);
	if (!namespaces.includes(ns)) return { namespace: null, partial: query };
	return { namespace: ns, partial: query.slice(slashIdx + 1) };
}

/**
 * Create a TipTap Suggestion config wired to a ReferenceProvider.
 * The suggestion triggers on "#", shows namespace options first
 * (namespace stage), then filtered references after a namespace is
 * selected (reference stage). On selection, inserts a commcareRef node
 * (reference stage) or raw "#<namespace>/" text to re-trigger the namespace
 * stage. `getFormUuid` supplies the form whose readable namespaces + fields +
 * case types the suggestion resolves against.
 */
export function createRefSuggestion(
	provider: ReferenceProvider,
	getFormUuid: () => string | undefined,
): Omit<SuggestionOptions, "editor"> {
	return {
		char: "#",
		allowSpaces: false,

		items: ({ query }: { query: string }): SuggestionItem[] => {
			const formUuid = getFormUuid();
			const namespaces = provider.namespaces(formUuid);
			const { namespace, partial } = parseQuery(query, namespaces);

			/* Namespace stage: no namespace yet — show namespace options filtered by partial. */
			if (!namespace) {
				return namespaces
					.filter((ns) => ns.startsWith(partial.toLowerCase()))
					.map((ns) => ({
						kind: "namespace" as const,
						namespace: ns,
						type: classifyNamespace(ns),
						label: `#${ns}/`,
					}));
			}

			/* Reference stage: namespace known — search references. */
			return provider.search(namespace, partial, formUuid);
		},

		command: ({
			editor,
			range,
			props,
		}: {
			editor: Editor;
			range: Range;
			props: SuggestionItem;
		}) => {
			if ("kind" in props && props.kind === "namespace") {
				/* Namespace stage: replace the partial with "#<namespace>/" to re-trigger suggestion. */
				editor
					.chain()
					.focus()
					.deleteRange(range)
					.insertContent(`#${props.namespace}/`)
					.run();
				return;
			}

			/* Reference stage: insert a commcareRef node. `refType` carries the
			 * namespace (a case-type name for case refs), derived through
			 * `namespaceOf` — never the literal coarse "case". */
			const ref = props as Reference;
			editor
				.chain()
				.focus()
				.deleteRange(range)
				.insertContent({
					type: "commcareRef",
					attrs: {
						refType: namespaceOf(ref),
						path: ref.path,
						label: ref.label,
					},
				})
				.insertContent(" ")
				.run();
		},

		render: () => {
			let root: Root | null = null;
			let container: HTMLDivElement | null = null;
			const componentRef = createRef<ReferenceAutocompleteHandle>();

			return {
				onStart: (props: SuggestionProps) => {
					container = document.createElement("div");
					container.style.cssText =
						"position: absolute; z-index: var(--z-popover, 50);";
					document.body.appendChild(container);
					root = createRoot(container);
					updatePopup(props);
					updatePosition(props);
				},

				onUpdate: (props: SuggestionProps) => {
					updatePopup(props);
					updatePosition(props);
				},

				onKeyDown: (props: SuggestionKeyDownProps) => {
					if (props.event.key === "Escape") {
						destroy();
						return true;
					}
					return componentRef.current?.onKeyDown(props.event) ?? false;
				},

				onExit: () => {
					destroy();
				},
			};

			/** Re-render the autocomplete dropdown with the current suggestion state. */
			function updatePopup(props: SuggestionProps) {
				if (!root) return;
				const namespaces = provider.namespaces(getFormUuid());
				const { namespace } = parseQuery(props.query, namespaces);
				const showNamespaces = !namespace;
				const namespaceItems = showNamespaces
					? (props.items as NamespaceItem[])
					: [];
				const items: Reference[] = showNamespaces
					? []
					: (props.items as Reference[]);

				root.render(
					createElement(ReferenceAutocomplete, {
						ref: componentRef,
						namespaceItems,
						items,
						showNamespaces,
						onSelectNamespace: (ns: string) => {
							props.command({
								kind: "namespace",
								namespace: ns,
								type: classifyNamespace(ns),
								label: `#${ns}/`,
							});
						},
						onSelect: (ref: Reference) => {
							props.command(ref);
						},
					}),
				);
			}

			/** Position the dropdown below the trigger decoration node. */
			function updatePosition(props: SuggestionProps) {
				if (!container || !props.decorationNode) return;
				const rect = (
					props.decorationNode as HTMLElement
				).getBoundingClientRect();
				container.style.left = `${rect.left}px`;
				container.style.top = `${rect.bottom + 4}px`;
			}

			/** Tear down the React root and remove the container from the DOM. */
			function destroy() {
				root?.unmount();
				root = null;
				container?.remove();
				container = null;
			}
		},
	};
}
