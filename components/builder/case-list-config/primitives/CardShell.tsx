// components/builder/case-list-config/primitives/CardShell.tsx
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
					<button
						type="button"
						ref={(el) => {
							dragHandleRef(el);
						}}
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
			 *  safe React key here — `buildValidityIndex` deduplicates
			 *  within a single path on the way in, and
			 *  `useEditorErrorsAtOrBelow` deduplicates across the
			 *  prefix-merged result, so every entry in `errors` is
			 *  guaranteed unique within the render. */}
			{hasErrors && (
				<div className="mt-2 space-y-0.5">
					{errors.map((message) => (
						<div
							key={message}
							className="text-[11px] leading-snug text-nova-error/90"
						>
							{message}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

interface InlineErrorProps {
	readonly errors: readonly string[];
}

/**
 * Per-slot inline error rendering. Cards call this beneath each
 * input that may carry a diagnostic from the type checker — the
 * helper short-circuits when no errors landed so callers can render
 * it unconditionally. Mirrors the visual tier the field editor
 * uses for validation hints.
 */
export function InlineError({ errors }: InlineErrorProps) {
	if (errors.length === 0) return null;
	return (
		<div className="mt-1 space-y-0.5">
			{/* The message string is a safe React key —
			 *  `buildValidityIndex` (in `editorContext.tsx`)
			 *  deduplicates per path on the way in, and
			 *  `useEditorErrorsAtOrBelow` deduplicates across
			 *  prefix-merged paths, so every `errors` entry is
			 *  guaranteed unique within a single render. */}
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
