// components/builder/case-list-config/inspector/OptionalTextRow.tsx
//
// One row primitive for optional single-line text slots in the
// inspector: label chrome, hint line, blur-commit handshake,
// empty-clears normalization. Markdown slots use the WYSIWYG
// OptionalMarkdownRow instead.
//
// Empty-string-clears comes from `useCommitField`'s `onEmpty`
// callback — when the user empties the input and blurs, the hook
// fires `onEmpty()` rather than `onSave("")`. The row converts
// that to `onCommit(undefined)` so the parent's strict-parse drops
// the key on the next mount. `useCommitField` also `trim()`s before
// commit, which means a value of `"   "` round-trips to "empty" —
// the right behavior for label slots where surrounding whitespace
// is a typo, not intent.

"use client";
import { useId } from "react";
import { useCommitField } from "@/lib/ui/hooks/useCommitField";

interface OptionalTextRowProps {
	readonly label: string;
	readonly hint: string;
	readonly value: string | undefined;
	readonly onCommit: (next: string | undefined) => void;
	readonly placeholder?: string;
}

export function OptionalTextRow({
	label,
	hint,
	value,
	onCommit,
	placeholder,
}: OptionalTextRowProps) {
	const inputId = useId();
	// Convert `string | undefined` ↔ `string` at the hook boundary.
	// `useCommitField` requires a defined `value: string`, pairs
	// `onSave` with `onEmpty: () -> void` for the "empty commit" path,
	// and expects `onSave` to return the gated `CommitOutcome` (an
	// `ok: false` keeps the draft + shows the finding inline). These
	// slots are non-refusable display strings (search screen title /
	// button label — no validator rule rejects them, unlike an entity
	// name), so the commit always lands: returning `undefined` reads as
	// committed, the honest outcome here.
	//
	// The `onEmpty` arm gates on `value !== undefined`. When the slot
	// started absent, an empty commit (focus-blur without typing,
	// Esc on an empty input) has nothing to clear — emitting
	// `onCommit(undefined)` would transition the parent config from
	// absent to `{}`, persisting an empty config and writing an
	// undo-history entry the user never asked for.
	const { draft, setDraft, ref, handleFocus, handleBlur, handleKeyDown } =
		useCommitField({
			value: value ?? "",
			onSave: (next) => {
				onCommit(next);
				return undefined;
			},
			onEmpty: () => {
				if (value !== undefined) {
					onCommit(undefined);
				}
			},
		});

	return (
		<div className="flex flex-col gap-1.5">
			<label
				htmlFor={inputId}
				className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted"
			>
				{label}
			</label>
			<input
				id={inputId}
				ref={ref as React.RefCallback<HTMLInputElement>}
				type="text"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onFocus={handleFocus}
				onBlur={handleBlur}
				onKeyDown={handleKeyDown}
				autoComplete="off"
				data-1p-ignore
				placeholder={placeholder}
				className="w-full min-h-11 px-3 text-[13px] rounded-lg border border-white/[0.06] bg-nova-deep/50 text-nova-text placeholder:text-nova-text-muted/60 focus:outline-none focus:ring-1 focus:border-nova-violet/40 focus:ring-nova-violet/30 transition-colors"
			/>
			<span className="text-[11px] leading-relaxed text-nova-text-muted">
				{hint}
			</span>
		</div>
	);
}
