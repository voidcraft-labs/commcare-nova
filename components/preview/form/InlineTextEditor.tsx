/**
 * WYSIWYG inline text editor for text cursor mode.
 *
 * Replaces static LabelContent in-place when the user clicks a text surface
 * in text mode. CommCare Web Apps markdown rendering — headings, bold, italic,
 * links, images, lists, code (inline + block), horizontal rules, and GFM
 * tables — via tiptap-markdown. Uses the TipTap composable API (`<Tiptap>`
 * provider + `<Tiptap.Content>`). Blockquote and strikethrough are disabled
 * because CommCare Web Apps has no visible styling for either.
 *
 * Two toolbar variants:
 *
 * **Labels** — Always-visible floating toolbar anchored above the editor via
 * React portal + manual positioning. CommCare Web Apps markdown feature set
 * via official TipTap UI components: MarkButton (bold, italic, code),
 * HeadingDropdownMenu, ListDropdownMenu, LinkPopover, ImagePopover,
 * CodeBlockButton, HorizontalRuleButton, and TableButton
 * (dropdown with visual grid picker for selecting dimensions). Portal-mounted
 * to body so overflow-hidden ancestors can't clip it.
 *
 * **Hints** — BubbleMenu with default shouldShow (text selection only).
 * Bold and italic MarkButton only.
 *
 * Save: blur, Cmd/Ctrl+Enter. Cancel: Escape reverts to original value.
 * Tab/Shift+Tab: save current, activate next/previous TextEditable in DOM
 * order.
 */

"use client";
import { type Editor, Extension } from "@tiptap/core";
import { Tiptap, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { ToolbarSaveHint } from "@/components/builder/SaveShortcutHint";
import { CodeBlockButton } from "@/components/tiptap-ui/code-block-button";
import { HeadingDropdownMenu } from "@/components/tiptap-ui/heading-dropdown-menu";
import { HorizontalRuleButton } from "@/components/tiptap-ui/horizontal-rule-button";
import { ImagePopover } from "@/components/tiptap-ui/image-popover";
import { LinkPopover } from "@/components/tiptap-ui/link-popover";
import { ListDropdownMenu } from "@/components/tiptap-ui/list-dropdown-menu";
import { MarkButton } from "@/components/tiptap-ui/mark-button";
import { TableButton } from "@/components/tiptap-ui/table-button";
import {
	Toolbar,
	ToolbarGroup,
	ToolbarSeparator,
} from "@/components/tiptap-ui-primitive/toolbar";
import { useReferenceProvider } from "@/lib/references/ReferenceContext";
import { hydrateHashtagRefs } from "@/lib/tiptap/hydrateRefs";
import {
	createInlineEditorExtensions,
	getMarkdownContent,
} from "@/lib/tiptap/markdownExtensions";

type FieldType = "label" | "hint";

interface InlineTextEditorProps {
	/** Current markdown value for this field. */
	value: string;
	/** Called with the new markdown value when the editor saves (blur/Cmd+Enter). */
	onSave: (value: string) => void;
	/** Called when the user cancels editing (Escape). Reverts to original value. */
	onCancel: () => void;
	/** Which text surface this editor replaces — drives styling to match. */
	fieldType: FieldType;
	/** Whether to auto-focus the editor on mount. */
	autoFocus?: boolean;
	/** Viewport coordinates of the click that activated this editor. When
	 *  provided, the cursor is placed at the corresponding text position
	 *  instead of jumping to the end of the field. */
	clickPosition?: { x: number; y: number } | null;
}

/** Style classes per field type so the editor matches the static LabelContent it replaces. */
const FIELD_STYLES: Record<FieldType, string> = {
	label: "text-sm font-medium text-nova-text",
	hint: "text-xs text-nova-text-muted",
};

// ── Label toolbar (full StarterKit formatting via TipTap UI) ─────────

/**
 * Full formatting toolbar for label fields. Always visible, portal-mounted
 * to document.body and positioned above the editor anchor via manual rect
 * tracking. React portal preserves the `<Tiptap>` context so all TipTap UI
 * components (MarkButton, HeadingDropdownMenu, etc.) access the editor
 * through `useCurrentEditor()` as intended.
 *
 * Uses `onMouseDown` with `preventDefault` on the toolbar wrapper to prevent
 * clicks on toolbar buttons from stealing focus from the ProseMirror editor
 * (which would trigger the blur → save flow). The TipTap UI components use
 * `onClick` internally, which still fires after the prevented `mouseDown`.
 */
function LabelToolbar({
	anchorRef,
}: {
	anchorRef: React.RefObject<HTMLDivElement | null>;
}) {
	const portalRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const anchor = anchorRef.current;
		const portal = portalRef.current;
		if (!anchor || !portal) return;

		/** Reposition the toolbar via direct DOM mutation — no React re-render.
		 * Fires on every scroll (capture) and resize, so it must be cheap.
		 *
		 * Three regimes as the editor scrolls up:
		 * 1. **Free** — toolbar floats above the anchor with a 6px gap (default).
		 * 2. **Clamped** — toolbar would escape above the cursor-mode overlay,
		 *    so it pins to the overlay's bottom edge and the gap compresses.
		 * 3. **Hidden** — anchor itself has scrolled under the pinned toolbar
		 *    (gap compressed to zero), so the toolbar disappears. */
		const GAP = 6;

		const update = () => {
			const rect = anchor.getBoundingClientRect();
			const container = anchor.closest(
				"[data-preview-scroll-container]",
			) as HTMLElement | null;
			const containerRect = container?.getBoundingClientRect();

			/* The scroll container may have top padding (topInset) to push content
			 * below the glassmorphic cursor-mode toolbar overlay. The visible
			 * content region starts at containerTop + paddingTop, not containerTop. */
			const paddingTop = container
				? Number.parseFloat(getComputedStyle(container).paddingTop) || 0
				: 0;
			const visibleTop = containerRect ? containerRect.top + paddingTop : 0;
			const visibleBottom = containerRect
				? containerRect.bottom
				: window.innerHeight;

			const toolbarHeight = portal.offsetHeight;

			/* Ideal top edge: above anchor with a 6px gap. */
			const idealTop = rect.top - toolbarHeight - GAP;
			/* Clamped: toolbar pins just below the subheader instead of escaping
			 * above it. The floor is 10px below the subheader so the push-down
			 * engages slightly before the toolbar would hit the actual edge,
			 * making the transition feel smooth rather than abrupt. */
			const clampFloor = visibleTop + 20;
			const clampedTop = Math.max(clampFloor, idealTop);

			/* Hide when the anchor has fully scrolled above the visible region,
			 * when the toolbar's bottom would overlap the anchor's bottom edge
			 * (editor scrolled down past the toolbar), or below the container. */
			const toolbarBottom = clampedTop + toolbarHeight;
			const hidden =
				rect.bottom < visibleTop ||
				toolbarBottom >= rect.bottom ||
				rect.top > visibleBottom;

			portal.style.position = "fixed";
			portal.style.left = `${rect.left}px`;
			portal.style.top = `${clampedTop}px`;
			portal.style.transform = "none";
			portal.style.visibility = hidden ? "hidden" : "visible";
		};

		update();

		/* Capture-phase scroll listener catches scrolling on any ancestor. */
		window.addEventListener("scroll", update, true);
		window.addEventListener("resize", update);
		return () => {
			window.removeEventListener("scroll", update, true);
			window.removeEventListener("resize", update);
		};
	}, [anchorRef]);

	return createPortal(
		<div
			ref={portalRef}
			role="toolbar"
			aria-label="Text formatting"
			style={{ visibility: "hidden", zIndex: "var(--z-popover-top)" }}
			data-no-drag
			data-inline-toolbar
			onMouseDown={(e) => e.preventDefault()}
		>
			<Toolbar variant="floating">
				<ToolbarGroup>
					<MarkButton type="bold" />
					<MarkButton type="italic" />
					<MarkButton type="code" />
				</ToolbarGroup>
				<ToolbarSeparator />
				<ToolbarGroup>
					<HeadingDropdownMenu levels={[1, 2, 3]} modal={false} />
					<ListDropdownMenu
						types={["bulletList", "orderedList"]}
						modal={false}
					/>
				</ToolbarGroup>
				<ToolbarSeparator />
				<ToolbarGroup>
					<LinkPopover />
					<ImagePopover />
				</ToolbarGroup>
				<ToolbarSeparator />
				<ToolbarGroup>
					<CodeBlockButton />
					<HorizontalRuleButton />
					<TableButton />
				</ToolbarGroup>
				<ToolbarSeparator />
				<ToolbarSaveHint />
			</Toolbar>
		</div>,
		document.body,
	);
}

// ── Hint toolbar (minimal formatting) ────────────────────────────────

/**
 * Minimal BubbleMenu for hint fields. Default shouldShow — appears
 * on text selection only. Bold and italic only.
 */
function CompactToolbar() {
	return (
		<BubbleMenu>
			<Toolbar variant="floating" data-no-drag>
				<ToolbarGroup>
					<MarkButton type="bold" />
					<MarkButton type="italic" />
				</ToolbarGroup>
			</Toolbar>
		</BubbleMenu>
	);
}

// ── Main editor ──────────────────────────────────────────────────────

export function InlineTextEditor({
	value,
	onSave,
	onCancel,
	fieldType,
	autoFocus,
	clickPosition,
}: InlineTextEditorProps) {
	const provider = useReferenceProvider();
	const savedRef = useRef(false);
	const anchorRef = useRef<HTMLDivElement>(null);

	/** Save the current editor content as markdown. Guards against double-fire. */
	const saveAndDeactivate = useCallback(
		(editor: Editor | null) => {
			if (savedRef.current || !editor) return;
			savedRef.current = true;
			const md = getMarkdownContent(editor);
			onSave(md.trim());
		},
		[onSave],
	);

	/** Cancel editing — revert to the original value without saving. */
	const cancelAndDeactivate = useCallback(() => {
		if (savedRef.current) return;
		savedRef.current = true;
		onCancel();
	}, [onCancel]);

	const saveRef = useRef(saveAndDeactivate);
	saveRef.current = saveAndDeactivate;
	const cancelRef = useRef(cancelAndDeactivate);
	cancelRef.current = cancelAndDeactivate;

	/**
	 * TipTap keyboard extension for Tab/Shift+Tab navigation between
	 * TextEditable instances. On Tab: save current editor, find next
	 * [data-text-editable] in DOM order, click it to activate. On Escape:
	 * save and deactivate.
	 */
	const keyboardExtension = useMemo(
		() =>
			Extension.create({
				name: "inlineTextEditorKeyboard",
				addKeyboardShortcuts() {
					return {
						Tab: ({ editor }) => {
							saveRef.current(editor);
							requestAnimationFrame(() => activateAdjacentEditable("next"));
							return true;
						},
						"Shift-Tab": ({ editor }) => {
							saveRef.current(editor);
							requestAnimationFrame(() => activateAdjacentEditable("prev"));
							return true;
						},
						"Mod-Enter": ({ editor }) => {
							saveRef.current(editor);
							editor.commands.blur();
							return true;
						},
						Escape: ({ editor }) => {
							cancelRef.current();
							editor.commands.blur();
							return true;
						},
					};
				},
			}),
		[],
	);

	const extensions = useMemo(
		() => [...createInlineEditorExtensions(provider), keyboardExtension],
		[provider, keyboardExtension],
	);

	const editor = useEditor({
		extensions,
		/* Content is set via setContent() below — not here — because TipTap 3's
		 * `immediatelyRender: false` creates the editor in an effect, and the
		 * Markdown extension's `onBeforeCreate` hook (which intercepts `content`
		 * and parses markdown → HTML) can miss the initial content depending on
		 * extension initialization order. Using the overridden `setContent` command
		 * guarantees the Markdown extension parses the string. */
		content: "",
		immediatelyRender: false,
		editorProps: {
			attributes: {
				/* Font styles and preview-markdown are on ancestor wrapper divs
				 * (matching the static LabelContent nesting), so the editor element
				 * only needs outline suppression. Typography inherits from the
				 * wrappers, and ProseMirror's injected white-space/position are
				 * matched by the [data-text-editable] .preview-markdown rule. */
				class: "outline-none",
				"data-1p-ignore": "",
				autocomplete: "off",
			},
		},
		onBlur: ({ editor: e }) => {
			/* Delay save to let the browser update activeElement. If focus moved to
			 * our toolbar portal or its dropdown (both outside the ProseMirror DOM
			 * tree), the blur is transient — don't save. Only save when focus has
			 * genuinely left the editing context. The toolbar wrapper and the Radix
			 * dropdown content are both tagged with [data-inline-toolbar]. */
			requestAnimationFrame(() => {
				if (!document.activeElement?.closest("[data-inline-toolbar]")) {
					saveRef.current(e);
				}
			});
		},
	});

	/* Load markdown content and hydrate hashtag references into chip nodes.
	 * Labels use bare `#type/path` hashtags internally. tiptap-markdown parses
	 * the markdown (hashtags pass through as plain text), then hydrateHashtagRefs
	 * walks the resulting ProseMirror document to promote hashtag text into
	 * commcareRef atom nodes. When activated by a user click, posAtCoords maps
	 * the original viewport coordinates to a document position so the cursor
	 * lands where the user clicked rather than jumping to the end. */
	useEffect(() => {
		if (!editor) return;
		editor.commands.setContent(value);
		hydrateHashtagRefs(editor);
		if (autoFocus) {
			if (clickPosition) {
				const pos = editor.view.posAtCoords({
					left: clickPosition.x,
					top: clickPosition.y,
				});
				if (pos) {
					editor.commands.focus(pos.pos);
					return;
				}
			}
			editor.commands.focus("end");
		}
	}, [editor, value, autoFocus, clickPosition]);

	if (!editor) return null;

	return (
		<Tiptap editor={editor}>
			<div ref={anchorRef} className="relative" data-no-drag>
				{fieldType === "label" ? (
					<LabelToolbar anchorRef={anchorRef} />
				) : (
					<CompactToolbar />
				)}
				{/* Wrapper nesting mirrors the static LabelContent structure (font-style
				 * div → preview-markdown div → content) so the CSS cascade produces
				 * identical computed values in both states — true flipbook parity. */}
				<div className={FIELD_STYLES[fieldType]}>
					<div className="preview-markdown">
						<Tiptap.Content />
					</div>
				</div>
			</div>
		</Tiptap>
	);
}

/**
 * Find and click the next or previous [data-text-editable] element
 * in DOM order to activate its InlineTextEditor.
 */
function activateAdjacentEditable(direction: "next" | "prev") {
	const all = Array.from(
		document.querySelectorAll<HTMLElement>("[data-text-editable]"),
	);
	/* Find the currently active editable — the one whose InlineTextEditor just saved. */
	const active =
		(document.activeElement?.closest(
			"[data-text-editable]",
		) as HTMLElement | null) ??
		all.find((el) => el.querySelector(".ProseMirror"));
	if (!active) return;

	const idx = all.indexOf(active);
	if (idx === -1) return;

	const targetIdx =
		direction === "next"
			? (idx + 1) % all.length
			: (idx - 1 + all.length) % all.length;
	all[targetIdx]?.click();
}
