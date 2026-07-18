// components/builder/inspector/OptionalMarkdownRow.tsx
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
import { Icon } from "@iconify/react/offline";
import tablerCode from "@iconify-icons/tabler/code";
import tablerCodeDots from "@iconify-icons/tabler/code-dots";
import tablerHeading from "@iconify-icons/tabler/heading";
import tablerList from "@iconify-icons/tabler/list";
import tablerListNumbers from "@iconify-icons/tabler/list-numbers";
import tablerPhoto from "@iconify-icons/tabler/photo";
import tablerSeparatorHorizontal from "@iconify-icons/tabler/separator-horizontal";
import tablerTable from "@iconify-icons/tabler/table";
import { type Editor, Extension } from "@tiptap/core";
import { Tiptap, useEditor } from "@tiptap/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { Input } from "@/components/shadcn/input";
import { Label } from "@/components/shadcn/label";
import {
	canToggle as canToggleCodeBlock,
	toggleCodeBlock,
} from "@/components/tiptap-ui/code-block-button";
import {
	canToggle as canToggleHeading,
	toggleHeading,
} from "@/components/tiptap-ui/heading-button";
import {
	canInsertHorizontalRule,
	insertHorizontalRule,
} from "@/components/tiptap-ui/horizontal-rule-button";
import { canInsertImage } from "@/components/tiptap-ui/image-popover";
import { LinkPopover } from "@/components/tiptap-ui/link-popover";
import { canToggleList, toggleList } from "@/components/tiptap-ui/list-button";
import { MarkButton } from "@/components/tiptap-ui/mark-button";
import {
	canInsertTable,
	insertTable,
} from "@/components/tiptap-ui/table-button";
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
				class: "outline-none px-3 py-2.5 min-h-18 text-[14px]",
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
				className="text-[13px] font-medium leading-5 text-nova-text-secondary"
			>
				{label}
			</label>
			<Tiptap editor={editor}>
				<div className="rounded-lg border border-white/[0.06] bg-nova-deep/50 focus-within:border-nova-violet/40 focus-within:ring-1 focus-within:ring-nova-violet/30 transition-colors overflow-hidden">
					{/* The compact toolbar shows the three everyday actions and one
					 *  clearly named progressive-disclosure menu. Its floating variant
					 *  clips instead of creating a horizontal scroll region, and the
					 *  44px controls fit the inspector's narrowest 300px rail.
					 *  `onMouseDown` preventDefault keeps toolbar
					 *  clicks from stealing focus (which would blur-commit
					 *  mid-format); the tiptap-ui buttons act on `onClick`,
					 *  which still fires. */}
					<Toolbar
						variant="floating"
						data-inline-toolbar
						aria-label={`${label} formatting`}
						className="min-h-11 w-full min-w-0 justify-between overflow-hidden rounded-none border-b border-white/[0.06]"
						onMouseDown={(e) => e.preventDefault()}
					>
						<ToolbarGroup className="shrink-0 gap-0">
							<MarkButton
								type="bold"
								tabIndex={0}
								className="min-h-11 min-w-11"
							/>
							<MarkButton type="italic" className="min-h-11 min-w-11" />
							<LinkPopover className="min-h-11 min-w-11" />
						</ToolbarGroup>
						<ToolbarGroup className="min-w-0 shrink-0">
							<MoreFormattingMenu editor={editor} />
						</ToolbarGroup>
					</Toolbar>
					{/* preview-markdown typography so the WYSIWYG text renders
					 *  exactly like the canvas's PreviewMarkdown output. */}
					<div className="preview-markdown text-nova-text">
						<Tiptap.Content />
					</div>
				</div>
			</Tiptap>
			<span className="text-[13px] leading-relaxed text-nova-text-muted">
				{hint}
			</span>
		</div>
	);
}

const HEADING_LEVELS = [1, 2, 3] as const;

/**
 * Long-tail formatting stays fully available without turning a 300px rail
 * into a horizontally scrolling icon puzzle. Base UI owns keyboard navigation
 * and focus return; every action calls the same helpers as the former toolbar
 * buttons, so progressive disclosure changes only where the action lives.
 */
function MoreFormattingMenu({ editor }: { readonly editor: Editor }) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [imageDialogOpen, setImageDialogOpen] = useState(false);
	const [tableDialogOpen, setTableDialogOpen] = useState(false);
	const [imageUrl, setImageUrl] = useState("");
	const [imageAlt, setImageAlt] = useState("");

	const openImageDialog = () => {
		const attributes = editor.isActive("image")
			? editor.getAttributes("image")
			: {};
		setImageUrl(typeof attributes.src === "string" ? attributes.src : "");
		setImageAlt(typeof attributes.alt === "string" ? attributes.alt : "");
		setImageDialogOpen(true);
	};

	const insertImage = () => {
		const url = imageUrl.trim();
		if (url === "") return;
		editor.chain().focus().setImage({ src: url, alt: imageAlt.trim() }).run();
		setImageDialogOpen(false);
	};

	return (
		<>
			<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
				<DropdownMenuTrigger
					render={
						<Button
							type="button"
							variant="ghost"
							size="xl"
							tabIndex={-1}
							className="min-h-11 shrink-0 px-2 text-[14px] text-nova-text-secondary not-disabled:hover:bg-white/[0.04] not-disabled:hover:text-nova-text"
						/>
					}
				>
					More formatting
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					data-inline-toolbar
					preferredMinWidth="16rem"
				>
					<DropdownMenuSub>
						<DropdownMenuSubTrigger className="min-h-11">
							<Icon icon={tablerHeading} />
							Headings
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent
							data-inline-toolbar
							preferredMinWidth="13rem"
						>
							{HEADING_LEVELS.map((level) => (
								<DropdownMenuCheckboxItem
									key={level}
									checked={editor.isActive("heading", { level })}
									disabled={!canToggleHeading(editor, level)}
									closeOnClick
									onClick={() => toggleHeading(editor, level)}
									className="min-h-11"
								>
									Heading {level}
								</DropdownMenuCheckboxItem>
							))}
						</DropdownMenuSubContent>
					</DropdownMenuSub>

					<DropdownMenuSub>
						<DropdownMenuSubTrigger className="min-h-11">
							<Icon icon={tablerList} />
							Lists
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent
							data-inline-toolbar
							preferredMinWidth="13rem"
						>
							<DropdownMenuCheckboxItem
								checked={editor.isActive("bulletList")}
								disabled={!canToggleList(editor, "bulletList")}
								closeOnClick
								onClick={() => toggleList(editor, "bulletList")}
								className="min-h-11"
							>
								<Icon icon={tablerList} />
								Bulleted list
							</DropdownMenuCheckboxItem>
							<DropdownMenuCheckboxItem
								checked={editor.isActive("orderedList")}
								disabled={!canToggleList(editor, "orderedList")}
								closeOnClick
								onClick={() => toggleList(editor, "orderedList")}
								className="min-h-11"
							>
								<Icon icon={tablerListNumbers} />
								Numbered list
							</DropdownMenuCheckboxItem>
						</DropdownMenuSubContent>
					</DropdownMenuSub>

					<DropdownMenuCheckboxItem
						checked={editor.isActive("code")}
						disabled={!editor.isEditable || !editor.can().toggleCode()}
						closeOnClick
						onClick={() => editor.chain().focus().toggleCode().run()}
						className="min-h-11"
					>
						<Icon icon={tablerCode} />
						Inline code
					</DropdownMenuCheckboxItem>
					<DropdownMenuCheckboxItem
						checked={editor.isActive("codeBlock")}
						disabled={!canToggleCodeBlock(editor)}
						closeOnClick
						onClick={() => toggleCodeBlock(editor)}
						className="min-h-11"
					>
						<Icon icon={tablerCodeDots} />
						Code block
					</DropdownMenuCheckboxItem>

					<DropdownMenuSeparator />
					<DropdownMenuItem
						disabled={!canInsertImage(editor)}
						closeOnClick
						onClick={openImageDialog}
						className="min-h-11"
					>
						<Icon icon={tablerPhoto} />
						Image
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={!canInsertTable(editor)}
						closeOnClick
						onClick={() => setTableDialogOpen(true)}
						className="min-h-11"
					>
						<Icon icon={tablerTable} />
						Table
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={!canInsertHorizontalRule(editor)}
						closeOnClick
						onClick={() => insertHorizontalRule(editor)}
						className="min-h-11"
					>
						<Icon icon={tablerSeparatorHorizontal} />
						Divider
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<ImageFormattingDialog
				open={imageDialogOpen}
				onOpenChange={setImageDialogOpen}
				url={imageUrl}
				onUrlChange={setImageUrl}
				alt={imageAlt}
				onAltChange={setImageAlt}
				onInsert={insertImage}
			/>
			<TableFormattingDialog
				open={tableDialogOpen}
				onOpenChange={setTableDialogOpen}
				editor={editor}
			/>
		</>
	);
}

function ImageFormattingDialog({
	open,
	onOpenChange,
	url,
	onUrlChange,
	alt,
	onAltChange,
	onInsert,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly url: string;
	readonly onUrlChange: (value: string) => void;
	readonly alt: string;
	readonly onAltChange: (value: string) => void;
	readonly onInsert: () => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent showCloseButton={false} data-inline-toolbar>
				<form
					className="grid gap-5"
					onSubmit={(event) => {
						event.preventDefault();
						onInsert();
					}}
				>
					<DialogHeader>
						<DialogTitle>Insert image</DialogTitle>
						<DialogDescription>
							Add an image from a web address
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4">
						<div className="grid gap-2">
							<Label htmlFor="markdown-image-url">Image address</Label>
							<Input
								id="markdown-image-url"
								type="url"
								value={url}
								onChange={(event) => onUrlChange(event.target.value)}
								placeholder="https://example.com/image.jpg"
								autoComplete="off"
								data-1p-ignore
								required
								className="min-h-11"
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="markdown-image-alt">Image description</Label>
							<Input
								id="markdown-image-alt"
								value={alt}
								onChange={(event) => onAltChange(event.target.value)}
								autoComplete="off"
								data-1p-ignore
								className="min-h-11"
							/>
							<p className="text-[13px] leading-relaxed text-nova-text-muted">
								Helps people who can’t see the image
							</p>
						</div>
					</div>
					<DialogFooter>
						<DialogClose
							render={<Button type="button" variant="outline" size="xl" />}
						>
							Cancel
						</DialogClose>
						<Button type="submit" size="xl" disabled={url.trim() === ""}>
							Insert
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function parseTableDimension(value: string): number | undefined {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 1 && parsed <= 6
		? parsed
		: undefined;
}

function TableFormattingDialog({
	open,
	onOpenChange,
	editor,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly editor: Editor;
}) {
	const [rows, setRows] = useState("3");
	const [columns, setColumns] = useState("3");
	const rowCount = parseTableDimension(rows);
	const columnCount = parseTableDimension(columns);
	const canInsert = rowCount !== undefined && columnCount !== undefined;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent showCloseButton={false} data-inline-toolbar>
				<form
					className="grid gap-5"
					onSubmit={(event) => {
						event.preventDefault();
						if (rowCount === undefined || columnCount === undefined) return;
						if (insertTable(editor, rowCount, columnCount)) onOpenChange(false);
					}}
				>
					<DialogHeader>
						<DialogTitle>Insert table</DialogTitle>
						<DialogDescription>
							Choose 1 to 6 rows and columns
						</DialogDescription>
					</DialogHeader>
					<div className="grid grid-cols-2 gap-3">
						<div className="grid gap-2">
							<Label htmlFor="markdown-table-rows">Rows</Label>
							<Input
								id="markdown-table-rows"
								type="number"
								min={1}
								max={6}
								step={1}
								value={rows}
								onChange={(event) => setRows(event.target.value)}
								autoComplete="off"
								data-1p-ignore
								required
								aria-invalid={rows !== "" && rowCount === undefined}
								className="min-h-11"
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="markdown-table-columns">Columns</Label>
							<Input
								id="markdown-table-columns"
								type="number"
								min={1}
								max={6}
								step={1}
								value={columns}
								onChange={(event) => setColumns(event.target.value)}
								autoComplete="off"
								data-1p-ignore
								required
								aria-invalid={columns !== "" && columnCount === undefined}
								className="min-h-11"
							/>
						</div>
					</div>
					<DialogFooter>
						<DialogClose
							render={<Button type="button" variant="outline" size="xl" />}
						>
							Cancel
						</DialogClose>
						<Button type="submit" size="xl" disabled={!canInsert}>
							Insert
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
