"use client";

import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useState } from "react";
// --- Icons ---
import { CodeBlockIcon } from "@/components/tiptap-icons/code-block-icon";
// --- Hooks ---
import { useTiptapEditor } from "@/hooks/use-tiptap-editor";
// --- Lib ---
import {
	findNodePosition,
	getSelectedBlockNodes,
	isNodeInSchema,
	isNodeTypeSelected,
	isValidPosition,
	selectionWithinConvertibleTypes,
} from "@/lib/tiptap-utils";

export const CODE_BLOCK_SHORTCUT_KEY = "mod+alt+c";

/**
 * Configuration for the code block functionality
 */
export interface UseCodeBlockConfig {
	/**
	 * The Tiptap editor instance.
	 */
	editor?: Editor | null;
	/**
	 * Whether the button should hide when code block is not available.
	 * @default false
	 */
	hideWhenUnavailable?: boolean;
	/**
	 * Callback function called after a successful code block toggle.
	 */
	onToggled?: () => void;
}

/**
 * Checks if code block can be toggled in the current editor state
 */
export function canToggle(
	editor: Editor | null,
	turnInto: boolean = true,
): boolean {
	if (!editor?.isEditable) return false;
	if (
		!isNodeInSchema("codeBlock", editor) ||
		isNodeTypeSelected(editor, ["image"])
	)
		return false;

	if (!turnInto) {
		return editor.can().toggleNode("codeBlock", "paragraph");
	}

	// Ensure selection is in nodes we're allowed to convert
	if (
		!selectionWithinConvertibleTypes(editor, [
			"paragraph",
			"heading",
			"bulletList",
			"orderedList",
			"taskList",
			"blockquote",
			"codeBlock",
		])
	)
		return false;

	// Either we can toggle code block directly on the selection,
	// or we can clear formatting/nodes to arrive at a code block.
	return (
		editor.can().toggleNode("codeBlock", "paragraph") ||
		editor.can().clearNodes()
	);
}

/**
 * Toggles code block in the editor
 */
export function toggleCodeBlock(editor: Editor | null): boolean {
	if (!editor?.isEditable) return false;
	if (!canToggle(editor)) return false;

	try {
		/* When code block is already active, toggle back to paragraph directly —
		 * TipTap handles this without needing the NodeSelection conversion path. */
		if (editor.isActive("codeBlock")) {
			editor.chain().focus().toggleNode("codeBlock", "paragraph").run();
			editor.chain().focus().selectTextblockEnd().run();
			return true;
		}

		const view = editor.view;
		let state = view.state;
		let tr = state.tr;

		const blocks = getSelectedBlockNodes(editor);

		/* When converting a non-code-block, we only allow
		 * "turn into" when there's exactly one block selected */
		const isPossibleToTurnInto =
			selectionWithinConvertibleTypes(editor, [
				"paragraph",
				"heading",
				"bulletList",
				"orderedList",
				"taskList",
				"blockquote",
				"codeBlock",
			]) && blocks.length === 1;

		/* For a collapsed cursor or text selection, convert to a NodeSelection
		 * around the parent block so clearNodes can normalize it first */
		if (
			(state.selection.empty || state.selection instanceof TextSelection) &&
			isPossibleToTurnInto
		) {
			const pos = findNodePosition({
				editor,
				node: state.selection.$anchor.node(1),
			})?.pos;
			if (!isValidPosition(pos)) return false;

			tr = tr.setSelection(NodeSelection.create(state.doc, pos));
			view.dispatch(tr);
			state = view.state;
		}

		const selection = state.selection;

		let chain = editor.chain().focus();

		/* Handle NodeSelection — clear the block structure first,
		 * then set the code block */
		if (selection instanceof NodeSelection) {
			const firstChild = selection.node.firstChild?.firstChild;
			const lastChild = selection.node.lastChild?.lastChild;

			const from = firstChild
				? selection.from + firstChild.nodeSize
				: selection.from + 1;

			const to = lastChild
				? selection.to - lastChild.nodeSize
				: selection.to - 1;

			const resolvedFrom = state.doc.resolve(from);
			const resolvedTo = state.doc.resolve(to);

			chain = chain
				.setTextSelection(TextSelection.between(resolvedFrom, resolvedTo))
				.clearNodes();
		}

		chain.toggleNode("codeBlock", "paragraph").run();

		editor.chain().focus().selectTextblockEnd().run();

		return true;
	} catch {
		return false;
	}
}

/**
 * Determines if the code block button should be shown
 */
export function shouldShowButton(props: {
	editor: Editor | null;
	hideWhenUnavailable: boolean;
}): boolean {
	const { editor, hideWhenUnavailable } = props;

	if (!editor) return false;

	if (!hideWhenUnavailable) {
		return true;
	}

	if (!editor.isEditable) return false;

	if (!isNodeInSchema("codeBlock", editor)) return false;

	if (!editor.isActive("code")) {
		return canToggle(editor);
	}

	return true;
}

/**
 * Custom hook that provides code block functionality for Tiptap editor
 *
 * @example
 * ```tsx
 * // Simple usage - no params needed
 * function MySimpleCodeBlockButton() {
 *   const { isVisible, isActive, handleToggle } = useCodeBlock()
 *
 *   if (!isVisible) return null
 *
 *   return (
 *     <button
 *       onClick={handleToggle}
 *       aria-pressed={isActive}
 *     >
 *       Code Block
 *     </button>
 *   )
 * }
 *
 * // Advanced usage with configuration
 * function MyAdvancedCodeBlockButton() {
 *   const { isVisible, isActive, handleToggle, label } = useCodeBlock({
 *     editor: myEditor,
 *     hideWhenUnavailable: true,
 *     onToggled: (isActive) => console.log('Code block toggled:', isActive)
 *   })
 *
 *   if (!isVisible) return null
 *
 *   return (
 *     <MyButton
 *       onClick={handleToggle}
 *       aria-label={label}
 *       aria-pressed={isActive}
 *     >
 *       Toggle Code Block
 *     </MyButton>
 *   )
 * }
 * ```
 */
export function useCodeBlock(config?: UseCodeBlockConfig) {
	const {
		editor: providedEditor,
		hideWhenUnavailable = false,
		onToggled,
	} = config || {};

	const { editor } = useTiptapEditor(providedEditor);
	const [isVisible, setIsVisible] = useState<boolean>(true);
	const canToggleState = canToggle(editor);
	const isActive = editor?.isActive("codeBlock") || false;

	useEffect(() => {
		if (!editor) return;

		const handleSelectionUpdate = () => {
			setIsVisible(shouldShowButton({ editor, hideWhenUnavailable }));
		};

		handleSelectionUpdate();

		editor.on("selectionUpdate", handleSelectionUpdate);

		return () => {
			editor.off("selectionUpdate", handleSelectionUpdate);
		};
	}, [editor, hideWhenUnavailable]);

	const handleToggle = useCallback(() => {
		if (!editor) return false;

		const success = toggleCodeBlock(editor);
		if (success) {
			onToggled?.();
		}
		return success;
	}, [editor, onToggled]);

	return {
		isVisible,
		isActive,
		handleToggle,
		canToggle: canToggleState,
		label: "Code Block",
		shortcutKeys: CODE_BLOCK_SHORTCUT_KEY,
		Icon: CodeBlockIcon,
	};
}
