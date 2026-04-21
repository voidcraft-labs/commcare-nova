/**
 * TipTap Suggestion configuration for CommCare hashtag references.
 *
 * Wires the # trigger character to ReferenceProvider.search() for autocomplete,
 * and renders the ReferenceAutocomplete dropdown via a React portal managed
 * through the Suggestion lifecycle callbacks (onStart, onUpdate, onKeyDown, onExit).
 *
 * Two-phase autocomplete:
 *   1. Bare "#" or "#f" → shows namespace options (#form/, #case/, #user/)
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
import { REFERENCE_TYPES } from "@/lib/references/config";
import type { ReferenceProvider } from "@/lib/references/provider";
import type { Reference, ReferenceType } from "@/lib/references/types";

/** A namespace option for the namespace stage (before "/" is typed). */
interface NamespaceItem {
	kind: "namespace";
	type: ReferenceType;
	label: string;
}

/** Union of item types the suggestion can return and pass to command(). */
type SuggestionItem = Reference | NamespaceItem;

/**
 * Parse the suggestion query text into a namespace + partial path.
 * The query is everything after the trigger char "#".
 *   - "fo" → { namespace: null, partial: "fo" } (still typing namespace)
 *   - "form/" → { namespace: "form", partial: "" }
 *   - "form/pat" → { namespace: "form", partial: "pat" }
 */
function parseQuery(query: string): {
	namespace: ReferenceType | null;
	partial: string;
} {
	const slashIdx = query.indexOf("/");
	if (slashIdx < 0) return { namespace: null, partial: query };
	const ns = query.slice(0, slashIdx);
	if (!(REFERENCE_TYPES as readonly string[]).includes(ns))
		return { namespace: null, partial: query };
	return { namespace: ns as ReferenceType, partial: query.slice(slashIdx + 1) };
}

/**
 * Create a TipTap Suggestion config wired to a ReferenceProvider.
 * The suggestion triggers on "#", shows namespace options first
 * (namespace stage), then filtered references after a namespace is
 * selected (reference stage). On selection, inserts a commcareRef node
 * (reference stage) or raw "#type/" text to re-trigger the namespace
 * stage.
 */
export function createRefSuggestion(
	provider: ReferenceProvider,
): Omit<SuggestionOptions, "editor"> {
	return {
		char: "#",
		allowSpaces: false,

		items: ({ query }: { query: string }): SuggestionItem[] => {
			const { namespace, partial } = parseQuery(query);

			/* Namespace stage: no namespace yet — show namespace options filtered by partial. */
			if (!namespace) {
				return REFERENCE_TYPES.filter((ns) =>
					ns.startsWith(partial.toLowerCase()),
				).map((ns) => ({
					kind: "namespace" as const,
					type: ns,
					label: `#${ns}/`,
				}));
			}

			/* Reference stage: namespace known — search references. */
			return provider.search(namespace, partial);
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
				/* Namespace stage: replace the partial with "#type/" to re-trigger suggestion. */
				editor
					.chain()
					.focus()
					.deleteRange(range)
					.insertContent(`#${props.type}/`)
					.run();
				return;
			}

			/* Reference stage: insert a commcareRef node with the selected reference's attributes. */
			const ref = props as Reference;
			editor
				.chain()
				.focus()
				.deleteRange(range)
				.insertContent({
					type: "commcareRef",
					attrs: { refType: ref.type, path: ref.path, label: ref.label },
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
				const { namespace } = parseQuery(props.query);
				const showNamespaces = !namespace;
				const items: Reference[] = showNamespaces
					? []
					: (props.items as Reference[]);

				root.render(
					createElement(ReferenceAutocomplete, {
						ref: componentRef,
						items,
						showNamespaces,
						onSelectNamespace: (type: ReferenceType) => {
							props.command({ kind: "namespace", type, label: `#${type}/` });
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
