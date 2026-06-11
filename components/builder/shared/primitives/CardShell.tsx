// components/builder/shared/primitives/CardShell.tsx
//
// Shared chrome for every predicate card: header (icon + label +
// optional kebab menu), body slot, and inline-error footer. The
// shell never reaches into the AST itself — it's purely a visual
// container the per-kind cards compose around their own body.
//
// Visual language follows the established inspector / detail-panel
// patterns (`SECTION_CARD_CLASS` + `SectionLabel` from
// `components/builder/editor/sectionChrome.tsx`): a glass-tinted
// rounded container, hairline border, violet accent strip on the
// label. Cards stack vertically inside their parent group; reorder
// drag uses pragmatic-drag-and-drop and presents through the
// optional `dragHandleProps` slot.

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerDotsVertical from "@iconify-icons/tabler/dots-vertical";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerTrash from "@iconify-icons/tabler/trash";
import type { ReactNode } from "react";
import { useRef } from "react";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";

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
	/**
	 * Optional remove handler — when provided, the kebab menu shows
	 * a "Delete" item. Cards inside an `and` / `or` group's clause
	 * list and cards under a `not` / `when-input-present` / `exists`
	 * wrapper get a delete affordance; the top-level card does not
	 * (the parent owns the replacement). The kebab itself is hidden
	 * when no `onRemove` is wired.
	 */
	readonly onRemove?: () => void;
	/** Optional kind-name override displayed in error toasts / labels. */
	readonly kindAccent?: ReactNode;
	/** Inline diagnostics to render at the card's footer (one row each). */
	readonly errors?: readonly string[];
	readonly children: ReactNode;
}

/**
 * Card shell — header + body + footer-error rendering.
 *
 * The card surface mirrors the inspector's `SECTION_CARD_CLASS`
 * (rounded, frosted violet-tinted background, hairline border) so
 * the predicate editor reads as the same surface family. Cards
 * surface inline diagnostics at the bottom of the body — the type
 * checker's verdict for the card's own path lands here, with
 * per-slot errors rendering inside the body's own input chrome.
 */
export function CardShell({
	icon,
	label,
	variant = "normal",
	dragHandleRef,
	onRemove,
	kindAccent,
	errors,
	children,
}: CardShellProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const hasErrors = errors !== undefined && errors.length > 0;

	const surfaceCls = [
		"group/card relative rounded-md border px-3 py-2.5 transition-colors",
		variant === "nested" ? "bg-nova-surface/30" : "bg-nova-surface/40",
		hasErrors
			? "border-nova-error/35 shadow-[inset_0_0_0_1px_rgba(255,90,120,0.12)]"
			: "border-white/[0.04]",
	].join(" ");

	return (
		<div className={surfaceCls}>
			{/* Header: drag handle + icon + label + kebab. The handle is a
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
					<button
						type="button"
						ref={dragHandleRef}
						aria-label="Reorder card"
						className="cursor-grab text-nova-text-muted/50 hover:text-nova-text-muted transition-colors -ml-1"
					>
						<Icon icon={tablerGripVertical} width="14" height="14" />
					</button>
				)}
				<div className="w-0.5 h-3 rounded-full bg-nova-violet/40" />
				<Icon
					icon={icon}
					width="14"
					height="14"
					className="text-nova-violet-bright/80"
				/>
				<span className="text-[10px] font-semibold uppercase tracking-widest text-nova-text-muted/80">
					{label}
				</span>
				{kindAccent !== undefined && (
					<span className="ml-1 text-[10px] text-nova-text-muted/60">
						{kindAccent}
					</span>
				)}
				<div className="flex-1" />
				{onRemove !== undefined && (
					<Menu.Root>
						<Menu.Trigger
							ref={triggerRef}
							aria-label="Card actions"
							className="rounded p-0.5 text-nova-text-muted/60 hover:text-nova-text hover:bg-white/[0.05] transition-colors cursor-pointer"
						>
							<Icon icon={tablerDotsVertical} width="14" height="14" />
						</Menu.Trigger>
						<Menu.Portal>
							<Menu.Positioner
								side="bottom"
								align="end"
								sideOffset={4}
								anchor={triggerRef}
								className={MENU_POSITIONER_CLS}
							>
								<Menu.Popup className={MENU_POPUP_CLS}>
									<Menu.Item
										onClick={onRemove}
										className={`rounded-xl ${MENU_ITEM_CLS} text-nova-error/90 hover:text-nova-error`}
									>
										<Icon icon={tablerTrash} width="14" height="14" />
										<span>Delete</span>
									</Menu.Item>
								</Menu.Popup>
							</Menu.Positioner>
						</Menu.Portal>
					</Menu.Root>
				)}
			</div>

			{/* Body — per-card content. Cards lay out their inputs
			 *  directly (no nested wrapper) so they can compose
			 *  arbitrary grids / rows without the shell imposing
			 *  layout. */}
			<div className="space-y-2">{children}</div>

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
					<div
						key={message}
						className="text-[11px] leading-snug text-nova-error/90"
					>
						{message}
					</div>
				))}
			</div>
		</div>
	);
}

interface RowShellProps {
	readonly dragHandleRef?: (el: HTMLElement | null) => void;
	readonly onRemove?: () => void;
	readonly errors?: readonly string[];
	readonly variant?: "normal" | "nested";
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
 * rail on the leading edge when the row is reorderable, a corner
 * actions menu when it's removable, and the same aria-live error
 * footer.
 */
export function PredicateRowShell({
	dragHandleRef,
	onRemove,
	errors,
	variant = "normal",
	children,
}: RowShellProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const hasErrors = errors !== undefined && errors.length > 0;

	const surfaceCls = [
		"group/card relative rounded-md border py-2.5 pr-3 transition-colors",
		dragHandleRef !== undefined ? "pl-8" : "pl-3",
		variant === "nested" ? "bg-nova-surface/30" : "bg-nova-surface/40",
		hasErrors
			? "border-nova-error/35 shadow-[inset_0_0_0_1px_rgba(255,90,120,0.12)]"
			: "border-white/[0.04]",
	].join(" ");

	return (
		<div className={surfaceCls}>
			{dragHandleRef !== undefined && (
				<button
					type="button"
					ref={dragHandleRef}
					aria-label="Drag to reorder"
					className="absolute left-0 top-0 bottom-0 w-7 grid place-items-center rounded-l-md cursor-grab text-nova-text-muted/40 hover:text-nova-text-muted transition-colors"
				>
					<Icon icon={tablerGripVertical} width="14" height="14" />
				</button>
			)}
			<div className={`space-y-2 ${onRemove !== undefined ? "pr-8" : ""}`}>
				{children}
			</div>
			{onRemove !== undefined && (
				<Menu.Root>
					<Menu.Trigger
						ref={triggerRef}
						aria-label="Condition actions"
						className="absolute top-0 right-0 w-11 h-11 grid place-items-center rounded-md text-nova-text-muted/60 hover:text-nova-text transition-colors cursor-pointer"
					>
						<Icon icon={tablerDotsVertical} width="14" height="14" />
					</Menu.Trigger>
					<Menu.Portal>
						<Menu.Positioner
							side="bottom"
							align="end"
							sideOffset={4}
							anchor={triggerRef}
							className={MENU_POSITIONER_CLS}
						>
							<Menu.Popup className={MENU_POPUP_CLS}>
								<Menu.Item
									onClick={onRemove}
									className={`rounded-xl ${MENU_ITEM_CLS} text-nova-error/90 hover:text-nova-error`}
								>
									<Icon icon={tablerTrash} width="14" height="14" />
									<span>Delete</span>
								</Menu.Item>
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.Root>
			)}
			<div
				aria-live="polite"
				aria-atomic="true"
				className={hasErrors ? "mt-2 space-y-0.5" : "sr-only"}
			>
				{errors?.map((message) => (
					<div
						key={message}
						className="text-[11px] leading-snug text-nova-error/90"
					>
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
				<div
					key={message}
					className="text-[11px] leading-snug text-nova-error/90"
				>
					{message}
				</div>
			))}
		</div>
	);
}
