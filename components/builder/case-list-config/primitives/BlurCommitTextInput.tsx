// components/builder/case-list-config/primitives/BlurCommitTextInput.tsx
//
// Shared blur-commit text input. The canonical draft / commit
// handshake used by every text slot in the case-list-config
// editor:
//
//   - Local `draft` state holds the in-flight edit so peer
//     re-renders (parent's onChange propagating elsewhere, sibling
//     rows mounting / unmounting) don't reset the user's text
//     mid-edit.
//   - `onCommit` fires on blur with the latest draft; the parent
//     converts the string into the AST shape it wants.
//   - The draft re-syncs to the external `value` only when the
//     input itself is NOT focused — comparing the input's own ref
//     against `document.activeElement` (rather than a tag-only
//     check) keeps a peer input's focus from blocking a re-sync of
//     this one.
//   - The no-op gate (`draft === value`) suppresses redundant
//     emits on focus / blur pulses without typing.
//
// One primitive replaces three near-duplicates that were
// drifting in lockstep — column-card header inputs,
// id-mapping table cells, time-since/late-flag display labels.
// `monospace` adds the `font-mono` class for code-shaped values
// (id-mapping value cells, mapping codes); the chrome / padding
// / focus ring stay identical between modes.

"use client";
import { useCallback, useEffect, useRef, useState } from "react";

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
	const cls = [
		"w-full px-2 py-1.5 text-xs rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-text placeholder:text-nova-text-muted/60 focus:outline-none focus:ring-1 focus:border-nova-violet/40 focus:ring-nova-violet/30 transition-colors",
		monospace ? "font-mono" : "",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<input
			ref={inputRef}
			type="text"
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			autoComplete="off"
			data-1p-ignore
			placeholder={placeholder}
			aria-label={ariaLabel}
			className={cls}
		/>
	);
}
