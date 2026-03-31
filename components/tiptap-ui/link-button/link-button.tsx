"use client"

import { forwardRef, useCallback } from "react"

import type { UseLinkConfig } from "@/components/tiptap-ui/link-button"
import { LINK_SHORTCUT_KEY, useLink } from "@/components/tiptap-ui/link-button"
import { useTiptapEditor } from "@/hooks/use-tiptap-editor"
import { parseShortcutKeys } from "@/lib/tiptap-utils"
import type { ButtonProps } from "@/components/tiptap-ui-primitive/button"
import { Button } from "@/components/tiptap-ui-primitive/button"
import { Badge } from "@/components/tiptap-ui-primitive/badge"

export interface LinkButtonProps
  extends Omit<ButtonProps, "type">, UseLinkConfig {
  text?: string
  showShortcut?: boolean
}

export function LinkShortcutBadge({
  shortcutKeys = LINK_SHORTCUT_KEY,
}: {
  shortcutKeys?: string
}) {
  return <Badge>{parseShortcutKeys({ shortcutKeys })}</Badge>
}

/**
 * Toolbar button for toggling links. When clicked on an existing link it
 * removes it; otherwise it prompts for a URL via `window.prompt`.
 */
export const LinkButton = forwardRef<HTMLButtonElement, LinkButtonProps>(
  (
    {
      editor: providedEditor,
      text,
      hideWhenUnavailable = false,
      onToggled,
      showShortcut = false,
      onClick,
      children,
      ...buttonProps
    },
    ref
  ) => {
    const { editor } = useTiptapEditor(providedEditor)
    const {
      isVisible,
      canToggle,
      isActive,
      handleToggle,
      label,
      shortcutKeys,
      Icon,
    } = useLink({ editor, hideWhenUnavailable, onToggled })

    const handleClick = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        handleToggle()
      },
      [handleToggle, onClick]
    )

    if (!isVisible) return null

    return (
      <Button
        type="button"
        variant="ghost"
        data-active-state={isActive ? "on" : "off"}
        role="button"
        tabIndex={-1}
        disabled={!canToggle}
        data-disabled={!canToggle}
        aria-label={label}
        aria-pressed={isActive}
        tooltip="Link"
        shortcutKeys={shortcutKeys}
        onClick={handleClick}
        {...buttonProps}
        ref={ref}
      >
        {children ?? (
          <>
            <Icon className="tiptap-button-icon" />
            {text && <span className="tiptap-button-text">{text}</span>}
            {showShortcut && (
              <LinkShortcutBadge shortcutKeys={shortcutKeys} />
            )}
          </>
        )}
      </Button>
    )
  }
)

LinkButton.displayName = "LinkButton"
