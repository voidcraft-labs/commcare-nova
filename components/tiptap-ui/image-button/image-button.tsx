"use client"

import { forwardRef, useCallback } from "react"

import type { UseImageConfig } from "@/components/tiptap-ui/image-button"
import { useImage } from "@/components/tiptap-ui/image-button"
import { useTiptapEditor } from "@/hooks/use-tiptap-editor"
import type { ButtonProps } from "@/components/tiptap-ui-primitive/button"
import { Button } from "@/components/tiptap-ui-primitive/button"

export interface ImageButtonProps
  extends Omit<ButtonProps, "type">, UseImageConfig {
  text?: string
}

/**
 * Toolbar button for inserting images. Prompts for URL and alt text
 * via `window.prompt`, then inserts an inline `![alt](url)` image.
 */
export const ImageButton = forwardRef<HTMLButtonElement, ImageButtonProps>(
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
    ref
  ) => {
    const { editor } = useTiptapEditor(providedEditor)
    const {
      isVisible,
      canInsert,
      handleInsert,
      label,
      Icon,
    } = useImage({ editor, hideWhenUnavailable, onInserted })

    const handleClick = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        handleInsert()
      },
      [handleInsert, onClick]
    )

    if (!isVisible) return null

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
        tooltip="Image"
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
    )
  }
)

ImageButton.displayName = "ImageButton"
