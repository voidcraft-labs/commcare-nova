// components/builder/case-list-config/inspector/OptionalTextRow.tsx
//
// One row primitive for optional text slots in the inspector. Two
// layout variants vary on the textarea-vs-input flag and the
// presence of a markdown live preview; the rest (label chrome, hint
// line, blur-commit handshake, empty-clears normalization) is
// identical across every text row.
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
import { PreviewMarkdown } from "@/lib/markdown";
import { useCommitField } from "@/lib/ui/hooks/useCommitField";

interface OptionalTextRowProps {
	readonly label: string;
	readonly hint: string;
	readonly value: string | undefined;
	readonly onCommit: (next: string | undefined) => void;
	readonly placeholder?: string;
	/** When `true`, the row renders a `<textarea>` + a "Markdown"
	 *  badge + a live `<PreviewMarkdown />` panel beneath. When
	 *  `false` (default), the row renders a single-line
	 *  `<input type="text">` with no preview. */
	readonly markdown?: boolean;
}

export function OptionalTextRow({
	label,
	hint,
	value,
	onCommit,
	placeholder,
	markdown = false,
}: OptionalTextRowProps) {
	const inputId = useId();
	// Convert `string | undefined` ↔ `string` at the hook boundary.
	// `useCommitField` requires a defined `value: string` and pairs
	// `onSave: string -> void` with `onEmpty: () -> void` for the
	// "empty commit" path — exactly the empty-string-clears semantic
	// the schema's `optional()` slots want.
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
			onSave: (next) => onCommit(next),
			onEmpty: () => {
				if (value !== undefined) {
					onCommit(undefined);
				}
			},
			multiline: markdown,
		});

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-2">
				<label
					htmlFor={inputId}
					className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted"
				>
					{label}
				</label>
				{markdown ? (
					// Markdown affordance badge — without it the textarea
					// looks identical to the plain-text rows and the
					// author has no way to tell this slot accepts
					// formatting.
					<span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider rounded bg-nova-violet/15 text-nova-violet-bright/90 border border-nova-violet/20">
						Markdown
					</span>
				) : null}
			</div>
			{markdown ? (
				<textarea
					id={inputId}
					ref={ref as React.RefCallback<HTMLTextAreaElement>}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onFocus={handleFocus}
					onBlur={handleBlur}
					onKeyDown={handleKeyDown}
					autoComplete="off"
					data-1p-ignore
					placeholder={placeholder}
					rows={3}
					className="w-full px-3 py-2.5 text-[13px] rounded-lg border border-white/[0.06] bg-nova-deep/50 text-nova-text placeholder:text-nova-text-muted/60 focus:outline-none focus:ring-1 focus:border-nova-violet/40 focus:ring-nova-violet/30 transition-colors resize-none"
				/>
			) : (
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
			)}
			<span className="text-[11px] leading-relaxed text-nova-text-muted">
				{hint}
			</span>
			{markdown && draft.trim().length > 0 ? (
				// Live preview of the markdown the author is typing.
				// Visual-only — the textarea above carries the
				// accessible name from its `<label>`, so the preview
				// node itself doesn't need its own aria attributes.
				<div className="rounded-md border border-white/[0.04] bg-nova-surface/30 p-2 preview-markdown text-xs text-nova-text-muted">
					<PreviewMarkdown>{draft}</PreviewMarkdown>
				</div>
			) : null}
		</div>
	);
}
