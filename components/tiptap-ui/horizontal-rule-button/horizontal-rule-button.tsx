"use client";

import { forwardRef, useCallback } from "react";

import type { UseHorizontalRuleConfig } from "@/components/tiptap-ui/horizontal-rule-button";
import { useHorizontalRule } from "@/components/tiptap-ui/horizontal-rule-button";
import type { ButtonProps } from "@/components/tiptap-ui-primitive/button";
import { Button } from "@/components/tiptap-ui-primitive/button";
import { useTiptapEditor } from "@/hooks/use-tiptap-editor";

export interface HorizontalRuleButtonProps
	extends Omit<ButtonProps, "type">,
		UseHorizontalRuleConfig {
	text?: string;
}

/**
 * Toolbar button for inserting a horizontal rule (`---`).
 */
export const HorizontalRuleButton = forwardRef<
	HTMLButtonElement,
	HorizontalRuleButtonProps
>(
	(
		{
			editor: providedEditor,
			text,
			hideWhenUnavailable = false,
			onInserted,
			onClick,
			children,
			...buttonProps
		},
		ref,
	) => {
		const { editor } = useTiptapEditor(providedEditor);
		const { isVisible, canInsert, handleInsert, label, Icon } =
			useHorizontalRule({ editor, hideWhenUnavailable, onInserted });

		const handleClick = useCallback(
			(event: React.MouseEvent<HTMLButtonElement>) => {
				onClick?.(event);
				if (event.defaultPrevented) return;
				handleInsert();
			},
			[handleInsert, onClick],
		);

		if (!isVisible) return null;

		return (
			<Button
				type="button"
				variant="ghost"
				data-active-state="off"
				role="button"
				tabIndex={-1}
				disabled={!canInsert}
				data-disabled={!canInsert}
				aria-label={label}
				tooltip="Horizontal Rule"
				onClick={handleClick}
				{...buttonProps}
				ref={ref}
			>
				{children ?? (
					<>
						<Icon className="tiptap-button-icon" />
						{text && <span className="tiptap-button-text">{text}</span>}
					</>
				)}
			</Button>
		);
	},
);

HorizontalRuleButton.displayName = "HorizontalRuleButton";
