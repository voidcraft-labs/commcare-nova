"use client";
import { useCallback, useId } from "react";
import { SavedCheck } from "@/components/builder/EditableTitle";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import type { CommitOutcome } from "@/lib/domain";
import { useCommitField } from "@/lib/ui/hooks/useCommitField";
import { useRejectionShake } from "@/lib/ui/hooks/useShake";

interface EditableTextProps {
	label: string;
	value: string;
	/** Commit the trimmed value. Returning the gated dispatch's
	 *  `CommitOutcome` lets a refused edit keep the draft + show the
	 *  finding inline (see `useCommitField`); `void` reads as committed. */
	onSave: (value: string) => CommitOutcome | undefined;
	onEmpty?: () => void;
	mono?: boolean;
	color?: string;
	placeholder?: string;
	multiline?: boolean;
	autoFocus?: boolean;
	selectAll?: boolean;
	/** Content rendered right-aligned in the label row (e.g. a toggle). */
	labelRight?: React.ReactNode;
	/** Undo/redo scroll + flash target — placed on the input element so
	 *  the flash highlights only the control, not the label above it. */
	dataFieldId?: string;
}

export function EditableText({
	label,
	value,
	onSave,
	onEmpty,
	mono,
	color,
	placeholder,
	multiline,
	autoFocus,
	selectAll,
	labelRight,
	dataFieldId,
}: EditableTextProps) {
	const fieldId = useId();
	const {
		draft,
		setDraft,
		focused,
		saved,
		rejection,
		rejectionNonce,
		ref,
		handleFocus,
		handleBlur,
		handleKeyDown,
	} = useCommitField({
		value,
		onSave,
		onEmpty,
		multiline,
		selectAll,
	});
	const shakeProps = useRejectionShake(rejectionNonce);

	// Callback ref wrapping the hook's ref so we can also drive imperative
	// focus on mount. The programmatic `.focus()` triggers React's onFocus,
	// which routes through `handleFocus` from `useCommitField`; that's where
	// the `selectAll` branch lives. This ref only handles the caret-at-end
	// placement for the non-selectAll path, since the hook doesn't address
	// it.
	const setInputRef = useCallback(
		(el: HTMLInputElement | HTMLTextAreaElement | null) => {
			ref(el);
			if (el && autoFocus) {
				el.focus({ preventScroll: true });
				if (!selectAll) el.setSelectionRange(el.value.length, el.value.length);
			}
		},
		[ref, autoFocus, selectAll],
	);

	const fontClass = mono ? "font-mono" : "";
	const baseCls = `w-full text-sm ${fontClass} rounded-md px-2 py-1.5 border outline-none transition-colors ${shakeProps.className}`;
	const focusedCls = `${baseCls} bg-nova-surface text-nova-text ${
		rejection
			? "border-nova-rose/60 shadow-[0_0_0_1px_rgba(212,112,143,0.12)]"
			: "border-nova-violet/50 shadow-[0_0_0_1px_rgba(139,92,246,0.1)]"
	}`;
	const unfocusedCls = `${baseCls} bg-nova-deep/50 border-white/[0.06] cursor-text ${color || ""} ${!draft && placeholder ? "text-nova-text-muted italic" : "font-medium"} hover:border-nova-violet/30`;
	const cls = focused ? focusedCls : unfocusedCls;

	const lineCount = multiline ? draft.split("\n").length : 1;
	const rows = multiline
		? Math.min(Math.max(lineCount, 1), 4)
		: focused
			? Math.max(lineCount, 2)
			: Math.max(lineCount, 1);

	return (
		<div>
			<label
				htmlFor={fieldId}
				className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 flex items-center gap-1.5"
			>
				{label}
				<SavedCheck
					visible={saved && !focused}
					size={12}
					className="shrink-0"
				/>
				{focused && multiline && <SaveShortcutHint />}
				{labelRight}
			</label>
			{multiline ? (
				<textarea
					id={fieldId}
					ref={setInputRef as React.RefCallback<HTMLTextAreaElement>}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onFocus={handleFocus}
					onBlur={handleBlur}
					onKeyDown={handleKeyDown}
					onAnimationEnd={shakeProps.onAnimationEnd}
					className={`${cls} resize-none`}
					rows={rows}
					placeholder={placeholder}
					autoComplete="off"
					data-1p-ignore
					data-field-id={dataFieldId}
				/>
			) : (
				<input
					id={fieldId}
					ref={setInputRef as React.RefCallback<HTMLInputElement>}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onFocus={handleFocus}
					onBlur={handleBlur}
					onKeyDown={handleKeyDown}
					onAnimationEnd={shakeProps.onAnimationEnd}
					className={cls}
					placeholder={placeholder}
					autoComplete="off"
					data-1p-ignore
					data-field-id={dataFieldId}
				/>
			)}
			{/* The validity gate refused the last commit — the draft is still
			 * in the input (useCommitField restored editing); the notice tells
			 * the user what to fix, in the rule's own words. */}
			<RejectionInline message={rejection} />
		</div>
	);
}
