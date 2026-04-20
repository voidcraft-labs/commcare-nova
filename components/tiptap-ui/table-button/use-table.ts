"use client";

import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useState } from "react";
import { TableIcon } from "@/components/tiptap-icons/table-icon";
import { isNodeInSchema } from "@/lib/tiptap-utils";
import { useTiptapEditor } from "@/lib/ui/hooks/useTiptapEditor";

/**
 * Configuration for the table button hook.
 */
export interface UseTableConfig {
	editor?: Editor | null;
	hideWhenUnavailable?: boolean;
	onInserted?: () => void;
}

/**
 * Checks whether a table can be inserted in the current editor state.
 */
export function canInsertTable(editor: Editor | null): boolean {
	if (!editor?.isEditable) return false;
	return isNodeInSchema("table", editor);
}

/**
 * Inserts a table with the specified dimensions at the current cursor position.
 * Always creates a header row — GFM pipe tables require a header separator line,
 * so the first row uses `TableHeader` cells and the rest use `TableCell`.
 */
export function insertTable(
	editor: Editor | null,
	rows: number = 3,
	cols: number = 3,
): boolean {
	if (!editor?.isEditable) return false;
	if (!canInsertTable(editor)) return false;
	return editor
		.chain()
		.focus()
		.insertTable({ rows, cols, withHeaderRow: true })
		.run();
}

/**
 * Hook providing table insertion state and action for toolbar buttons.
 */
export function useTable(config?: UseTableConfig) {
	const {
		editor: providedEditor,
		hideWhenUnavailable = false,
		onInserted,
	} = config || {};

	const { editor } = useTiptapEditor(providedEditor);
	const [isVisible, setIsVisible] = useState<boolean>(true);
	const canInsert = canInsertTable(editor);
	/* Active when the cursor is currently inside a table. */
	const isActive = editor?.isActive("table") || false;

	useEffect(() => {
		if (!editor) return;

		const handleSelectionUpdate = () => {
			setIsVisible(!hideWhenUnavailable || canInsertTable(editor));
		};

		handleSelectionUpdate();
		editor.on("selectionUpdate", handleSelectionUpdate);
		return () => {
			editor.off("selectionUpdate", handleSelectionUpdate);
		};
	}, [editor, hideWhenUnavailable]);

	const handleInsert = useCallback(
		(rows?: number, cols?: number) => {
			if (!editor) return false;
			const success = insertTable(editor, rows, cols);
			if (success) onInserted?.();
			return success;
		},
		[editor, onInserted],
	);

	return {
		isVisible,
		isActive,
		handleInsert,
		canInsert,
		label: "Table",
		Icon: TableIcon,
	};
}
