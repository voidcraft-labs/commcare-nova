// components/builder/case-list-config/inspector/OptionalMarkdownRow.tsx
//
// The markdown sibling of OptionalTextRow: a WYSIWYG TipTap editor for
// optional inspector slots whose wire value is markdown (verified
// against CommCare Web Apps, which renders the search screen's
// `description` through its markdown-it pipeline). The attached toolbar
// IS the affordance — it shows exactly the formatting the runtime
// renders, so the row needs no "Markdown" badge, no syntax explanation,
// and no separate live preview.
//
// No hashtag chips: these slots are plain localized strings on the
// wire, never xpath-evaluated, so the editor uses the chip-free
// extension set. That also keeps the document free of React NodeViews,
// which makes `setContent` safe to dispatch from React effects (the
// external-value sync below).
//
// Commit semantics match OptionalTextRow: commit on blur, trimmed;
// emptying a previously-set slot commits `undefined` (the parent's
// strict-parse drops the key); emptying an already-absent slot commits
// nothing, so focusing and leaving never writes an empty config or an
// undo entry. Escape reverts to the last committed value; Cmd/Ctrl+Enter
// commits immediately.

"use client";
import { type Editor, Extension } from "@tiptap/core";
import { Tiptap, useEditor } from "@tiptap/react";
import { useEffect, useId, useMemo, useRef } from "react";
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
} from "@/components/tiptap-ui-primitive/toolbar";
import {
	createMarkdownEditorExtensions,
	getMarkdownContent,
} from "@/lib/tiptap/markdownExtensions";

interface OptionalMarkdownRowProps {
	readonly label: string;
	readonly hint: string;
	readonly value: string | undefined;
	readonly onCommit: (next: string | undefined) => void;
}

export function OptionalMarkdownRow({
	label,
	hint,
	value,
	onCommit,
}: OptionalMarkdownRowProps) {
	const inputId = useId();
	const rowRef = useRef<HTMLDivElement>(null);

	/* Fresh-value refs — the blur handler and keyboard extension are
	 * captured once by TipTap, so they read through refs. */
	const valueRef = useRef(value);
	valueRef.current = value;
	const onCommitRef = useRef(onCommit);
	onCommitRef.current = onCommit;

	const commit = (editor: Editor) => {
		const md = getMarkdownContent(editor).trim();
		const current = valueRef.current;
		if (md === "") {
			if (current !== undefined) onCommitRef.current(undefined);
			return;
		}
		if (md !== current) onCommitRef.current(md);
	};
	const commitRef = useRef(commit);
	commitRef.current = commit;

	const keyboardExtension = useMemo(
		() =>
			Extension.create({
				name: "optionalMarkdownRowKeyboard",
				addKeyboardShortcuts() {
					return {
						"Mod-Enter": ({ editor }) => {
							editor.commands.blur();
							return true;
						},
						/* Revert, then blur — the blur commit compares against the
						 * restored value and no-ops, so Escape is a pure cancel. */
						Escape: ({ editor }) => {
							editor.commands.setContent(valueRef.current ?? "");
							editor.commands.blur();
							return true;
						},
					};
				},
			}),
		[],
	);

	const extensions = useMemo(
		() => [...createMarkdownEditorExtensions(), keyboardExtension],
		[keyboardExtension],
	);

	const editor = useEditor({
		extensions,
		content: value ?? "",
		immediatelyRender: false,
		editorProps: {
			attributes: {
				/* The contenteditable IS the input surface: padding and min
				 * height live on it so a click anywhere in the box focuses
				 * the editor. `id` receives the row label via htmlFor. */
				id: inputId,
				class: "outline-none px-3 py-2.5 min-h-18 text-[13px]",
				"data-1p-ignore": "",
				autocomplete: "off",
			},
		},
		onBlur: ({ editor: e }) => {
			/* Delay so activeElement reflects where focus went. Focus moving
			 * into the row's own toolbar — or a toolbar popover portaled to
			 * body (tagged [data-inline-toolbar] by the tiptap-ui
			 * primitives) — is a transient blur, not a commit. */
			requestAnimationFrame(() => {
				const active = document.activeElement;
				if (rowRef.current?.contains(active) === true) return;
				if (active?.closest("[data-inline-toolbar]")) return;
				commitRef.current(e);
			});
		},
	});

	/* External value sync — undo/redo or an agent edit can change the
	 * slot while the row is mounted. Only while unfocused, so a commit's
	 * own round-trip never stomps an in-progress edit. */
	useEffect(() => {
		if (!editor || editor.isFocused) return;
		if (getMarkdownContent(editor).trim() !== (value ?? "")) {
			editor.commands.setContent(value ?? "");
		}
	}, [editor, value]);

	if (!editor) return null;

	return (
		<div ref={rowRef} className="flex flex-col gap-1.5">
			<label
				htmlFor={inputId}
				className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted"
			>
				{label}
			</label>
			<Tiptap editor={editor}>
				<div className="rounded-lg border border-white/[0.06] bg-nova-deep/50 focus-within:border-nova-violet/40 focus-within:ring-1 focus-within:ring-nova-violet/30 transition-colors overflow-hidden">
					{/* `fixed` is the primitive's single-line variant: the full
					 *  control set stays on one row and scrolls horizontally
					 *  (scrollbar hidden) rather than wrapping at the rail's
					 *  narrow width. `onMouseDown` preventDefault keeps toolbar
					 *  clicks from stealing focus (which would blur-commit
					 *  mid-format); the tiptap-ui buttons act on `onClick`,
					 *  which still fires. */}
					<Toolbar
						variant="fixed"
						data-inline-toolbar
						aria-label={`${label} formatting`}
						className="border-b border-white/[0.06]"
						onMouseDown={(e) => e.preventDefault()}
					>
						<ToolbarGroup>
							<MarkButton type="bold" />
							<MarkButton type="italic" />
							<MarkButton type="code" />
						</ToolbarGroup>
						<ToolbarGroup>
							<HeadingDropdownMenu levels={[1, 2, 3]} modal={false} />
							<ListDropdownMenu
								types={["bulletList", "orderedList"]}
								modal={false}
							/>
						</ToolbarGroup>
						<ToolbarGroup>
							<LinkPopover />
							<ImagePopover />
						</ToolbarGroup>
						<ToolbarGroup>
							<CodeBlockButton />
							<HorizontalRuleButton />
							<TableButton />
						</ToolbarGroup>
					</Toolbar>
					{/* preview-markdown typography so the WYSIWYG text renders
					 *  exactly like the canvas's PreviewMarkdown output. */}
					<div className="preview-markdown text-nova-text">
						<Tiptap.Content />
					</div>
				</div>
			</Tiptap>
			<span className="text-[11px] leading-relaxed text-nova-text-muted">
				{hint}
			</span>
		</div>
	);
}
