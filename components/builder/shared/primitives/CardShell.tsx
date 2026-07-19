// components/builder/shared/primitives/CardShell.tsx
//
// Shared chrome for every predicate card: header (icon + label +
// optional remove action), body slot, and inline-error footer. The
// shell never reaches into the AST itself — it's purely a visual
// container the per-kind cards compose around their own body.
//
// Visual language: a glass-tinted rounded container with a hairline
// border and a violet accent strip on the label — the frosted-card
// surface the predicate / detail panels share. Cards stack vertically
// inside their parent group; reorder drag uses pragmatic-drag-and-drop
// and presents through the optional `dragHandleProps` slot.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerTrash from "@iconify-icons/tabler/trash";
import type { KeyboardEvent, ReactNode } from "react";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { removeAndRestoreFocus } from "../focusAfterRemoval";
import type { ReorderKeyboardKey } from "../useReorderableList";

function isReorderKeyboardKey(key: string): key is ReorderKeyboardKey {
	return (
		key === "ArrowUp" || key === "ArrowDown" || key === "Home" || key === "End"
	);
}

function handleReorderKey(
	event: KeyboardEvent<HTMLButtonElement>,
	onMove: ((key: ReorderKeyboardKey) => void) | undefined,
) {
	if (onMove === undefined || !isReorderKeyboardKey(event.key)) return;
	event.preventDefault();
	onMove(event.key);
}

interface RemoveConditionButtonProps {
	readonly onClick: () => void;
	readonly label?: string;
	readonly className?: string;
}

/**
 * One shared condition-removal affordance. The outer shadcn Button keeps a
 * full 44px target and focus ring; the smaller inner surface keeps the hover
 * treatment visually quiet instead of turning that whole target into a
 * block. Row-shaped cards position this target inside their own padding.
 */
function RemoveConditionButton({
	onClick,
	label = "Delete condition",
	className = "",
}: RemoveConditionButtonProps) {
	return (
		<SimpleTooltip content={label}>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				onClick={(event) => removeAndRestoreFocus(event.currentTarget, onClick)}
				aria-label={label}
				data-removal-action
				className={`size-11 rounded-lg text-nova-text-muted not-disabled:hover:bg-nova-rose/[0.08] not-disabled:hover:text-nova-rose ${className}`}
			>
				<Icon icon={tablerTrash} width="16" height="16" />
			</Button>
		</SimpleTooltip>
	);
}

interface CardShellProps {
	/** Imported `IconifyIcon` data — drives the leading icon. */
	readonly icon: IconifyIcon;
	/** Human-readable kind label rendered next to the icon. */
	readonly label: string;
	/**
	 * Optional ribbon variant — `"normal"` (default) renders the
	 * standard glass surface; `"nested"` shifts the violet accent up
	 * for cards inside a group's clause list so the parent group's
	 * accent doesn't fight the child's.
	 */
	readonly variant?: "normal" | "nested";
	/**
	 * Optional ref-callback the parent's draggable() hook installs
	 * for native-DOM drag binding. When undefined, the grip handle
	 * doesn't render.
	 */
	readonly dragHandleRef?: (el: HTMLElement | null) => void;
	/** Keyboard alternative for a visible drag handle. */
	readonly onMove?: (key: ReorderKeyboardKey) => void;
	/** Position-aware accessible name supplied by the list owner. */
	readonly reorderLabel?: string;
	/**
	 * Optional remove handler — when provided, a direct remove control appears.
	 * Cards inside an `and` / `or` group's clause
	 * list and cards under a `not` / `when-input-present` / `exists`
	 * wrapper get a delete affordance; standalone top-level cards omit it
	 * unless their parent is itself a visible condition list.
	 */
	readonly onRemove?: () => void;
	readonly removeLabel?: string;
	/** Optional kind-name override displayed in error toasts / labels. */
	readonly kindAccent?: ReactNode;
	/** Inline diagnostics to render at the card's footer (one row each). */
	readonly errors?: readonly string[];
	/** Optional action row that remains visually inside this card. */
	readonly footerAction?: ReactNode;
	readonly children: ReactNode;
}

/**
 * Card shell — header + body + footer-error rendering.
 *
 * The card surface is the shared frosted-card look (rounded, frosted
 * violet-tinted background, hairline border) so the predicate editor
 * reads as the same surface family. Cards
 * surface inline diagnostics at the bottom of the body — the type
 * checker's verdict for the card's own path lands here, with
 * per-slot errors rendering inside the body's own input chrome.
 */
export function CardShell({
	icon,
	label,
	variant = "normal",
	dragHandleRef,
	onMove,
	reorderLabel,
	onRemove,
	removeLabel,
	kindAccent,
	errors,
	footerAction,
	children,
}: CardShellProps) {
	const hasErrors = errors !== undefined && errors.length > 0;

	const surfaceCls = [
		"group/card @container relative rounded-md border px-3 py-2.5 transition-colors",
		variant === "nested" ? "bg-nova-surface/30" : "bg-nova-surface/40",
		hasErrors
			? "border-nova-rose/35 shadow-[inset_0_0_0_1px_rgba(255,90,120,0.12)]"
			: "border-white/[0.04]",
	].join(" ");

	return (
		<div className={surfaceCls} data-removal-card>
			{/* Header: drag handle + icon + label + remove action. The handle is a
			 *  thin grip indicator on the leading edge; clicking it does
			 *  nothing (the native drag binding intercepts the press). */}
			<div className="flex items-center gap-2 mb-2">
				{dragHandleRef !== undefined && (
					// `dragHandleRef` is a stable ref-callback (the
					// caller's `setHandleEl` from useState — identity
					// preserved across renders), so it's passed through
					// directly. Wrapping in a fresh-each-render arrow
					// would force React 19 to detach + re-attach the
					// ref every render.
					<SimpleTooltip
						content={
							onMove === undefined
								? "Drag to reorder"
								: "Drag or use arrow keys"
						}
					>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							ref={dragHandleRef}
							aria-label={reorderLabel ?? "Drag to reorder"}
							aria-keyshortcuts={
								onMove === undefined ? undefined : "ArrowUp ArrowDown Home End"
							}
							onKeyDown={(event) => handleReorderKey(event, onMove)}
							className="size-11 cursor-grab rounded-md text-nova-text-muted not-disabled:hover:bg-white/[0.04] not-disabled:hover:text-nova-text"
						>
							<Icon icon={tablerGripVertical} width="16" height="16" />
						</Button>
					</SimpleTooltip>
				)}
				<div className="w-0.5 h-3 rounded-full bg-nova-violet/40" />
				<Icon
					icon={icon}
					width="14"
					height="14"
					className="text-nova-violet-bright"
				/>
				<span className="text-sm font-medium text-nova-text-secondary">
					{label}
				</span>
				{kindAccent !== undefined && (
					<span className="ml-1 text-xs text-nova-text-muted">
						{kindAccent}
					</span>
				)}
				<div className="flex-1" />
				{onRemove !== undefined && (
					<RemoveConditionButton onClick={onRemove} label={removeLabel} />
				)}
			</div>

			{/* Body — per-card content. Cards lay out their inputs
			 *  directly (no nested wrapper) so they can compose
			 *  arbitrary grids / rows without the shell imposing
			 *  layout. */}
			<div className="space-y-2">{children}</div>
			{footerAction !== undefined ? (
				<div className="mt-3 flex justify-end border-t border-white/[0.05] pt-2">
					{footerAction}
				</div>
			) : null}

			{/* Footer — operator-level diagnostics (e.g.
			 *  "between has lower > upper", "gt requires ordered
			 *  types"). Per-slot diagnostics render adjacent to their
			 *  input via `InlineError` below. The message string is a
			 *  safe React key here — `buildValidityIndex`
			 *  deduplicates per path on the way in (so the exact-match
			 *  `useEditorErrorsAt` returns a deduped list) and
			 *  `useEditorErrorsBelow` deduplicates across the
			 *  prefix-merged result, so every entry in `errors` is
			 *  guaranteed unique within the render.
			 *
			 *  The `aria-live="polite"` + `aria-atomic="true"`
			 *  region renders unconditionally — many screen readers
			 *  fail to announce content of a live region "born
			 *  together" with the content itself. Keeping the
			 *  wrapper mounted means the region is monitored before
			 *  diagnostics arrive. The `sr-only` className when
			 *  `!hasErrors` keeps the empty region offscreen for
			 *  visual users while preserving the assistive-tech
			 *  contract; the `aria-invalid` flags on individual
			 *  inputs handle the immediate-by-input signal. */}
			<div
				aria-live="polite"
				aria-atomic="true"
				className={hasErrors ? "mt-2 space-y-0.5" : "sr-only"}
			>
				{errors?.map((message) => (
					<div key={message} className="text-xs leading-snug text-nova-rose">
						{message}
					</div>
				))}
			</div>
		</div>
	);
}

interface RowShellProps {
	readonly dragHandleRef?: (el: HTMLElement | null) => void;
	readonly onMove?: (key: ReorderKeyboardKey) => void;
	readonly reorderLabel?: string;
	readonly onRemove?: () => void;
	readonly removeLabel?: string;
	readonly errors?: readonly string[];
	readonly variant?: "normal" | "nested";
	/** Optional action row that remains visually inside this condition. */
	readonly footerAction?: ReactNode;
	readonly children: ReactNode;
}

/**
 * Headerless shell for sentence-shaped condition rows. A condition
 * reads as subject–verb–object ("age — is at least — 50"), so there
 * is nothing for a title to add: the verb chip inside the row IS the
 * operation, and naming the AST node above it ("GREATER THAN OR
 * EQUAL") would say the same thing twice in implementation
 * vocabulary. Container shapes (groups, related-case lookups) keep
 * the titled `CardShell` — a box's identity isn't expressible
 * inline.
 *
 * Row chrome that survives from the card shell: a full-height grab
 * rail on the leading edge when the row is reorderable, an inset corner
 * remove action when it's removable, and the same aria-live error
 * footer.
 */
export function PredicateRowShell({
	dragHandleRef,
	onMove,
	reorderLabel,
	onRemove,
	removeLabel,
	errors,
	variant = "normal",
	footerAction,
	children,
}: RowShellProps) {
	const hasErrors = errors !== undefined && errors.length > 0;

	const surfaceCls = [
		"group/card @container relative rounded-md border py-2.5 pr-3 transition-colors",
		dragHandleRef !== undefined ? "pl-12" : "pl-3",
		variant === "nested" ? "bg-nova-surface/30" : "bg-nova-surface/40",
		hasErrors
			? "border-nova-rose/35 shadow-[inset_0_0_0_1px_rgba(255,90,120,0.12)]"
			: "border-white/[0.04]",
	].join(" ");

	return (
		<div className={surfaceCls} data-removal-card>
			{dragHandleRef !== undefined && (
				<SimpleTooltip
					content={
						onMove === undefined ? "Drag to reorder" : "Drag or use arrow keys"
					}
				>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						ref={dragHandleRef}
						aria-label={reorderLabel ?? "Drag to reorder"}
						aria-keyshortcuts={
							onMove === undefined ? undefined : "ArrowUp ArrowDown Home End"
						}
						onKeyDown={(event) => handleReorderKey(event, onMove)}
						className="absolute inset-y-0 left-0 h-auto w-11 cursor-grab rounded-l-md rounded-r-none text-nova-text-muted not-disabled:hover:bg-white/[0.04] not-disabled:hover:text-nova-text"
					>
						<Icon icon={tablerGripVertical} width="16" height="16" />
					</Button>
				</SimpleTooltip>
			)}
			<div className={`space-y-2 ${onRemove !== undefined ? "@sm:pr-14" : ""}`}>
				{children}
			</div>
			{footerAction !== undefined ? (
				<div className="mt-3 flex justify-end border-t border-white/[0.05] pt-2">
					{footerAction}
				</div>
			) : null}
			{onRemove !== undefined && (
				<div className="mt-2 flex justify-end border-t border-white/[0.05] pt-2 @sm:contents">
					<RemoveConditionButton
						onClick={onRemove}
						label={removeLabel}
						className="right-3 top-3 @sm:absolute"
					/>
				</div>
			)}
			<div
				aria-live="polite"
				aria-atomic="true"
				className={hasErrors ? "mt-2 space-y-0.5" : "sr-only"}
			>
				{errors?.map((message) => (
					<div key={message} className="text-xs leading-snug text-nova-rose">
						{message}
					</div>
				))}
			</div>
		</div>
	);
}

interface InlineErrorProps {
	readonly errors: readonly string[];
}

/**
 * Per-slot inline error rendering. Cards call this beneath each
 * input that may carry a diagnostic from the type checker — the
 * helper renders the live region UNCONDITIONALLY so screen readers
 * have it monitored before content arrives. Many screen readers
 * fail to announce content of a live region "born together" with
 * its content; keeping the wrapper mounted closes that gap.
 *
 * `aria-live="polite"` defers announcement until the user pauses
 * input — appropriate for typed-as-you-go validation messages
 * (alert would be too aggressive). `aria-atomic="true"` reads the
 * full region content on each update so a partial change (one of
 * two errors clearing) doesn't leak partial-region announcements.
 *
 * Visually the region collapses to `sr-only` when empty so the
 * empty wrapper doesn't take layout space; the `aria-invalid` flag
 * on the input handles the immediate per-input signal.
 */
export function InlineError({ errors }: InlineErrorProps) {
	const hasErrors = errors.length > 0;
	return (
		<div
			aria-live="polite"
			aria-atomic="true"
			className={hasErrors ? "mt-1 space-y-0.5" : "sr-only"}
		>
			{/* The message string is a safe React key —
			 *  `buildValidityIndex` (in `editorContext.tsx`)
			 *  deduplicates per path on the way in (so the exact-match
			 *  `useEditorErrorsAt` returns a deduped list), and
			 *  `useEditorErrorsBelow` deduplicates across prefix-
			 *  merged paths, so every `errors` entry is guaranteed
			 *  unique within a single render. */}
			{errors.map((message) => (
				<div key={message} className="text-xs leading-snug text-nova-rose">
					{message}
				</div>
			))}
		</div>
	);
}
