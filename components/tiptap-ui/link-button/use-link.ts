"use client"

import { useCallback, useEffect, useState } from "react"
import type { Editor } from "@tiptap/react"

import { useTiptapEditor } from "@/hooks/use-tiptap-editor"
import { isMarkInSchema } from "@/lib/tiptap-utils"
import { LinkIcon } from "@/components/tiptap-icons/link-icon"

export const LINK_SHORTCUT_KEY = "mod+k"

/**
 * Configuration for the link button hook.
 */
export interface UseLinkConfig {
  editor?: Editor | null
  hideWhenUnavailable?: boolean
  onToggled?: () => void
}

/**
 * Checks whether a link can be set on the current selection.
 */
export function canToggleLink(editor: Editor | null): boolean {
  if (!editor || !editor.isEditable) return false
  return isMarkInSchema("link", editor)
}

/**
 * Toggles a link on the current selection. If a link is active it removes it;
 * otherwise it prompts for a URL via `window.prompt` and sets the link.
 */
export function toggleLink(editor: Editor | null): boolean {
  if (!editor || !editor.isEditable) return false
  if (!canToggleLink(editor)) return false

  /* If the cursor is already on a link, unset it. */
  if (editor.isActive("link")) {
    return editor.chain().focus().unsetLink().run()
  }

  /* Prompt for a URL. Cancel → no-op. */
  const url = window.prompt("Enter URL:")
  if (!url) return false

  return editor
    .chain()
    .focus()
    .setLink({ href: url, target: '_blank' })
    .run()
}

/**
 * Hook providing link toggle state and action for toolbar buttons.
 *
 * When the cursor is inside a link, the button shows as active and clicking
 * removes the link. When no link is present, clicking prompts for a URL and
 * wraps the selection.
 */
export function useLink(config?: UseLinkConfig) {
  const {
    editor: providedEditor,
    hideWhenUnavailable = false,
    onToggled,
  } = config || {}

  const { editor } = useTiptapEditor(providedEditor)
  const [isVisible, setIsVisible] = useState<boolean>(true)
  const canToggle = canToggleLink(editor)
  const isActive = editor?.isActive("link") || false

  useEffect(() => {
    if (!editor) return

    const handleSelectionUpdate = () => {
      setIsVisible(!hideWhenUnavailable || canToggleLink(editor))
    }

    handleSelectionUpdate()
    editor.on("selectionUpdate", handleSelectionUpdate)
    return () => { editor.off("selectionUpdate", handleSelectionUpdate) }
  }, [editor, hideWhenUnavailable])

  const handleToggle = useCallback(() => {
    if (!editor) return false
    const success = toggleLink(editor)
    if (success) onToggled?.()
    return success
  }, [editor, onToggled])

  return {
    isVisible,
    isActive,
    handleToggle,
    canToggle,
    label: "Link",
    shortcutKeys: LINK_SHORTCUT_KEY,
    Icon: LinkIcon,
  }
}
