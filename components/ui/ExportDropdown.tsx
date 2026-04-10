/**
 * Export dropdown — trigger button that opens a menu with CommCare HQ upload
 * as the primary action and file downloads as secondary options.
 *
 * Two layout zones separated by a divider:
 *   1. **CommCare HQ** — upload to a project space (primary workflow)
 *   2. **File downloads** — JSON / CCZ export (secondary)
 *
 * When CommCare HQ isn't configured, the primary zone shows an informative
 * prompt with a link to Settings instead of a disabled button.
 *
 * Renders all items directly rather than delegating to DropdownMenu — the
 * two-zone layout with a divider needs a single unified surface, not a
 * glass panel containing a nested glass panel.
 */

"use client";
import { Popover } from "@base-ui/react/popover";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerCloudUpload from "@iconify-icons/tabler/cloud-upload";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerUpload from "@iconify-icons/tabler/upload";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";

// ── Types ──────────────────────────────────────────────────────────

export interface ExportOption {
	label: string;
	description: string;
	icon: IconifyIcon;
	onClick: () => void;
}

interface ExportDropdownProps {
	/** File download options (JSON, CCZ). */
	options: ExportOption[];
	/** Whether CommCare HQ credentials are configured (only meaningful when loaded). */
	commcareConfigured: boolean;
	/** Load status: pending (not fetched), loading, or loaded. */
	commcareStatus: "pending" | "loading" | "loaded";
	/** Called on first open to trigger a lazy settings fetch. */
	onLoad: () => void;
	/** Called when the user clicks "CommCare HQ" (only when configured). */
	onCommCareUpload: () => void;
	/** Icon-only trigger button for compact toolbar placement. */
	compact?: boolean;
}

// ── Component ──────────────────────────────────────────────────────

export function ExportDropdown({
	options,
	commcareConfigured,
	commcareStatus,
	onLoad,
	onCommCareUpload,
	compact,
}: ExportDropdownProps) {
	const [open, setOpen] = useState(false);

	/* Trigger lazy settings fetch on first open. */
	useEffect(() => {
		if (open && commcareStatus === "pending") onLoad();
	}, [open, commcareStatus, onLoad]);

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Tooltip content="Export">
				<Popover.Trigger
					aria-label="Export"
					className={
						compact
							? "inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-nova-text-muted hover:text-nova-text hover:bg-white/5 transition-colors cursor-pointer"
							: "inline-flex items-center gap-1.5 px-3 py-1.5 text-lg font-medium rounded-lg bg-nova-surface text-nova-text border border-nova-border hover:border-nova-border-bright hover:bg-nova-elevated transition-all duration-200 cursor-pointer"
					}
				>
					<Icon
						icon={tablerUpload}
						width={compact ? 18 : 14}
						height={compact ? 18 : 14}
						className={compact ? "" : "opacity-70"}
					/>
				</Popover.Trigger>
			</Tooltip>

			<Popover.Portal>
				<Popover.Positioner
					side="bottom"
					align="end"
					sideOffset={6}
					className={POPOVER_POSITIONER_GLASS_CLS}
				>
					<Popover.Popup className={POPOVER_POPUP_CLS}>
						<div style={{ minWidth: "220px" }}>
							{/* ── CommCare HQ section (primary) ─────────────── */}
							{commcareStatus !== "loaded" ? (
								<CommCareLoadingRow />
							) : commcareConfigured ? (
								<button
									type="button"
									onClick={() => {
										onCommCareUpload();
										setOpen(false);
									}}
									className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-nova-text hover:bg-white/[0.06] transition-colors cursor-pointer rounded-t-xl"
								>
									<Icon
										icon={tablerCloudUpload}
										width="16"
										height="16"
										className="text-nova-violet-bright"
									/>
									<span className="flex-1 text-left">
										<div className="font-medium">CommCare HQ</div>
										<div className="text-xs text-nova-text-muted leading-tight">
											Upload to a project space
										</div>
									</span>
								</button>
							) : (
								<CommCareSetupPrompt onClose={() => setOpen(false)} />
							)}

							{/* ── Divider ──────────────────────────────────── */}
							<div className="border-t border-white/[0.06]" />

							{/* ── File downloads (secondary) ────────────────── */}
							{options.map((opt, i) => (
								<button
									type="button"
									// biome-ignore lint/suspicious/noArrayIndexKey: static options from useMemo, never reordered
									key={i}
									onClick={() => {
										opt.onClick();
										setOpen(false);
									}}
									className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nova-text hover:bg-white/[0.06] transition-colors cursor-pointer ${
										i === options.length - 1 ? "rounded-b-xl" : ""
									}`}
								>
									<Icon
										icon={opt.icon}
										width="16"
										height="16"
										className="text-nova-text-muted"
									/>
									<span className="flex-1 text-left">
										<div>{opt.label}</div>
										<div className="text-xs text-nova-text-muted leading-tight">
											{opt.description}
										</div>
									</span>
								</button>
							))}
						</div>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

// ── Loading state ───────────────────────────────────────────────────

/** Brief loading row shown while CommCare settings are being fetched. */
function CommCareLoadingRow() {
	return (
		<div className="flex items-center gap-2.5 px-3 py-2.5 rounded-t-xl">
			<Icon
				icon={tablerLoader2}
				width="16"
				height="16"
				className="text-nova-text-muted animate-spin"
			/>
			<span className="text-sm text-nova-text-muted">CommCare HQ</span>
		</div>
	);
}

// ── Unconfigured prompt ────────────────────────────────────────────

/**
 * Shown when CommCare HQ credentials haven't been set up yet.
 * Informative and actionable — links directly to Settings rather
 * than just showing a disabled menu item with a tooltip.
 */
function CommCareSetupPrompt({ onClose }: { onClose: () => void }) {
	return (
		<div className="px-3 py-3 rounded-t-xl">
			<div className="flex items-start gap-2.5">
				<Icon
					icon={tablerCloudUpload}
					width="16"
					height="16"
					className="text-nova-text-muted mt-0.5 shrink-0"
				/>
				<div className="min-w-0">
					<div className="text-sm font-medium text-nova-text">CommCare HQ</div>
					<p className="text-xs text-nova-text-muted leading-relaxed mt-0.5">
						Connect in Settings to upload apps directly.
					</p>
					<Link
						href="/settings"
						onClick={onClose}
						className="inline-flex items-center gap-1 mt-1.5 text-xs font-medium text-nova-violet-bright hover:text-nova-violet transition-colors"
					>
						Set up
						<Icon icon={tablerChevronRight} width="12" height="12" />
					</Link>
				</div>
			</div>
		</div>
	);
}
