// components/builder/shared/primitives/BlurCommitTextInput.tsx
//
// Canonical blur-commit text primitive used by every text slot in
// the builder's section editors — column header inputs, id-mapping
// table cells, interval `text` labels, search-input name + label
// rows. The draft / commit handshake:
//
//   - Local `draft` state holds the in-flight edit so peer
//     re-renders (parent's onChange propagating elsewhere, sibling
//     rows mounting / unmounting) don't reset the user's text
//     mid-edit.
//   - `onCommit` fires on blur or Enter with the latest draft; the
//     parent converts the string into the AST shape it wants. Escape
//     reverts the draft to the last committed value.
//   - The draft re-syncs to the external `value` only when the
//     input itself is NOT focused — comparing the input's own ref
//     against `document.activeElement` (rather than a tag-only
//     check) keeps a peer input's focus from blocking a re-sync of
//     this one.
//   - The no-op gate (`draft === value`) suppresses redundant
//     emits on focus / blur pulses without typing.
//
// `monospace` adds the `font-mono` class for code-shaped values
// (id-mapping value cells, search-input names); the chrome /
// padding / focus ring stay identical between modes so a polish
// pass to the visual style lands in one place.

"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "@/components/shadcn/input";

interface BlurCommitTextInputProps {
	readonly value: string;
	readonly onCommit: (next: string) => void;
	readonly placeholder?: string;
	readonly ariaLabel: string;
	/**
	 * Render the input with `font-mono` for code-shaped values. The
	 * monospace class is the only visual difference between the
	 * column-header input (variable-width text) and the id-mapping
	 * value cell (a wire-form code) — sharing the rest of the
	 * chrome keeps polish-passes on padding / border / focus ring
	 * applied uniformly.
	 */
	readonly monospace?: boolean;
}

/**
 * Blur-committed text input. Local draft state, no commit until
 * blur, no-op gate on unchanged text. The variants vary only on
 * `font-mono` — every other class is identical, so a polish-pass
 * fix lands in one place.
 */
export function BlurCommitTextInput({
	value,
	onCommit,
	placeholder,
	ariaLabel,
	monospace = false,
}: BlurCommitTextInputProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [draft, setDraft] = useState(value);
	useEffect(() => {
		if (value !== draft && document.activeElement !== inputRef.current) {
			setDraft(value);
		}
	}, [value, draft]);
	const commit = useCallback(() => {
		if (draft === value) return;
		onCommit(draft);
	}, [draft, value, onCommit]);
	/* Enter commits and Escape reverts — the same keyboard contract
	 * `useCommitField` gives every other text slot in the builder, so
	 * one input never feels different from its neighbors. Both stop
	 * propagation so the workspace-level Escape (close inspector) and
	 * any enclosing form don't also fire. */
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				e.stopPropagation();
				commit();
			}
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				setDraft(value);
			}
		},
		[commit, value],
	);
	const cls = [
		"h-auto min-h-11 w-full rounded-lg border-white/[0.06] bg-nova-deep/50 px-3 text-sm text-nova-text placeholder:text-nova-text-muted focus-visible:border-nova-violet/40 focus-visible:ring-nova-violet/30 md:text-sm dark:bg-nova-deep/50",
		monospace ? "font-mono" : "",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<Input
			ref={inputRef}
			type="text"
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			onKeyDown={handleKeyDown}
			autoComplete="off"
			data-1p-ignore
			placeholder={placeholder}
			aria-label={ariaLabel}
			className={cls}
		/>
	);
}
