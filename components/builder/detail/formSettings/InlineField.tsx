"use client";
import { useId } from "react";
import { SavedCheck } from "@/components/builder/EditableTitle";
import { useCommitField } from "@/lib/ui/hooks/useCommitField";

/**
 * Compact labeled text field used inside the form settings panel. Shares
 * the same commit / cancel / saved-indicator model as EditableText via
 * `useCommitField`: blur or Enter commits, Escape cancels (with
 * stopPropagation so popovers stay open), and an emerald checkmark
 * animates in the label for ~1.5 s after a successful save.
 *
 * Renders `<input type="text" | "number">` or `<textarea>` depending on
 * whether `multiline` is set. The `mono` flag switches to a violet
 * monospace font for id-style values; `suffix` renders a trailing badge
 * (e.g. "min") inside the input with inner padding.
 */
export function InlineField({
	label,
	value,
	onChange,
	validate,
	mono,
	multiline,
	placeholder,
	suffix,
	type = "text",
	required,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	/**
	 * Optional field-level validity check. Return a human-readable reason
	 * to reject the value, or `null` when it's valid. A non-null result
	 * blocks the commit (the value reverts, `onChange` never fires) AND
	 * renders the reason inline while the field is focused — a visible
	 * "can't save, here's why" rather than a silent revert. Mirrors how the
	 * builder blocks invalid XPath at the field. Absent → unchanged.
	 */
	validate?: (value: string) => string | null;
	mono?: boolean;
	multiline?: boolean;
	placeholder?: string;
	suffix?: string;
	type?: string;
	required?: boolean;
}) {
	const fieldId = useId();
	const {
		draft,
		setDraft,
		focused,
		saved,
		ref,
		handleFocus,
		handleBlur,
		handleKeyDown,
	} = useCommitField({
		value,
		onSave: onChange,
		// `useCommitField` aborts the commit when `validate` returns false, so
		// adapt the reason-returning predicate to a boolean: valid ⇔ no reason.
		validate: validate ? (v) => validate(v) === null : undefined,
		required,
		multiline,
	});

	// Compute the reason against the in-progress draft so the message
	// tracks what the user is typing. Only surfaced while focused — at rest
	// the field shows the persisted (valid) value, so no error chrome lingers.
	const reason = validate && focused ? validate(draft) : null;

	// `aria-describedby` ties the message to the input for assistive tech;
	// only set when a reason is actually showing.
	const reasonId = `${fieldId}-error`;

	const Tag = multiline ? "textarea" : "input";

	return (
		<div>
			<label
				htmlFor={fieldId}
				className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-0.5 flex items-center gap-0.5"
			>
				{label}
				{required && <span className="text-nova-rose ml-0.5">*</span>}
				<SavedCheck
					visible={saved && !focused}
					size={10}
					className="shrink-0"
				/>
			</label>
			<div className="relative">
				<Tag
					id={fieldId}
					ref={ref as React.RefCallback<HTMLInputElement & HTMLTextAreaElement>}
					type={type === "number" ? "number" : "text"}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onFocus={handleFocus}
					onBlur={handleBlur}
					onKeyDown={handleKeyDown}
					placeholder={placeholder}
					autoComplete="off"
					data-1p-ignore
					rows={multiline ? 2 : undefined}
					min={type === "number" ? 1 : undefined}
					aria-invalid={reason ? true : undefined}
					aria-describedby={reason ? reasonId : undefined}
					className={`w-full text-xs px-2 py-1.5 rounded-md border transition-colors outline-none resize-none ${
						mono ? "font-mono text-nova-violet-bright" : "text-nova-text"
					} ${
						reason
							? "bg-nova-surface border-nova-rose/60 shadow-[0_0_0_1px_rgba(244,63,94,0.15)]"
							: focused
								? "bg-nova-surface border-nova-violet/50 shadow-[0_0_0_1px_rgba(139,92,246,0.1)]"
								: "bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30"
					} ${suffix ? "pr-8" : ""}`}
				/>
				{suffix && (
					<span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-nova-text-muted pointer-events-none">
						{suffix}
					</span>
				)}
			</div>
			{reason && (
				<p id={reasonId} className="mt-0.5 text-[10px] text-nova-rose">
					{reason}
				</p>
			)}
		</div>
	);
}
