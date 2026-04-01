"use client"

import { forwardRef, useCallback, useState } from "react"

import { useIsBreakpoint } from "@/hooks/use-is-breakpoint"
import { CornerDownLeftIcon } from "@/components/tiptap-icons/corner-down-left-icon"
import { ImageIcon } from "@/components/tiptap-icons/image-icon"
import type { UseImagePopoverConfig } from "@/components/tiptap-ui/image-popover"
import { useImagePopover } from "@/components/tiptap-ui/image-popover"
import type { ButtonProps } from "@/components/tiptap-ui-primitive/button"
import { Button } from "@/components/tiptap-ui-primitive/button"
import { ButtonGroup } from "@/components/tiptap-ui-primitive/button-group"
import {
  Popover,
  PopoverTrigger,
  ToolbarPopoverContent,
} from "@/components/tiptap-ui-primitive/popover"
import {
  Card,
  CardBody,
  CardItemGroup,
} from "@/components/tiptap-ui-primitive/card"
import { Input } from "@/components/tiptap-ui-primitive/input"

import "./image-popover.scss"

export interface ImagePopoverProps
  extends Omit<ButtonProps, "type">, UseImagePopoverConfig {
  onOpenChange?: (isOpen: boolean) => void
}

/**
 * Trigger button for the image popover.
 */
export const ImageButton = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, children, ...props }, ref) => (
    <Button
      type="button"
      className={className}
      variant="ghost"
      role="button"
      tabIndex={-1}
      aria-label="Image"
      tooltip="Image"
      ref={ref}
      {...props}
    >
      {children || <ImageIcon className="tiptap-button-icon" />}
    </Button>
  )
)

ImageButton.displayName = "ImageButton"

/**
 * Inner popover content: URL + alt text inputs with an apply button.
 */
function ImageMain({
  url,
  setUrl,
  alt,
  setAlt,
  insertImage,
}: {
  url: string
  setUrl: (v: string) => void
  alt: string
  setAlt: (v: string) => void
  insertImage: () => void
}) {
  const isMobile = useIsBreakpoint()

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      insertImage()
    }
  }

  return (
    <Card
      style={{ ...(isMobile ? { boxShadow: "none", border: 0 } : {}) }}
    >
      <CardBody
        style={{ ...(isMobile ? { padding: 0 } : {}) }}
      >
        <CardItemGroup orientation="horizontal">
          <div className="image-popover-fields">
            <Input
              type="url"
              placeholder="Paste image URL..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              data-1p-ignore
              className="tiptap-popover-input"
            />
            <Input
              type="text"
              placeholder="Alt text (optional)"
              value={alt}
              onChange={(e) => setAlt(e.target.value)}
              onKeyDown={handleKeyDown}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              data-1p-ignore
              className="tiptap-popover-input"
            />
          </div>

          <ButtonGroup>
            <Button
              type="button"
              onClick={insertImage}
              title="Insert image"
              disabled={!url}
              variant="ghost"
            >
              <CornerDownLeftIcon className="tiptap-button-icon" />
            </Button>
          </ButtonGroup>
        </CardItemGroup>
      </CardBody>
    </Card>
  )
}

/**
 * Image popover for Tiptap editors.
 *
 * URL + alt text input in a popover, matching the LinkPopover UX pattern.
 * No file upload — URL-only.
 */
export const ImagePopover = forwardRef<HTMLButtonElement, ImagePopoverProps>(
  (
    {
      editor: providedEditor,
      hideWhenUnavailable = false,
      onInserted,
      onOpenChange,
      onClick,
      children,
      ...buttonProps
    },
    ref
  ) => {
    const [isOpen, setIsOpen] = useState(false)

    const {
      isVisible,
      canInsert,
      isActive,
      url,
      setUrl,
      alt,
      setAlt,
      insertImage,
      label,
      Icon,
    } = useImagePopover({ editor: providedEditor, hideWhenUnavailable, onInserted })

    const handleOnOpenChange = useCallback(
      (nextIsOpen: boolean) => {
        setIsOpen(nextIsOpen)
        onOpenChange?.(nextIsOpen)
      },
      [onOpenChange]
    )

    const handleInsert = useCallback(() => {
      insertImage()
      setIsOpen(false)
    }, [insertImage])

    const handleClick = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        setIsOpen(!isOpen)
      },
      [onClick, isOpen]
    )

    if (!isVisible) return null

    return (
      <Popover open={isOpen} onOpenChange={handleOnOpenChange}>
        <PopoverTrigger asChild>
          <ImageButton
            disabled={!canInsert}
            data-active-state={isActive ? "on" : "off"}
            data-disabled={!canInsert}
            aria-label={label}
            onClick={handleClick}
            {...buttonProps}
            ref={ref}
          >
            {children ?? <Icon className="tiptap-button-icon" />}
          </ImageButton>
        </PopoverTrigger>

        <ToolbarPopoverContent>
          <ImageMain
            url={url}
            setUrl={setUrl}
            alt={alt}
            setAlt={setAlt}
            insertImage={handleInsert}
          />
        </ToolbarPopoverContent>
      </Popover>
    )
  }
)

ImagePopover.displayName = "ImagePopover"

export default ImagePopover
