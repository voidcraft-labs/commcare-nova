"use client";
import { useId } from "react";
import { SavedCheck } from "@/components/builder/EditableTitle";
import { useCommitField } from "@/hooks/useCommitField";

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
		required,
		multiline,
	});

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
					className={`w-full text-xs px-2 py-1.5 rounded-md border transition-colors outline-none resize-none ${
						mono ? "font-mono text-nova-violet-bright" : "text-nova-text"
					} ${
						focused
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
		</div>
	);
}
