// components/builder/inspector/OptionalTextRow.tsx
//
// One row primitive for optional single-line text slots in any
// right-rail inspector: label chrome, hint line, blur-commit handshake,
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
import { Input } from "@/components/shadcn/input";
import { useCommitField } from "@/lib/ui/hooks/useCommitField";
import { INSPECTOR_INPUT_CLS, INSPECTOR_LABEL_CLS } from "./inspectorChrome";

interface OptionalTextRowProps {
	readonly label: string;
	readonly hint: string;
	readonly value: string | undefined;
	readonly onCommit: (next: string | undefined) => void;
	readonly placeholder?: string;
	/** Optional person-facing limit for concise action labels. This is checked
	 * by grapheme rather than UTF-16 code unit, so emoji and accented letters
	 * count the way people expect. The input remains editable and explains the
	 * problem instead of silently truncating saved copy. */
	readonly maxGraphemes?: number;
}

const graphemeSegmenter =
	typeof Intl.Segmenter === "function"
		? new Intl.Segmenter(undefined, { granularity: "grapheme" })
		: null;

function graphemeCount(value: string): number {
	return graphemeSegmenter === null
		? Array.from(value).length
		: Array.from(graphemeSegmenter.segment(value)).length;
}

export function OptionalTextRow({
	label,
	hint,
	value,
	onCommit,
	placeholder,
	maxGraphemes,
}: OptionalTextRowProps) {
	const inputId = useId();
	const helperId = useId();
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
	const {
		draft,
		setDraft,
		ref,
		handleFocus,
		handleBlur,
		handleKeyDown,
		rejection,
	} = useCommitField({
		value: value ?? "",
		onSave: (next) => {
			if (maxGraphemes !== undefined && graphemeCount(next) > maxGraphemes) {
				return {
					ok: false,
					messages: [`Keep the label to ${maxGraphemes} characters or fewer`],
				};
			}
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
			<label htmlFor={inputId} className={INSPECTOR_LABEL_CLS}>
				{label}
			</label>
			<Input
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
				aria-describedby={helperId}
				aria-invalid={rejection !== null || undefined}
				className={`${INSPECTOR_INPUT_CLS} h-auto md:text-[14px] dark:bg-nova-deep/50`}
			/>
			<span
				id={helperId}
				role={rejection === null ? undefined : "alert"}
				className={`text-[13px] leading-relaxed ${rejection === null ? "text-nova-text-muted" : "text-nova-rose"}`}
			>
				{rejection ?? hint}
			</span>
		</div>
	);
}
