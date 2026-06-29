"use client";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef } from "react";
import { RejectionCallout } from "@/components/builder/RejectionNotice";
import type { CommitOutcome } from "@/lib/domain";
import { useCanEdit } from "@/lib/session/hooks";
import { useCommitField } from "@/lib/ui/hooks/useCommitField";
import { useRejectionShake } from "@/lib/ui/hooks/useShake";

// Shared className constants — single source of truth for the typographic and box-model
// properties that must be identical across the readOnly and editable render paths.
// Any divergence here would produce a layout shift when toggling between design/preview.
const MEASURE_SPAN_CLASS =
	"text-lg font-display font-semibold px-1 border border-transparent absolute invisible whitespace-pre";
const INPUT_BASE_CLASS =
	"text-lg font-display font-semibold outline-none rounded px-1 -mx-1 border text-nova-text";

interface EditableTitleProps {
	value: string;
	/**
	 * Commit the trimmed title. Returning the gated dispatch's
	 * `CommitOutcome` lets a refused rename keep the editor open with the
	 * draft and surface the finding inline (the `useCommitField` contract);
	 * a `void` return reads as committed. Optional when `readOnly` is true.
	 */
	onSave?: (value: string) => CommitOutcome | undefined;
	/**
	 * When true, renders the input non-interactively using the exact same element
	 * and box model as the editable version. This ensures pixel-perfect flipbook
	 * consistency when switching between design and preview modes — no layout shift.
	 */
	readOnly?: boolean;
}

/**
 * Inline editable title — renders an input that looks like an h2 when unfocused.
 * Click to edit, Enter/blur to save, Escape to cancel.
 * Uses a hidden span mirror to size the input exactly to its content.
 *
 * Commit/cancel/checkmark behavior comes from `useCommitField` — the same
 * model every inline editor in the builder uses — so a commit the validity
 * gate refuses restores editing with the draft intact, shows the finding
 * inline below the input, and never fires the saved checkmark. The
 * checkmark renders here (driven by the hook's `saved` window) rather than
 * via a parent callback, so a parent can't animate "saved" for a rename
 * that never committed.
 *
 * Pass `readOnly` to render the same element in a frozen, non-interactive state —
 * used by preview mode so the title occupies identical space to the design-mode input.
 */
export function EditableTitle({ value, onSave, readOnly }: EditableTitleProps) {
	const canEdit = useCanEdit();
	const measureRef = useRef<HTMLSpanElement>(null);
	const inputElRef = useRef<HTMLInputElement | null>(null);

	const syncWidth = useCallback(() => {
		if (measureRef.current && inputElRef.current) {
			inputElRef.current.style.width = `${measureRef.current.scrollWidth + 4}px`;
		}
	}, []);

	const {
		draft,
		setDraft,
		focused,
		saved,
		rejection,
		rejectionNonce,
		ref: hookRef,
		handleFocus,
		handleBlur,
		handleKeyDown,
	} = useCommitField({
		value,
		onSave: onSave ?? (() => undefined),
		// Committing an empty title reverts to the previous value — a screen
		// title must never blank out an entity's display name.
		required: true,
		selectAll: false,
	});
	const shakeProps = useRejectionShake(rejectionNonce);

	const setInputRef = useCallback(
		(el: HTMLInputElement | null) => {
			hookRef(el);
			inputElRef.current = el;
			syncWidth();
		},
		[hookRef, syncWidth],
	);

	// Read-only path: same element and box model as the editable input, just frozen.
	// Using the identical span+input structure guarantees pixel-perfect alignment
	// with design mode — no layout shift when flipping between modes. A view-only
	// Project member (`!canEdit`) renders this same frozen title in BOTH modes.
	if (readOnly || !canEdit) {
		return (
			<>
				<span
					ref={(el) => {
						measureRef.current = el;
						syncWidth();
					}}
					className={MEASURE_SPAN_CLASS}
					aria-hidden
				>
					{value || "\u00A0"}
				</span>
				<input
					ref={setInputRef}
					value={value}
					readOnly
					className={`${INPUT_BASE_CLASS} border-transparent bg-transparent pointer-events-none`}
					autoComplete="off"
					data-1p-ignore
				/>
			</>
		);
	}

	return (
		<span className="relative inline-flex items-center gap-2 min-w-0">
			{/* Hidden span that mirrors the input text for pixel-accurate width measurement */}
			<span
				ref={(el) => {
					measureRef.current = el;
					syncWidth();
				}}
				className={MEASURE_SPAN_CLASS}
				aria-hidden
			>
				{draft || "\u00A0"}
			</span>
			<input
				ref={setInputRef}
				value={draft}
				onChange={(e) => {
					setDraft(e.target.value);
					requestAnimationFrame(syncWidth);
				}}
				onFocus={handleFocus}
				onBlur={handleBlur}
				onKeyDown={handleKeyDown}
				onClick={(e) => e.stopPropagation()}
				onAnimationEnd={shakeProps.onAnimationEnd}
				className={`${INPUT_BASE_CLASS} transition-colors min-w-0 ${shakeProps.className} ${
					focused
						? rejection
							? "border-nova-rose/60 bg-nova-surface"
							: "border-nova-violet/60 bg-nova-surface"
						: "border-transparent cursor-text hover:border-nova-border bg-transparent"
				}`}
				autoComplete="off"
				data-1p-ignore
			/>
			<SavedCheck visible={saved && !focused} />
			{/* The validity gate refused the rename — the draft is still in
			 * the input (useCommitField restored editing); the callout tells
			 * the user what to fix, in the rule's own words. Floats below so
			 * the header row's layout never jumps. */}
			<RejectionCallout message={rejection} />
		</span>
	);
}

/** Animated emerald checkmark shown after a successful save. */
export function SavedCheck({
	visible,
	size = 16,
	className = "shrink-0 -ml-1",
}: {
	visible: boolean;
	size?: number;
	className?: string;
}) {
	return (
		<AnimatePresence>
			{visible && (
				<motion.span
					initial={{ opacity: 0, scale: 0.8 }}
					animate={{ opacity: 1, scale: 1 }}
					exit={{ opacity: 0, scale: 0.8 }}
					transition={{ duration: 0.2 }}
					className={className}
				>
					<Icon
						icon={tablerCheck}
						width={size}
						height={size}
						className="text-nova-emerald"
					/>
				</motion.span>
			)}
		</AnimatePresence>
	);
}
