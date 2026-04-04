"use client";

import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useState } from "react";
import { ImageIcon } from "@/components/tiptap-icons/image-icon";
import { useTiptapEditor } from "@/hooks/use-tiptap-editor";
import { isNodeInSchema } from "@/lib/tiptap-utils";

export interface UseImagePopoverConfig {
	editor?: Editor | null;
	hideWhenUnavailable?: boolean;
	onInserted?: () => void;
}

/**
 * Requires the image node extension to be registered in the editor schema.
 */
export function canInsertImage(editor: Editor | null): boolean {
	if (!editor || !editor.isEditable) return false;
	return isNodeInSchema("image", editor);
}

/**
 * True when the cursor or selection is positioned on an image node.
 */
export function isImageActive(editor: Editor | null): boolean {
	if (!editor || !editor.isEditable) return false;
	return editor.isActive("image");
}

/**
 * Unified hook for the image popover — visibility, active state, field values,
 * and insertion logic. Uses a single `selectionUpdate` listener to keep all
 * derived state in sync (avoiding the stale-snapshot problem where values
 * computed during render go stale between re-renders).
 */
export function useImagePopover(config?: UseImagePopoverConfig) {
	const {
		editor: providedEditor,
		hideWhenUnavailable = false,
		onInserted,
	} = config || {};

	const { editor } = useTiptapEditor(providedEditor);

	const [isVisible, setIsVisible] = useState(true);
	const [canInsert, setCanInsert] = useState(false);
	const [isActive, setIsActive] = useState(false);
	const [url, setUrl] = useState("");
	const [alt, setAlt] = useState("");

	/** Single listener that derives all selection-dependent state in one pass. */
	useEffect(() => {
		if (!editor) return;

		const sync = () => {
			const can = canInsertImage(editor);
			const active = isImageActive(editor);

			setCanInsert(can);
			setIsActive(active);
			setIsVisible(!hideWhenUnavailable || can);

			/* Populate fields when the cursor lands on an existing image;
			 * clear them when it moves away — but only if the user hasn't
			 * started typing a new URL (url would be non-empty from input). */
			if (active) {
				const attrs = editor.getAttributes("image");
				setUrl(attrs.src || "");
				setAlt(attrs.alt || "");
			}
		};

		sync();
		editor.on("selectionUpdate", sync);
		return () => {
			editor.off("selectionUpdate", sync);
		};
	}, [editor, hideWhenUnavailable]);

	const insertImage = useCallback(() => {
		if (!url || !editor) return;

		editor.chain().focus().setImage({ src: url, alt }).run();
		setUrl("");
		setAlt("");
		onInserted?.();
	}, [editor, url, alt, onInserted]);

	return {
		isVisible,
		canInsert,
		isActive,
		url,
		setUrl,
		alt,
		setAlt,
		insertImage,
		label: "Image",
		Icon: ImageIcon,
	};
}
