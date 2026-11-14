"use client";

import { Icon } from "@iconify/react/offline";
import tablerMathFunction from "@iconify-icons/tabler/math-function";
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
import type { ProseSlotRef } from "@/lib/domain/expression/types";
import {
	useCurrentFormUuid,
	useReferenceProvider,
} from "@/lib/references/ReferenceContext";
import type { Reference } from "@/lib/references/types";
import { POPOVER_ROW_CLS } from "@/lib/styles";
import {
	dismissProseSuggestion,
	editProseReference,
	insertProseAtom,
	insertProseReference,
	proseEditorId,
	proseEditorOwnsFocus,
	proseReferenceSelection,
	searchProseReferences,
	setProsePickerOpen,
} from "@/lib/tiptap/proseReferenceEditing";
import { ProseValuePopover } from "./ProseValuePopover";
import {
	ReferenceAutocomplete,
	type ReferenceAutocompleteHandle,
} from "./ReferenceAutocomplete";

/** Shared by both prose editors. The selection stays in ProseMirror while
 * focus visits the picker; a changed document refuses the stale range. A
 * text with a prose slot also inserts and edits calculated values, in the
 * value popover anchored where the picker is. */
export function ProseReferencePicker({
	editor,
	onLeaveEditor,
	proseSlot,
}: {
	editor: Editor;
	onLeaveEditor: () => void;
	/** The text's slot. A text with none (a case property's label) offers no
	 *  calculated value. */
	proseSlot?: ProseSlotRef;
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
	const [valueOpen, setValueOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
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
	const target = open || valueOpen ? targetRef.current : selection;
	const valueSelected = target?.part?.kind === "value";
	const label = valueSelected
		? "Edit calculated value"
		: target?.part
			? "Replace reference"
			: target?.isToken
				? "Convert to reference"
				: "Insert reference";
	const resolved =
		target?.part && target.part.kind !== "value"
			? provider.resolvePart(target.part, formUuid)
			: undefined;
	const items = searchProseReferences(provider, formUuid, query);

	function captureTarget() {
		// Start the draft before focus leaves for the input, including when
		// the author pressed Insert reference on an unfocused inspector.
		editor.view.focus();
		dismissProseSuggestion(editor);
		const selected = proseReferenceSelection(editor);
		targetRef.current = selected;
		return selected;
	}

	function changeOpen(next: boolean) {
		if (next) {
			const selected = captureTarget();
			// A selected calculated value opens straight onto its formula.
			if (selected.part?.kind === "value" && proseSlot !== undefined) {
				changeValueOpen(true, false);
				return;
			}
			setQuery(selected.isToken ? selected.text : "");
			setError("");
		}
		setProsePickerOpen(editor, next);
		setOpen(next);
	}

	function changeValueOpen(next: boolean, fromPicker: boolean) {
		if (next && fromPicker) setOpen(false);
		setProsePickerOpen(editor, next);
		setValueOpen(next);
		if (!next && !editor.isDestroyed) editor.view.focus();
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

	const editingValue =
		valueOpen && targetRef.current?.part?.kind === "value"
			? targetRef.current.part
			: undefined;
	const sessionAttributes = {
		"data-inline-toolbar": "",
		"data-prose-editor": proseEditorId(editor),
	} as const;

	return (
		<>
			<Popover
				open={open}
				onOpenChange={(next, details) => {
					changeOpen(next);
					if (
						!next &&
						(details.reason === "outside-press" ||
							details.reason === "focus-out")
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
							ref={triggerRef}
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
					className="w-80 max-h-[var(--available-height)] overflow-y-auto [&>*]:shrink-0"
					data-inline-toolbar
					data-prose-editor={proseEditorId(editor)}
					finalFocus={() => (editor.isDestroyed ? false : editor.view.dom)}
				>
					<PopoverTitle>{label}</PopoverTitle>
					<p className="text-xs text-nova-text-muted">
						References show an answer or saved value when the form runs. You can
						also type # to find one.
					</p>
					{proseSlot !== undefined && (
						<button
							type="button"
							className={POPOVER_ROW_CLS}
							data-prose-value-row=""
							onClick={() => {
								const saved = validTarget();
								if (!saved) return;
								changeValueOpen(true, true);
							}}
						>
							<Icon
								icon={tablerMathFunction}
								width={16}
								height={16}
								className="shrink-0"
							/>
							<span className="flex min-w-0 flex-col">
								<span>Calculated value</span>
								<span className="text-xs text-nova-text-muted">
									Shows the result of a formula, such as a formatted date.
								</span>
							</span>
						</button>
					)}
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
									saved?.part &&
									saved.part.kind !== "value" &&
									provider.resolvePart(saved.part, formUuid);
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
			{proseSlot !== undefined && (
				<ProseValuePopover
					open={valueOpen}
					onOpenChange={(next) => changeValueOpen(next, false)}
					slot={proseSlot}
					editing={editingValue}
					anchor={triggerRef.current}
					sessionAttributes={sessionAttributes}
					onCommit={(part) => {
						const saved = targetRef.current;
						if (
							!saved ||
							!editor.state.doc.eq(saved.doc) ||
							!insertProseAtom(editor, saved.range, part)
						) {
							// The wording moved under the popover: say so where the
							// author chose to insert, and insert nothing.
							setValueOpen(false);
							setError(
								"The wording changed while this was open. You can close this picker and select it again.",
							);
							setProsePickerOpen(editor, true);
							setOpen(true);
							return;
						}
						changeValueOpen(false, false);
					}}
					onRemove={() => {
						const saved = targetRef.current;
						if (saved && editor.state.doc.eq(saved.doc))
							editProseReference(editor, (tr) => {
								tr.delete(saved.range.from, saved.range.to);
							});
						changeValueOpen(false, false);
					}}
				/>
			)}
		</>
	);
}
