/**
 * WYSIWYG inline text editor for text cursor mode.
 *
 * Replaces static LabelContent in-place when the user clicks a text surface
 * in text mode. CommCare Web Apps markdown rendering: headings, bold, italic,
 * links, images, lists, code (inline + block), horizontal rules, and GFM
 * tables: via tiptap-markdown. Uses the TipTap composable API (`<Tiptap>`
 * provider + `<Tiptap.Content>`). Blockquote and strikethrough are disabled
 * because CommCare Web Apps has no visible styling for either.
 *
 * Two toolbar variants:
 *
 * **Labels**: Always-visible floating toolbar anchored above the editor via
 * React portal + manual positioning. CommCare Web Apps markdown feature set
 * via official TipTap UI components: MarkButton (bold, italic, code),
 * HeadingDropdownMenu, ListDropdownMenu, LinkPopover, ImagePopover,
 * CodeBlockButton, HorizontalRuleButton, and TableButton
 * (dropdown with visual grid picker for selecting dimensions). Portal-mounted
 * to body so overflow-hidden ancestors can't clip it.
 *
 * **Hints**: A compact always-visible toolbar with bold, italic and reference
 * insertion. Both variants share the same reference picker.
 *
 * **Format text** (labels only): the label toolbar opens with a toggle for
 * the label's `plainLabel`. Off, the editor holds the stored characters as
 * plain lines with reference chips and no Markdown reading in either
 * direction, so `**bold**` shows as typed; the formatting buttons stand
 * disabled and the reference picker still works. The editor follows the
 * stored setting, so a toggle, an undo or a peer's edit swaps it in place and
 * carries the draft across. Turning formatting off on a label that uses it
 * asks first, under the editor.
 *
 * Save: blur, Cmd/Ctrl+Enter. Cancel: Escape reverts to original value.
 * Tab/Shift+Tab: save current, activate next/previous TextEditable in DOM
 * order.
 */

"use client";
import tablerTypography from "@iconify-icons/tabler/typography";
import { type Editor, Extension } from "@tiptap/core";
import { Tiptap, useEditor } from "@tiptap/react";

import {
	type ComponentType,
	Fragment,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { ProseReferencePicker } from "@/components/builder/ProseReferencePicker";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { ToolbarSaveHint } from "@/components/builder/SaveShortcutHint";
import { Button } from "@/components/shadcn/button";
import { BoldIcon } from "@/components/tiptap-icons/bold-icon";
import { CodeBlockIcon } from "@/components/tiptap-icons/code-block-icon";
import { Code2Icon } from "@/components/tiptap-icons/code2-icon";
import { HeadingIcon } from "@/components/tiptap-icons/heading-icon";
import { HorizontalRuleIcon } from "@/components/tiptap-icons/horizontal-rule-icon";
import { ImageIcon } from "@/components/tiptap-icons/image-icon";
import { ItalicIcon } from "@/components/tiptap-icons/italic-icon";
import { LinkIcon } from "@/components/tiptap-icons/link-icon";
import { ListIcon } from "@/components/tiptap-icons/list-icon";
import {
	TiptapIcon,
	type TiptapIconProps,
} from "@/components/tiptap-icons/TiptapSvg";
import { TableIcon } from "@/components/tiptap-icons/table-icon";
import { CodeBlockButton } from "@/components/tiptap-ui/code-block-button";
import { HeadingDropdownMenu } from "@/components/tiptap-ui/heading-dropdown-menu";
import { HorizontalRuleButton } from "@/components/tiptap-ui/horizontal-rule-button";
import { ImagePopover } from "@/components/tiptap-ui/image-popover";
import { LinkPopover } from "@/components/tiptap-ui/link-popover";
import { ListDropdownMenu } from "@/components/tiptap-ui/list-dropdown-menu";
import { MarkButton } from "@/components/tiptap-ui/mark-button";
import { TableButton } from "@/components/tiptap-ui/table-button";
import { Button as ToolbarButton } from "@/components/tiptap-ui-primitive/button";
import {
	Toolbar,
	ToolbarGroup,
	ToolbarSeparator,
} from "@/components/tiptap-ui-primitive/toolbar";
import { useDeclaredPlatforms } from "@/lib/doc/hooks/useDeclaredPlatforms";
import type { CommitOutcome, ProseTemplate } from "@/lib/domain";
import {
	useLiveFormUuidGetter,
	useReferenceProvider,
} from "@/lib/references/ReferenceContext";
import { POPOVER_GLASS } from "@/lib/styles";
import {
	createPlainLabelEditorExtensions,
	plainLabelEditorContent,
	plainLabelEditorTemplate,
	proseTemplateHoldsFormatting,
} from "@/lib/tiptap/formatText";
import {
	createInlineEditorExtensions,
	getMarkdownContent,
	markdownToProseTemplate,
	proseTemplateToMarkdown,
} from "@/lib/tiptap/markdownExtensions";
import {
	dismissProseSuggestion,
	proseEditorId,
	prosePickerIsOpen,
} from "@/lib/tiptap/proseReferenceEditing";
import { FIELD_STYLES, type FieldType } from "./fieldStyles";
import {
	FORMAT_TEXT_CONFIRM,
	FORMAT_TEXT_CONFIRM_KEEP,
	FORMAT_TEXT_CONFIRM_OFF,
	FORMAT_TEXT_FOLLOWS_SOURCE,
	FORMAT_TEXT_NAME,
	FORMAT_TEXT_UNAVAILABLE,
	formatTextGesture,
	formatTextOffLine,
} from "./formatText";
import type { FormatTextControl } from "./useLabelFormatText";

interface InlineTextEditorProps {
	/** Current structural prose value for this field. */
	value: ProseTemplate;
	/** Called with the new markdown value when the editor saves (blur/Cmd+Enter). */
	onSave: (value: ProseTemplate) => CommitOutcome | undefined;
	/** Called when the user cancels editing (Escape). Reverts to original value. */
	onCancel: () => void;
	/** Which text surface this editor replaces: drives styling to match. */
	fieldType: FieldType;
	/** Whether to auto-focus the editor on mount. */
	autoFocus?: boolean;
	/** Viewport coordinates of the click that activated this editor. When
	 *  provided, the cursor is placed at the corresponding text position
	 *  instead of jumping to the end of the field. */
	clickPosition?: { x: number; y: number } | null;
	/** A label's Format text toggle. Absent for hints, which keep their
	 *  formatting. */
	formatText?: FormatTextControl;
}

/** The label toolbar's formatting buttons, as they stand while Format text
 *  is off: the same buttons, disabled, saying how to reach them. */
const UNAVAILABLE_FORMATTING: ReadonlyArray<
	readonly { label: string; Icon: ComponentType<TiptapIconProps> }[]
> = [
	[
		{ label: "Bold", Icon: BoldIcon },
		{ label: "Italic", Icon: ItalicIcon },
		{ label: "Code", Icon: Code2Icon },
	],
	[
		{ label: "Heading", Icon: HeadingIcon },
		{ label: "List", Icon: ListIcon },
	],
	[
		{ label: "Link", Icon: LinkIcon },
		{ label: "Image", Icon: ImageIcon },
	],
	[
		{ label: "Code block", Icon: CodeBlockIcon },
		{ label: "Horizontal rule", Icon: HorizontalRuleIcon },
		{ label: "Table", Icon: TableIcon },
	],
];

/**
 * The Format text toggle, first in the label toolbar. Pressed means the
 * label is formatted. Under a worker language other than the source it shows
 * the source's state and changes nothing.
 */
function FormatTextToggle({
	formatText,
	onToggle,
}: {
	formatText: FormatTextControl;
	onToggle: () => void;
}) {
	const formatted = !formatText.plain;
	return (
		<ToolbarButton
			type="button"
			variant="ghost"
			data-active-state={formatted ? "on" : "off"}
			data-format-text={formatted ? "on" : "off"}
			aria-label={FORMAT_TEXT_NAME}
			aria-pressed={formatted}
			aria-disabled={formatText.isSource ? undefined : true}
			className={
				formatText.isSource
					? undefined
					: "cursor-not-allowed opacity-(--disabled-opacity)"
			}
			tooltip={
				formatText.isSource ? FORMAT_TEXT_NAME : FORMAT_TEXT_FOLLOWS_SOURCE
			}
			onClick={formatText.isSource ? onToggle : undefined}
		>
			<TiptapIcon icon={tablerTypography} className="tiptap-button-icon" />
		</ToolbarButton>
	);
}

/** The formatting buttons while Format text is off. */
function UnavailableFormattingGroups() {
	return UNAVAILABLE_FORMATTING.map((group) => (
		<Fragment key={group[0].label}>
			<ToolbarGroup>
				{group.map(({ label, Icon }) => (
					<ToolbarButton
						key={label}
						type="button"
						variant="ghost"
						disabled
						data-format-text-unavailable
						className="cursor-not-allowed"
						aria-label={label}
						tooltip={FORMAT_TEXT_UNAVAILABLE}
					>
						<Icon className="tiptap-button-icon" />
					</ToolbarButton>
				))}
			</ToolbarGroup>
			<ToolbarSeparator />
		</Fragment>
	));
}

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
	editor,
	compact = false,
	onLeaveEditor,
	formatText,
	onToggleFormatText,
}: {
	editor: Editor;
	compact?: boolean;
	onLeaveEditor: () => void;
	anchorRef: React.RefObject<HTMLDivElement | null>;
	formatText?: FormatTextControl;
	onToggleFormatText: () => void;
}) {
	const plain = formatText?.plain === true;
	const portalRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const anchor = anchorRef.current;
		const portal = portalRef.current;
		if (!anchor || !portal) return;

		/** Reposition the toolbar via direct DOM mutation: no React re-render.
		 * Fires on every scroll (capture) and resize, so it must be cheap.
		 *
		 * Three regimes as the editor scrolls up:
		 * 1. **Free**: toolbar floats above the anchor with a 6px gap (default).
		 * 2. **Clamped**: toolbar would escape above the form header, so it
		 *    pins just below the header's bottom edge.
		 * 3. **Hidden**: anchor has scrolled out of the scroll container's
		 *    visible region entirely. */
		const GAP = 6;
		/* Padding between the bottom of the form header and the clamped
		 * toolbar. Tight on purpose: paired with the form body's top padding
		 * so the toolbar fits flush in the margin above the first field. */
		const CLAMP_PAD = 2;

		const update = () => {
			const rect = anchor.getBoundingClientRect();
			const container = anchor.closest(
				"[data-preview-scroll-container]",
			) as HTMLElement | null;
			const containerRect = container?.getBoundingClientRect();
			const containerTop = containerRect ? containerRect.top : 0;
			const containerBottom = containerRect
				? containerRect.bottom
				: window.innerHeight;

			const toolbarHeight = portal.offsetHeight;

			/* Clamp floor is the bottom of the form header. When the header is
			 * sticky it stays put on scroll, so this boundary remains correct as
			 * the user scrolls through the form. If no header is mounted (e.g.
			 * outside the form screen), fall back to viewport top so the toolbar
			 * at least stays on-screen. */
			const header = document.querySelector<HTMLElement>("[data-form-header]");
			const clampFloor = header
				? header.getBoundingClientRect().bottom + CLAMP_PAD
				: 0;

			/* Ideal top edge: above anchor with a GAP. Clamped when the ideal
			 * position would overlap the form header. */
			const idealTop = rect.top - toolbarHeight - GAP;
			const clampedTop = Math.max(clampFloor, idealTop);

			/* Hide when the anchor has scrolled out of the scroll container's
			 * visible region (either fully above or fully below). */
			const hidden = rect.bottom < containerTop || rect.top > containerBottom;

			portal.style.position = "fixed";
			portal.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - portal.offsetWidth - 8))}px`;
			portal.style.top = `${clampedTop}px`;
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
			data-prose-editor={proseEditorId(editor)}
			onMouseDown={(e) => {
				if (e.currentTarget.contains(e.target as Node)) e.preventDefault();
			}}
		>
			<Toolbar
				variant="floating"
				className={`${POPOVER_GLASS} max-w-[calc(100vw-1rem)] flex-wrap`}
			>
				{formatText && (
					<>
						<ToolbarGroup>
							<FormatTextToggle
								formatText={formatText}
								onToggle={onToggleFormatText}
							/>
						</ToolbarGroup>
						<ToolbarSeparator />
					</>
				)}
				{plain && <UnavailableFormattingGroups />}
				{!plain && (
					<ToolbarGroup>
						<MarkButton type="bold" />
						<MarkButton type="italic" />
						<MarkButton type="code" />
					</ToolbarGroup>
				)}
				{!plain && !compact && (
					<>
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
					</>
				)}
				<ProseReferencePicker editor={editor} onLeaveEditor={onLeaveEditor} />
				<ToolbarSaveHint />
			</Toolbar>
		</div>,
		document.body,
	);
}

export function InlineTextEditor({
	value,
	onSave,
	onCancel,
	fieldType,
	autoFocus,
	clickPosition,
	formatText,
}: InlineTextEditorProps) {
	const plain = formatText?.plain === true;
	/* The draft as last edited, carried into the other editor when the stored
	 * Format text setting changes under it. Null until the author edits, so an
	 * untouched label swaps with its stored characters rather than the
	 * Markdown serializer's spelling of them. */
	const draftRef = useRef<ProseTemplate | null>(null);
	const onDraft = useCallback((draft: ProseTemplate) => {
		draftRef.current = draft;
	}, []);
	/* The click that opened the editor places the first editor's cursor; an
	 * editor swapped in afterwards takes the cursor at the end. */
	const [openedPlain] = useState(plain);
	const [swapped, setSwapped] = useState(false);
	if (plain !== openedPlain && !swapped) setSwapped(true);
	return (
		<InlineTextEditorSurface
			key={plain ? "plain" : "formatted"}
			initial={draftRef.current ?? value}
			plain={plain}
			onDraft={onDraft}
			onSave={onSave}
			onCancel={onCancel}
			fieldType={fieldType}
			autoFocus={swapped || autoFocus}
			clickPosition={swapped ? null : clickPosition}
			formatText={formatText}
		/>
	);
}

function InlineTextEditorSurface({
	initial,
	plain,
	onDraft,
	onSave,
	onCancel,
	fieldType,
	autoFocus,
	clickPosition,
	formatText,
}: Omit<InlineTextEditorProps, "value"> & {
	/** The text the editor opens with. */
	initial: ProseTemplate;
	/** Whether this editor reads the text as plain characters (Format text
	 *  off) or as Markdown. Fixed for the editor's life: the parent swaps in
	 *  a new editor when the setting changes. */
	plain: boolean;
	/** Receives the draft after every edit. */
	onDraft: (draft: ProseTemplate) => void;
}) {
	const provider = useReferenceProvider();
	const getFormUuid = useLiveFormUuidGetter();
	const platforms = useDeclaredPlatforms();
	const savedRef = useRef(false);
	const rejectedSaveRef = useRef(false);
	const anchorRef = useRef<HTMLDivElement>(null);
	/* False once this editor has been swapped out: a blur its teardown
	 * delivers afterwards must not save over the editor that replaced it. */
	const aliveRef = useRef(true);
	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);
	const [confirming, setConfirming] = useState(false);
	const [formatRefusal, setFormatRefusal] = useState<string | null>(null);

	/** The editor's text as it stores, in this editor's reading. */
	const serialize = useCallback(
		(editor: Editor): ProseTemplate =>
			plain
				? plainLabelEditorTemplate(editor.getJSON())
				: markdownToProseTemplate(getMarkdownContent(editor)),
		[plain],
	);
	const serializeRef = useRef(serialize);
	serializeRef.current = serialize;
	const onDraftRef = useRef(onDraft);
	onDraftRef.current = onDraft;
	/* True once the author edits in this editor: from then on a swap carries
	 * the serialized draft rather than `initial`, so Format text judges that. */
	const editedRef = useRef(false);

	/** Save the current editor content. Guards against double-fire. */
	const saveAndDeactivate = useCallback(
		(editor: Editor | null): boolean => {
			if (savedRef.current || rejectedSaveRef.current || !editor) return false;
			savedRef.current = true;
			const outcome = onSave(serialize(editor));
			if (outcome !== undefined && !outcome.ok) {
				// The parent keeps the editor mounted with the rejected draft. Block the
				// blur caused by this attempt from dispatching the same content again,
				// but leave Escape available and let the next edit unlock a retry.
				savedRef.current = false;
				rejectedSaveRef.current = true;
				return false;
			}
			return true;
		},
		[onSave, serialize],
	);

	/** Cancel editing: revert to the original value without saving. */
	const cancelAndDeactivate = useCallback(() => {
		if (savedRef.current) return;
		savedRef.current = true;
		rejectedSaveRef.current = false;
		onCancel();
	}, [onCancel]);

	const saveRef = useRef(saveAndDeactivate);
	saveRef.current = saveAndDeactivate;
	const cancelRef = useRef(cancelAndDeactivate);
	cancelRef.current = cancelAndDeactivate;

	/**
	 * TipTap keyboard extension for Tab/Shift+Tab navigation between
	 * TextEditable instances. Resolve the next target before save unmounts
	 * the current editor. Escape cancels the draft.
	 */
	const keyboardExtension = useMemo(
		() =>
			Extension.create({
				name: "inlineTextEditorKeyboard",
				priority: 100,
				addKeyboardShortcuts() {
					return {
						Tab: ({ editor }) => {
							const next = adjacentEditable(editor.view.dom, "next");
							if (saveRef.current(editor)) next?.click();
							return true;
						},
						"Shift-Tab": ({ editor }) => {
							const previous = adjacentEditable(editor.view.dom, "prev");
							if (saveRef.current(editor)) previous?.click();
							return true;
						},
						"Mod-Enter": ({ editor }) => {
							if (saveRef.current(editor)) editor.commands.blur();
							return true;
						},
						Escape: ({ editor }) => {
							if (dismissProseSuggestion(editor)) return true;
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
		() => [
			...(plain
				? createPlainLabelEditorExtensions(provider, getFormUuid)
				: createInlineEditorExtensions(provider, getFormUuid)),
			keyboardExtension,
		],
		[plain, provider, getFormUuid, keyboardExtension],
	);

	const editor = useEditor({
		extensions,
		/* Formatted, the initial content goes straight through tiptap-markdown's
		 * parse pipeline. `proseTemplateToMarkdown` emits each typed reference as
		 * its encoded `<span data-nova-prose-ref="…">` carrier, which
		 * CommcareRef's `parseHTML` matches, so the ProseMirror doc already
		 * contains commcareRef nodes before the view is ever mounted. Plain, the
		 * content is the text's own lines and reference atoms as Tiptap JSON,
		 * read by no Markdown parser. Either way no post-mount hydration dispatch
		 * is required: chips are present on first paint, and TipTap's
		 * `ReactRenderer.flushSync` path is never hit from inside a React effect.
		 * Hashtag-looking TEXT is not a reference and never becomes one here:
		 * only the encoded carrier or the typed atom does. */
		content: plain
			? plainLabelEditorContent(initial)
			: proseTemplateToMarkdown(initial),
		immediatelyRender: false,
		onUpdate: ({ editor: e }) => {
			// A refused commit leaves the editor mounted. Once the user amends the
			// draft, permit another save attempt; unchanged rejected content stays
			// single-shot so the following blur cannot dispatch it twice.
			savedRef.current = false;
			rejectedSaveRef.current = false;
			editedRef.current = true;
			onDraftRef.current(serializeRef.current(e));
		},
		editorProps: {
			attributes: {
				/* Typography classes live on the preview-markdown wrapper (matching
				 * static LabelContent). ProseMirror's injected white-space/position
				 * are matched by the preview-markdown rule in globals.css. */
				class: "outline-none",
				role: "textbox",
				"aria-label": fieldType === "label" ? "Label" : "Hint",
				"aria-multiline": "true",
				"data-1p-ignore": "",
				autocomplete: "off",
			},
		},
		onBlur: ({ editor: e }) => {
			/* Delay save to let the browser update activeElement. If focus moved to
			 * our toolbar portal, its dropdown, or the Format text question under
			 * the editor (all outside the ProseMirror DOM tree), the blur is
			 * transient: don't save. Only save when focus has genuinely left the
			 * editing context. Each of those surfaces is tagged with
			 * [data-inline-toolbar]. Focus can also come back to the editor itself
			 * before the frame runs: a reference chosen in the picker closes it
			 * and returns focus here, and on a busy frame that happens before the
			 * check for the blur that opened the picker. An editor swapped out for
			 * the other Format text reading never saves. */
			requestAnimationFrame(() => {
				if (
					aliveRef.current &&
					!e.isDestroyed &&
					!e.view.hasFocus() &&
					!prosePickerIsOpen(e) &&
					!document.activeElement?.closest("[data-inline-toolbar]")
				) {
					saveRef.current(e);
				}
			});
		},
	});

	/* One-shot cursor placement on mount. Pure selection mutation, does not
	 * instantiate new React NodeViews, so it's safe to dispatch from a React
	 * effect (unlike a content-replacing transaction, which creates NodeViews
	 * whose `ReactRenderer` constructor calls `flushSync` and errors inside the
	 * CommitContext that wraps passive-effect flushes in React 19).
	 *
	 * When a click position is provided, `posAtCoords` maps viewport coords to a
	 * document position so the cursor lands where the user clicked rather than
	 * jumping to the end of the field. */
	useEffect(() => {
		if (!editor || !autoFocus) return;
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
	}, [editor, autoFocus, clickPosition]);

	/** Write the label's Format text setting. A landed write changes the
	 *  stored setting, and the parent swaps in the other editor. */
	const writeFormatText = useCallback(
		(plainLabel: true | null) => {
			if (!formatText) return;
			const outcome = formatText.write(plainLabel);
			if (!outcome.ok) {
				setFormatRefusal(
					outcome.messages[0] ?? "This change did not pass the app guardrails.",
				);
				return;
			}
			setFormatRefusal(null);
			setConfirming(false);
		},
		[formatText],
	);

	const toggleFormatText = useCallback(() => {
		if (!formatText || !editor) return;
		const gesture = formatTextGesture({
			plain: formatText.plain,
			isSource: formatText.isSource,
			/* The text the plain editor will hold: the draft once edited, else
			 * the characters this editor opened with. */
			holdsFormatting: () =>
				proseTemplateHoldsFormatting(
					editedRef.current ? serialize(editor) : initial,
				),
		});
		if (gesture.kind === "confirm") setConfirming(true);
		else if (gesture.kind === "write") writeFormatText(gesture.plainLabel);
	}, [formatText, editor, writeFormatText, serialize, initial]);

	/** The question takes focus when it opens, so a keyboard reaches its
	 *  answers; stable, so a later render never pulls focus back to it. */
	const focusOnOpen = useCallback((button: HTMLButtonElement | null) => {
		button?.focus();
	}, []);

	/** Keep formatting: close the question and hand the cursor back. */
	const keepFormatting = useCallback(() => {
		setConfirming(false);
		editor?.commands.focus();
	}, [editor]);

	if (!editor) return null;

	return (
		<Tiptap editor={editor}>
			<div ref={anchorRef} className="relative" data-no-drag>
				<LabelToolbar
					anchorRef={anchorRef}
					editor={editor}
					compact={fieldType !== "label"}
					onLeaveEditor={() => saveRef.current(editor)}
					formatText={formatText}
					onToggleFormatText={toggleFormatText}
				/>
				{/* Text styling + preview-markdown on a single wrapper: matches the
				 * static LabelContent structure for flipbook parity. */}
				<div className={`preview-markdown ${FIELD_STYLES[fieldType]}`}>
					<Tiptap.Content />
				</div>
				{formatText && plain && (
					<p
						data-format-text-line
						className="mt-1.5 text-xs leading-relaxed text-nova-text-muted"
					>
						{formatTextOffLine("label", platforms)}
					</p>
				)}
				{confirming && (
					<fieldset
						data-inline-toolbar
						data-format-text-prompt
						className="m-0 mt-2 min-w-0 rounded-lg border border-white/[0.06] bg-nova-deep/50 p-3"
						onMouseDown={(event) => event.preventDefault()}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.stopPropagation();
								keepFormatting();
							}
						}}
						onBlur={() => {
							/* Focus that leaves the question for somewhere outside the
							 * editing context ends the edit, as a blur from the editor
							 * does. */
							requestAnimationFrame(() => {
								if (
									!aliveRef.current ||
									editor.isDestroyed ||
									editor.view.hasFocus() ||
									prosePickerIsOpen(editor) ||
									document.activeElement?.closest("[data-inline-toolbar]")
								) {
									return;
								}
								setConfirming(false);
								saveRef.current(editor);
							});
						}}
					>
						<legend className="float-left w-full p-0 text-xs leading-relaxed text-nova-text-secondary">
							{FORMAT_TEXT_CONFIRM}
						</legend>
						<div className="clear-both flex flex-wrap gap-2 pt-2">
							<Button
								type="button"
								variant="secondary"
								data-format-text-confirm="off"
								ref={focusOnOpen}
								onClick={() => writeFormatText(true)}
							>
								{FORMAT_TEXT_CONFIRM_OFF}
							</Button>
							<Button
								type="button"
								variant="ghost"
								data-format-text-confirm="keep"
								onClick={keepFormatting}
							>
								{FORMAT_TEXT_CONFIRM_KEEP}
							</Button>
						</div>
					</fieldset>
				)}
				<RejectionInline message={formatRefusal} className="max-w-sm" />
			</div>
		</Tiptap>
	);
}

/**
 * Find and click the next or previous [data-text-editable] element
 * in DOM order to activate its InlineTextEditor.
 */
function adjacentEditable(
	editorElement: HTMLElement,
	direction: "next" | "prev",
): HTMLElement | undefined {
	const all = Array.from(
		document.querySelectorAll<HTMLElement>("[data-text-editable]"),
	);
	const active = editorElement.closest<HTMLElement>("[data-text-editable]");
	if (active === null || all.length < 2) return undefined;
	const index = all.indexOf(active);
	if (index < 0) return undefined;
	return all[
		(index + (direction === "next" ? 1 : all.length - 1)) % all.length
	];
}
