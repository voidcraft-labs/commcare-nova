"use client";

/**
 * The editor of one calculated value in a text: a popover holding the
 * expression editor for the text's prose slot, so its lint, completion and
 * chips are the slot's own. Committing parses the formula in that slot and
 * builds the part with `canonicalProseAtom`, so a formula that only reads one
 * answer or saved value lands as that reference.
 */

import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { type ReactNode, useCallback, useRef, useState } from "react";
import {
	XPathField,
	type XPathFieldHandle,
} from "@/components/builder/XPathField";
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverTitle,
} from "@/components/shadcn/popover";
import {
	useExpressionEditorContext,
	useExpressionProjection,
	useParseProseValue,
} from "@/lib/doc/hooks/useXPathSlots";
import type { ProseAtomPart, ProseValuePart } from "@/lib/domain";
import type { ProseSlotRef } from "@/lib/domain/expression/types";

interface ProseValuePopoverProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	/** The text's slot: where the formula is parsed, linted, completed and checked. */
	readonly slot: ProseSlotRef;
	/** The value being edited. Absent for a new one. */
	readonly editing?: ProseValuePart;
	/** The part to insert, or to put in place of `editing`. */
	readonly onCommit: (part: ProseAtomPart) => void;
	/** Removes `editing`. The Remove button shows only while `editing` is set. */
	readonly onRemove: () => void;
	/** Where the popover opens: the reference picker's trigger. */
	readonly anchor?: Element | null;
	/** Attributes that mark the popover as part of the text's editing session,
	 *  so focus moving into it does not end the edit. */
	readonly sessionAttributes?: Readonly<Record<`data-${string}`, string>>;
}

/** A press on a CodeMirror tooltip or on the editor's own notice is portaled
 *  outside the popover; it is part of editing the formula, not a dismissal. */
function pressBelongsToEditor(
	details: PopoverPrimitive.Root.ChangeEventDetails,
): boolean {
	if (details.reason === "escape-key")
		return document.querySelector(".cm-tooltip-autocomplete") !== null;
	if (details.reason !== "outside-press") return false;
	const target = details.event.target;
	return (
		target instanceof Element &&
		target.closest(".cm-tooltip, [data-xpath-field-notice]") !== null
	);
}

export function ProseValuePopover({
	open,
	onOpenChange,
	slot,
	editing,
	onCommit,
	onRemove,
	anchor,
	sessionAttributes,
}: ProseValuePopoverProps): ReactNode {
	return (
		<Popover
			open={open}
			onOpenChange={(next, details) => {
				if (!next && pressBelongsToEditor(details)) return;
				onOpenChange(next);
			}}
		>
			<PopoverContent
				align="start"
				anchor={anchor}
				className="w-96"
				{...sessionAttributes}
			>
				<PopoverTitle>Calculated value</PopoverTitle>
				{open && (
					<ProseValueEditor
						slot={slot}
						editing={editing}
						onCommit={onCommit}
						onRemove={onRemove}
						onClose={() => onOpenChange(false)}
					/>
				)}
			</PopoverContent>
		</Popover>
	);
}

/** The popover's body, mounted only while it is open so each opening starts
 *  from the stored formula. */
function ProseValueEditor({
	slot,
	editing,
	onCommit,
	onRemove,
	onClose,
}: {
	readonly slot: ProseSlotRef;
	readonly editing: ProseValuePart | undefined;
	readonly onCommit: (part: ProseAtomPart) => void;
	readonly onRemove: () => void;
	readonly onClose: () => void;
}): ReactNode {
	const current = editing?.expression;
	const projection = useExpressionProjection(current, slot);
	const initial = current === undefined ? "" : projection.text;
	const [draft, setDraft] = useState(initial);
	const handle = useRef<XPathFieldHandle>(null);
	const parse = useParseProseValue(slot, current);
	const getEditorContext = useExpressionEditorContext(
		slot,
		undefined,
		undefined,
		current,
	);
	const committedRef = useRef(false);

	const save = useCallback(
		(text: string) => {
			if (!text.trim()) return { ok: false as const, messages: [EMPTY] };
			let part: ProseAtomPart;
			try {
				part = parse(text);
			} catch (error) {
				return {
					ok: false as const,
					messages: [error instanceof Error ? error.message : UNREADABLE],
				};
			}
			committedRef.current = true;
			onCommit(part);
			return undefined;
		},
		[parse, onCommit],
	);

	const empty = draft.trim().length === 0;
	return (
		<>
			<XPathField
				value={initial}
				onSave={save}
				getEditorContext={getEditorContext}
				autoEdit
				placeholder="A formula's result shows here"
				onDraftChange={setDraft}
				handleRef={handle}
				onEditingChange={(isEditing) => {
					// Escape in the editor ends the edit; the popover ends with it.
					if (!isEditing && !committedRef.current) onClose();
				}}
			/>
			<div className="flex flex-wrap items-center justify-end gap-2">
				{editing !== undefined && (
					<Button
						variant="ghost-destructive"
						data-xpath-field-action=""
						onMouseDown={(event) => event.preventDefault()}
						onClick={onRemove}
					>
						Remove
					</Button>
				)}
				<Button
					data-xpath-field-action=""
					disabled={empty}
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => handle.current?.save()}
				>
					{editing === undefined ? "Insert" : "Save"}
				</Button>
			</div>
		</>
	);
}

const EMPTY = "Write a formula before you insert it.";
const UNREADABLE =
	"This formula couldn't be read. You can check it and try again.";
