"use client"

import { useCallback, useEffect, useState } from "react"
import type { Editor } from "@tiptap/react"

import { useTiptapEditor } from "@/hooks/use-tiptap-editor"
import { isNodeInSchema } from "@/lib/tiptap-utils"
import { ImageIcon } from "@/components/tiptap-icons/image-icon"

/**
 * Configuration for the image button hook.
 */
export interface UseImageConfig {
  editor?: Editor | null
  hideWhenUnavailable?: boolean
  onInserted?: () => void
}

/**
 * Checks whether an image can be inserted in the current editor state.
 */
export function canInsertImage(editor: Editor | null): boolean {
  if (!editor || !editor.isEditable) return false
  return isNodeInSchema("image", editor)
}

/**
 * Inserts an image by prompting for a URL via `window.prompt`.
 */
export function insertImage(editor: Editor | null): boolean {
  if (!editor || !editor.isEditable) return false
  if (!canInsertImage(editor)) return false

  const url = window.prompt("Enter image URL:")
  if (!url) return false

  const alt = window.prompt("Enter alt text (optional):") || ""

  return editor
    .chain()
    .focus()
    .setImage({ src: url, alt })
    .run()
}

/**
 * Hook providing image insertion state and action for toolbar buttons.
 */
export function useImage(config?: UseImageConfig) {
  const {
    editor: providedEditor,
    hideWhenUnavailable = false,
    onInserted,
  } = config || {}

  const { editor } = useTiptapEditor(providedEditor)
  const [isVisible, setIsVisible] = useState<boolean>(true)
  const canInsert = canInsertImage(editor)

  useEffect(() => {
    if (!editor) return

    const handleSelectionUpdate = () => {
      setIsVisible(!hideWhenUnavailable || canInsertImage(editor))
    }

    handleSelectionUpdate()
    editor.on("selectionUpdate", handleSelectionUpdate)
    return () => { editor.off("selectionUpdate", handleSelectionUpdate) }
  }, [editor, hideWhenUnavailable])

  const handleInsert = useCallback(() => {
    if (!editor) return false
    const success = insertImage(editor)
    if (success) onInserted?.()
    return success
  }, [editor, onInserted])

  return {
    isVisible,
    isActive: false,
    handleInsert,
    canInsert,
    label: "Image",
    Icon: ImageIcon,
  }
}
