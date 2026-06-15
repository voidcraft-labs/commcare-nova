"use client";
import { Icon } from "@iconify/react/offline";
import tablerAlertHexagon from "@iconify-icons/tabler/alert-hexagon";
import { AnimatePresence, motion } from "motion/react";

/**
 * The one visual language for a refused commit, shared by every surface
 * that presents the validity gate's findings contextually: the floating
 * callout under an editable title, the inline notice under a text field,
 * the editor tooltips (`XPathField`, `FieldIdentitySection`), and the Connect
 * dialog footer.
 *
 * Tone rules, deliberately:
 * - The alert-hexagon icon + a short rose label carry the semantic ("the
 *   guardrail held this back") — rose is an accent, never the body.
 * - The finding itself renders in neutral text. The validator already
 *   speaks person-to-person prose; a wall of rose text reads as scolding,
 *   calm neutral reads as explanation.
 * - The user's draft is always still in the input when one of these
 *   shows (the `useCommitField` contract), so the label says "Not saved"
 *   — present state, not accusation.
 */

interface RejectionBodyProps {
	message: string;
	/**
	 * The short rose register line above the message. Defaults to
	 * "Not saved" (a bounced commit with the draft still in the input).
	 * Pass `null` for surfaces where a register line is noise — e.g. a
	 * live "can't save yet" reason that tracks typing.
	 */
	label?: string | null;
	/** Muted trailing hint, e.g. "Press Esc to discard changes". */
	hint?: string;
}

/** Icon + label + message anatomy, surface-agnostic. */
export function RejectionBody({
	message,
	label = "Not saved",
	hint,
}: RejectionBodyProps) {
	return (
		<div className="flex gap-2 text-left">
			<Icon
				icon={tablerAlertHexagon}
				width={14}
				height={14}
				className="mt-[3px] shrink-0 text-nova-rose"
			/>
			<div className="min-w-0">
				{label && (
					<p className="text-[11px] font-medium text-nova-rose leading-tight">
						{label}
					</p>
				)}
				<p
					className={`text-xs text-nova-text-secondary leading-relaxed ${label ? "mt-0.5" : ""}`}
				>
					{message}
				</p>
				{hint && (
					<p className="mt-1 text-[10px] text-nova-text-muted leading-tight">
						{hint}
					</p>
				)}
			</div>
		</div>
	);
}

/** The elevated-tier rejection surface (rose-accented variant of the
 *  L2 floating chrome in `lib/styles.ts`). */
export const REJECTION_SURFACE_CLS =
	"rounded-lg bg-[rgba(16,16,36,0.97)] border border-nova-rose/25 shadow-[inset_0_0_0_1px_rgba(255,200,220,0.06),0_8px_24px_rgba(0,0,0,0.5)]";

interface RejectionCalloutProps {
	/** The finding to show; `null` renders nothing (exit animation). */
	message: string | null;
	label?: string | null;
}

/**
 * Floating callout anchored below an inline editor that has no panel to
 * render into — editable titles on the preview screens. Rendered inside
 * the anchor's `relative` wrapper.
 *
 * `w-max` is load-bearing: an absolutely-positioned box computes its
 * shrink-to-fit width against the CONTAINING block (the title, often
 * ~100px wide), so without it `max-w-*` never engages and the message
 * wraps one word per line.
 */
export function RejectionCallout({ message, label }: RejectionCalloutProps) {
	return (
		<AnimatePresence>
			{message && (
				<motion.div
					role="alert"
					initial={{ opacity: 0, y: -4, scale: 0.98 }}
					animate={{ opacity: 1, y: 0, scale: 1 }}
					exit={{ opacity: 0, y: -2, scale: 0.98 }}
					transition={{ duration: 0.16, ease: "easeOut" }}
					className={`absolute left-0 top-full mt-2 z-popover w-max max-w-sm px-3 py-2.5 font-sans font-normal tracking-normal whitespace-normal ${REJECTION_SURFACE_CLS}`}
				>
					{/* Caret tying the callout to its input — same surface +
					 *  border so it reads as one shape. */}
					<span
						aria-hidden
						className="absolute -top-[5px] left-4 size-2.5 rotate-45 rounded-[2px] border-l border-t border-nova-rose/25 bg-[rgba(16,16,36,0.97)]"
					/>
					<RejectionBody message={message} label={label} />
				</motion.div>
			)}
		</AnimatePresence>
	);
}

interface RejectionInlineProps {
	/** The reason to show; `null` collapses the notice (exit animation). */
	message: string | null;
	label?: string | null;
	className?: string;
	/** DOM id for `aria-describedby` wiring from the input. */
	id?: string;
}

/**
 * In-flow rejection notice for panel and drawer fields — a soft
 * rose-tinted block that expands beneath the input instead of floating
 * over neighboring controls.
 */
export function RejectionInline({
	message,
	label,
	className = "",
	id,
}: RejectionInlineProps) {
	return (
		<AnimatePresence initial={false}>
			{message && (
				<motion.div
					role="alert"
					id={id}
					initial={{ opacity: 0, height: 0 }}
					animate={{ opacity: 1, height: "auto" }}
					exit={{ opacity: 0, height: 0 }}
					transition={{ duration: 0.16, ease: "easeOut" }}
					className="overflow-hidden"
				>
					<div
						className={`mt-1.5 rounded-md border border-nova-rose/15 bg-nova-rose/[0.06] px-2.5 py-2 ${className}`}
					>
						<RejectionBody message={message} label={label} />
					</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
