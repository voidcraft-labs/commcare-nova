/**
 * Account menu: avatar-triggered dropdown with profile, credit balance,
 * settings link, the two ways out to help, and sign-out.
 *
 * Docs and Give feedback used to be their own "Help" dropdown beside this one
 * in the band. Two adjacent dropdowns holding four rows between them is one
 * control too many, and the header pays for it at every width — but the real
 * argument is reach: the band's own menus are the UNCLAIMED state, so a Help
 * control that lives there is gone the moment a build starts, which is exactly
 * when someone wants the docs. The account control is on every signed-in
 * surface, so putting them here is what makes help reachable from inside a
 * build at all.
 *
 * The credit summary comes from the shared `useCreditBalance` hook, which
 * fetches eagerly on mount so the dropdown opens instantly with no loading
 * state. The menu re-fetches on every subsequent open (via the hook's
 * `refresh`) to stay current after generations spend credits.
 */

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerBook from "@iconify-icons/tabler/book";
import externalLinkIcon from "@iconify-icons/tabler/external-link";
import tablerFiles from "@iconify-icons/tabler/files";
import tablerLogout from "@iconify-icons/tabler/logout";
import tablerMessage from "@iconify-icons/tabler/message";
import tablerSettings from "@iconify-icons/tabler/settings";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { MediaPickerDialog } from "@/components/builder/media/MediaPickerDialog";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { CreditAmount } from "@/components/ui/CreditAmount";
import { type AuthUser, useAuth } from "@/lib/auth/hooks/useAuth";
import { useCreditBalance } from "@/lib/credits/useCreditBalance";
import { ASSET_KINDS } from "@/lib/domain/multimedia";
import { POPOVER_ROW_CLS } from "@/lib/styles";
import { useMenuArrowKeys } from "@/lib/ui/hooks/useMenuArrowKeys";
import { getInitials } from "@/lib/utils";

const FEEDBACK_FORM_URL =
	"https://docs.google.com/forms/d/e/1FAIpQLSdUHQuE9kYhG-py9pojdCDc5ChSrl2LnhLofY4kDlOQi6ghGw/viewform";

/* Both help links open in a new tab. Only the Docs URL differs by env: dev
 * serves the docs in-tree at `/docs` (so local edits preview), while prod points
 * at the `docs.commcare.app` subdomain: the main host doesn't serve `/docs`
 * under the multi-host routing. `process.env.NODE_ENV` is inlined by Next at
 * build time. */
const DOCS_HREF =
	process.env.NODE_ENV === "development"
		? "/docs"
		: "https://docs.commcare.app/";

/**
 * A menu row that leaves the app. It wears the same box as Files and Settings
 * beside it, and adds the trailing external-link glyph: opening a new tab is
 * the one thing about these rows the label alone doesn't say.
 */
function ExternalRow({
	href,
	icon,
	label,
	onNavigate,
}: {
	href: string;
	icon: IconifyIcon;
	label: string;
	onNavigate: () => void;
}) {
	return (
		<Link
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			onClick={onNavigate}
			className={POPOVER_ROW_CLS}
		>
			<Icon icon={icon} width="16" height="16" className="shrink-0" />
			<span className="flex-1">{label}</span>
			<Icon
				icon={externalLinkIcon}
				width="14"
				height="14"
				className="shrink-0 text-nova-text-muted"
			/>
		</Link>
	);
}

/**
 * Credit-gauge gradient. The argument is the fraction of the month's credits
 * still available, so the bar is healthy violet while credits remain and shifts
 * to the amber→rose warning once the balance runs low: under 20% of the
 * month's credits left.
 */
function getBarGradient(remainingRatio: number): string {
	if (remainingRatio < 0.2) return "from-nova-amber to-nova-rose";
	return "from-nova-violet to-nova-violet-bright";
}

// ── Avatar helper ──────────────────────────────────────────────────

/** Size presets for the 36px avatar inside the trigger and profile row. */
const AVATAR_SIZES = {
	sm: { box: "w-9 h-9", text: "text-xs", border: "" },
	md: {
		box: "w-9 h-9",
		text: "text-xs",
		border: "border border-white/[0.08] shrink-0",
	},
} as const;

/**
 * User avatar with initials fallback. Renders a circular image when the
 * user has a Google profile photo, otherwise shows extracted initials
 * on a solid surface background.
 */
function UserAvatar({
	user,
	size,
}: {
	user: AuthUser;
	size: keyof typeof AVATAR_SIZES;
}) {
	const s = AVATAR_SIZES[size];
	if (user.image) {
		return (
			<Image
				src={user.image}
				alt=""
				width={36}
				height={36}
				referrerPolicy="no-referrer"
				unoptimized
				className={`${s.box} rounded-full ${s.border}`}
			/>
		);
	}
	return (
		/* `leading-none` centers the CAPS optically: with the inherited
		 * line-height the line box towers over the glyphs, so flex centers
		 * the box and the letters ride high of the circle's midline. */
		<span
			className={`${s.box} rounded-full bg-nova-surface ${s.text} font-semibold leading-none text-nova-text flex items-center justify-center ${s.border}`}
		>
			{getInitials(user.name)}
		</span>
	);
}

// ── AccountMenu ────────────────────────────────────────────────────

export function AccountMenu({
	canManageFiles,
}: {
	/** Active Project edit capability for the standalone site header. Omitted
	 *  in the builder, where MediaPickerDialog reads the live session tuple. */
	canManageFiles?: boolean;
} = {}) {
	const { user, isAuthenticated, isPending, signOut } = useAuth();
	const [open, setOpen] = useState(false);
	const onArrowKeys = useMenuArrowKeys();
	/* File-manager dialog open state. The "Files" item opens the same media
	 * dialog the chat composer uses, but with no pick target: a standalone
	 * manager for browsing, uploading, previewing, and deleting your files. */
	const [fileManagerOpen, setFileManagerOpen] = useState(false);

	/* Credit summary via the shared hook. It owns the on-mount fetch, gated by
	 * `isAuthenticated` so it doesn't fire a 401 before sign-in resolves, so the
	 * dropdown opens instantly with no loading state. `refresh` re-fetches on
	 * demand for the on-open effect below. */
	const { summary: usage, refresh } = useCreditBalance(isAuthenticated);

	/* Re-fetch on each dropdown open to stay current after generations spend
	 * credits. The on-mount fetch lives in the hook; this is the only fetch the
	 * menu drives itself. */
	useEffect(() => {
		if (!open || !isAuthenticated) return;
		const controller = new AbortController();
		refresh(controller.signal);
		return () => controller.abort();
	}, [open, isAuthenticated, refresh]);

	/* Hold the placeholder until mounted to avoid an SSR/client hydration
	 * mismatch: the auth client resolves the session synchronously on the client
	 * (`isPending` false on first paint) while SSR has none (`isPending` true),
	 * so the server renders the placeholder and the client would render the menu:
	 * a mismatch React has to discard. Gating the first client render on mount
	 * makes it match the server, then it swaps to the resolved menu. */
	const [mounted, setMounted] = useState(false);
	useEffect(() => {
		setMounted(true);
	}, []);

	/* ── Loading placeholder while session check is in flight ────── */
	if (!mounted || isPending) {
		return (
			<div
				className="size-11 rounded-full bg-nova-surface animate-pulse"
				aria-hidden="true"
			/>
		);
	}

	/* Session still loading or somehow unauthenticated: nothing to render */
	if (!isAuthenticated || !user) return null;

	/* The bar is a fuel gauge: full when fresh, depleting as credits are spent.
	 * Its denominator is the effective monthly total: allowance + bonus, recovered
	 * as `balance + consumed` (equal by definition) so a bonused user's extra credits
	 * count toward the total. The ratio is the fraction still available; clamped to
	 * [0, 1] and guarding divide-by-zero. */
	const total = usage ? usage.balance + usage.consumed : 0;
	const remainingRatio =
		usage && total > 0 ? Math.min(Math.max(usage.balance / total, 0), 1) : 0;

	return (
		<>
			<Popover open={open} onOpenChange={setOpen}>
				{/* ── Trigger: avatar or initials ──────────────────────── */}
				<PopoverTrigger
					className="nova-focusable flex size-11 items-center justify-center rounded-full cursor-pointer transition-all duration-150 ring-1 ring-transparent hover:ring-nova-border-bright outline-none"
					aria-label="Account menu"
				>
					<UserAvatar user={user} size="sm" />
				</PopoverTrigger>

				{/* ── Dropdown (the shared component portals + avoids collisions) ── */}
				<PopoverContent
					side="bottom"
					align="end"
					sideOffset={6}
					className="w-64 gap-0 p-1"
					onKeyDown={onArrowKeys}
				>
					<PopoverTitle className="sr-only">Account</PopoverTitle>
					<PopoverDescription className="sr-only">
						Account details and actions
					</PopoverDescription>
					<div className="w-full overflow-hidden">
						{/* ── Profile ────────────────────────────────────── */}
						<div className="px-3 pt-3 pb-3 flex items-center gap-3">
							<UserAvatar user={user} size="md" />
							<div className="min-w-0">
								<p className="break-words text-sm font-medium text-nova-text [overflow-wrap:anywhere]">
									{user.name}
								</p>
								<p className="break-words text-xs text-nova-text-muted [overflow-wrap:anywhere]">
									{user.email}
								</p>
							</div>
						</div>

						{/* ── Credit bar ─────────────────────────────────── */}
						{usage && (
							<div className="px-3 pb-3">
								<div className="flex items-baseline justify-between mb-1.5">
									<span className="text-[11px] text-nova-text-muted">
										Credits this month
									</span>
									{/* Just the remaining balance: no "/ total", no "credits" word. A
									 * countdown to zero reads fine without the denominator, and dropping the
									 * trailing text keeps this on one line beside the "Credits this month"
									 * label instead of wrapping. The bar below still conveys the proportion
									 * remaining. */}
									<CreditAmount
										value={usage.balance}
										className="text-nova-text-secondary"
									/>
								</div>
								<div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
									<div
										className={`h-full rounded-full bg-gradient-to-r ${getBarGradient(remainingRatio)} transition-all duration-500`}
										style={{ width: `${remainingRatio * 100}%` }}
									/>
								</div>
							</div>
						)}

						{/* ── Divider ────────────────────────────────────── */}
						<div className="mx-2 my-1 border-t border-white/[0.06]" />

						{/* ── Files (file manager) ─────────────────────── */}
						{/* Opens the media dialog as a standalone manager: the only
						 *  entry to it outside the chat composer's attach flow. Close
						 *  the menu first, then open the dialog (a sibling of this
						 *  Popover, so it outlives the menu). */}
						<button
							type="button"
							onClick={() => {
								setOpen(false);
								setFileManagerOpen(true);
							}}
							className={POPOVER_ROW_CLS}
						>
							<Icon icon={tablerFiles} width="16" height="16" />
							Files
						</button>

						{/* ── Settings link ────────────────────────────── */}
						<Link
							href="/settings"
							onClick={() => setOpen(false)}
							className={POPOVER_ROW_CLS}
						>
							<Icon icon={tablerSettings} width="16" height="16" />
							Settings
						</Link>

						{/* ── Divider ────────────────────────────────────── */}
						<div className="mx-2 my-1 border-t border-white/[0.06]" />

						{/* ── Help: the two ways out of the app ──────────── */}
						<ExternalRow
							href={DOCS_HREF}
							icon={tablerBook}
							label="Docs"
							onNavigate={() => setOpen(false)}
						/>
						<ExternalRow
							href={FEEDBACK_FORM_URL}
							icon={tablerMessage}
							label="Give feedback"
							onNavigate={() => setOpen(false)}
						/>

						{/* ── Divider ────────────────────────────────────── */}
						<div className="mx-2 my-1 border-t border-white/[0.06]" />

						{/* ── Sign out ──────────────────────────────────── */}
						<div>
							<button
								type="button"
								onClick={() => {
									signOut();
									setOpen(false);
								}}
								className={`${POPOVER_ROW_CLS} not-disabled:hover:bg-nova-rose/[0.06] not-disabled:hover:text-nova-rose`}
							>
								<Icon
									icon={tablerLogout}
									width="16"
									height="16"
									className="transition-colors"
								/>
								Sign out
							</button>
						</div>
					</div>
				</PopoverContent>
			</Popover>

			{/* The file manager opens OUTSIDE the Popover (it portals to body
			 *  anyway), so it outlives the menu closing on the click that opened it.
			 *  Omitting onPick puts the dialog in manage mode: all asset kinds,
			 *  browse / preview, plus upload/delete for Project editors, with no
			 *  carrier to pick into.
			 *  `iconLibrary="all"` surfaces the built-in icon set here for discovery
			 *  (browse-only: clicking previews; there's no slot to attach to). */}
			<MediaPickerDialog
				open={fileManagerOpen}
				onOpenChange={setFileManagerOpen}
				kinds={ASSET_KINDS}
				iconLibrary="all"
				canWrite={canManageFiles}
			/>
		</>
	);
}
