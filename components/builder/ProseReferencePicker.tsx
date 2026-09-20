"use client";

import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import {
	Popover,
	PopoverContent,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import {
	useCurrentFormUuid,
	useReferenceProvider,
} from "@/lib/references/ReferenceContext";
import type { Reference } from "@/lib/references/types";
import {
	dismissProseSuggestion,
	editProseReference,
	insertProseReference,
	proseEditorId,
	proseEditorOwnsFocus,
	proseReferenceSelection,
	searchProseReferences,
	setProsePickerOpen,
} from "@/lib/tiptap/proseReferenceEditing";
import {
	ReferenceAutocomplete,
	type ReferenceAutocompleteHandle,
} from "./ReferenceAutocomplete";

/** Shared by both prose editors. The selection stays in ProseMirror while
 * focus visits the picker; a changed document refuses the stale range. */
export function ProseReferencePicker({
	editor,
	onLeaveEditor,
}: {
	editor: Editor;
	onLeaveEditor: () => void;
}) {
	const provider = useReferenceProvider();
	const formUuid = useCurrentFormUuid();
	const [, refresh] = useState(0);
	useEffect(
		() =>
			provider?.subscribeInvalidation(() =>
				refresh((revision) => revision + 1),
			),
		[provider],
	);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [error, setError] = useState("");
	const [activeId, setActiveId] = useState<string>();
	const listId = useId();
	const listRef = useRef<ReferenceAutocompleteHandle>(null);
	const targetRef = useRef<ReturnType<typeof proseReferenceSelection>>(null);
	const selection = useEditorState({
		editor,
		selector: ({ editor: current }) => proseReferenceSelection(current),
	});
	useEffect(() => () => setProsePickerOpen(editor, false), [editor]);
	if (!provider) return null;
	const target = open ? targetRef.current : selection;
	const label = target?.part
		? "Replace reference"
		: target?.isToken
			? "Convert to reference"
			: "Insert reference";
	const resolved = target?.part
		? provider.resolvePart(target.part, formUuid)
		: undefined;
	const items = searchProseReferences(provider, formUuid, query);

	function changeOpen(next: boolean) {
		if (next) {
			// Start the draft before focus leaves for the input, including when
			// the author pressed Insert reference on an unfocused inspector.
			editor.view.focus();
			dismissProseSuggestion(editor);
			const selected = proseReferenceSelection(editor);
			targetRef.current = selected;
			setQuery(selected.isToken ? selected.text : "");
			setError("");
		}
		setProsePickerOpen(editor, next);
		setOpen(next);
	}

	function validTarget() {
		const saved = targetRef.current;
		if (!saved || !editor.state.doc.eq(saved.doc)) {
			setError(
				"The wording changed while this was open. You can close this picker and select it again.",
			);
			return null;
		}
		return saved;
	}

	function choose(reference: Reference) {
		const saved = validTarget();
		if (!saved || !provider) return;
		if (
			!insertProseReference(editor, saved.range, reference, provider, formUuid)
		) {
			setError(
				"That reference is no longer available here. You can choose another.",
			);
			return;
		}
		changeOpen(false);
	}

	return (
		<Popover
			open={open}
			onOpenChange={(next, details) => {
				changeOpen(next);
				if (
					!next &&
					(details.reason === "outside-press" || details.reason === "focus-out")
				) {
					const target =
						details.reason === "focus-out" &&
						details.event instanceof FocusEvent
							? details.event.relatedTarget
							: details.event.target;
					if (
						!(target instanceof Node && editor.view.dom.contains(target)) &&
						!proseEditorOwnsFocus(editor, target)
					)
						onLeaveEditor();
				}
			}}
		>
			<PopoverTrigger
				render={
					<Button
						variant="ghost-action"
						className="px-2 text-xs"
						data-inline-toolbar
						data-prose-editor={proseEditorId(editor)}
						onMouseDown={(event) => event.preventDefault()}
					/>
				}
			>
				{label}
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-80"
				data-inline-toolbar
				data-prose-editor={proseEditorId(editor)}
				finalFocus={() => (editor.isDestroyed ? false : editor.view.dom)}
			>
				<PopoverTitle>{label}</PopoverTitle>
				<p className="text-xs text-nova-text-muted">
					References show an answer or saved value when the form runs. You can
					also type # to find one.
				</p>
				{target?.isToken && !provider.resolve(target.text, formUuid) && (
					<p className="text-xs text-nova-text-muted">
						This text doesn't match an available reference. You can search for
						another; the text stays until you choose.
					</p>
				)}
				<Input
					aria-label="Search references"
					role="combobox"
					aria-expanded="true"
					aria-controls={listId}
					aria-activedescendant={activeId}
					aria-autocomplete="list"
					placeholder="Search answers and properties"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => {
						if (listRef.current?.onKeyDown(event.nativeEvent)) {
							event.preventDefault();
							event.stopPropagation();
						}
					}}
				/>
				<ReferenceAutocomplete
					ref={listRef}
					listId={listId}
					onActiveChange={setActiveId}
					namespaceItems={[]}
					showNamespaces={false}
					items={items}
					onSelect={choose}
				/>
				{resolved && (
					<Button
						variant="ghost"
						onClick={() => {
							const saved = validTarget();
							const live =
								saved?.part && provider.resolvePart(saved.part, formUuid);
							if (!saved || !live) return;
							editProseReference(editor, (tr) => {
								tr.insertText(live.raw, saved.range.from, saved.range.to);
							});
							changeOpen(false);
						}}
					>
						Convert to text
					</Button>
				)}
				{error && (
					<p role="alert" className="text-xs text-nova-rose">
						{error}
					</p>
				)}
			</PopoverContent>
		</Popover>
	);
}
