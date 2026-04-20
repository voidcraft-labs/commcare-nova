"use client";

import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useState } from "react";
import { HorizontalRuleIcon } from "@/components/tiptap-icons/horizontal-rule-icon";
import { isNodeInSchema } from "@/lib/tiptap-utils";
import { useTiptapEditor } from "@/lib/ui/hooks/useTiptapEditor";

/**
 * Configuration for the horizontal rule button hook.
 */
export interface UseHorizontalRuleConfig {
	editor?: Editor | null;
	hideWhenUnavailable?: boolean;
	onInserted?: () => void;
}

/**
 * Checks whether a horizontal rule can be inserted.
 */
export function canInsertHorizontalRule(editor: Editor | null): boolean {
	if (!editor?.isEditable) return false;
	return isNodeInSchema("horizontalRule", editor);
}

/**
 * Inserts a horizontal rule at the current cursor position.
 */
export function insertHorizontalRule(editor: Editor | null): boolean {
	if (!editor?.isEditable) return false;
	if (!canInsertHorizontalRule(editor)) return false;
	return editor.chain().focus().setHorizontalRule().run();
}

/**
 * Hook providing horizontal rule insertion for toolbar buttons.
 */
export function useHorizontalRule(config?: UseHorizontalRuleConfig) {
	const {
		editor: providedEditor,
		hideWhenUnavailable = false,
		onInserted,
	} = config || {};

	const { editor } = useTiptapEditor(providedEditor);
	const [isVisible, setIsVisible] = useState<boolean>(true);
	const canInsert = canInsertHorizontalRule(editor);

	useEffect(() => {
		if (!editor) return;

		const handleSelectionUpdate = () => {
			setIsVisible(!hideWhenUnavailable || canInsertHorizontalRule(editor));
		};

		handleSelectionUpdate();
		editor.on("selectionUpdate", handleSelectionUpdate);
		return () => {
			editor.off("selectionUpdate", handleSelectionUpdate);
		};
	}, [editor, hideWhenUnavailable]);

	const handleInsert = useCallback(() => {
		if (!editor) return false;
		const success = insertHorizontalRule(editor);
		if (success) onInserted?.();
		return success;
	}, [editor, onInserted]);

	return {
		isVisible,
		isActive: false,
		handleInsert,
		canInsert,
		label: "Horizontal Rule",
		Icon: HorizontalRuleIcon,
	};
}
