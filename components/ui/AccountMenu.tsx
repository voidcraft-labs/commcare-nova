/**
 * Account menu — avatar-triggered dropdown with profile, credit balance,
 * settings link, and sign-out.
 *
 * The credit summary is fetched eagerly on mount so the dropdown opens
 * instantly with no loading state. Re-fetched on every subsequent open to
 * stay current after generations spend credits.
 */

"use client";
import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import tablerLogout from "@iconify-icons/tabler/logout";
import tablerSettings from "@iconify-icons/tabler/settings";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { type AuthUser, useAuth } from "@/lib/auth/hooks/useAuth";
// GET /api/user/usage returns `getCreditSummary`'s `CreditSummary` verbatim, so
// the client tracks that shared type rather than re-declaring it. The bar reads
// `balance` (spendable now) and `consumed`; their sum is the effective monthly
// total (allowance + bonus). Must be `import type` — the value side of
// `lib/db/credits` pulls in `@google-cloud/firestore`, and only the erased
// `type` form keeps that server dependency out of the client bundle.
import type { CreditSummary } from "@/lib/db/credits";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";

/**
 * Extract up to two initials from a display name.
 * Falls back to "?" if the name is empty.
 */
function getInitials(name: string): string {
	const parts = name.trim().split(/\s+/);
	if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
	return parts[0]?.[0]?.toUpperCase() ?? "?";
}

/**
 * Credit-gauge gradient. The argument is the fraction of the month's credits
 * still available, so the bar is healthy violet while credits remain and shifts
 * to the amber→rose warning once the balance runs low — under 20% of the
 * month's credits left.
 */
function getBarGradient(remainingRatio: number): string {
	if (remainingRatio < 0.2) return "from-nova-amber to-nova-rose";
	return "from-nova-violet to-nova-violet-bright";
}

// ── Avatar helper ──────────────────────────────────────────────────

/** Size presets for the avatar — trigger (28px) and profile (36px). */
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
		<span
			className={`${s.box} rounded-full bg-nova-surface ${s.text} font-semibold text-nova-text flex items-center justify-center ${s.border}`}
		>
			{getInitials(user.name)}
		</span>
	);
}

// ── AccountMenu ────────────────────────────────────────────────────

export function AccountMenu() {
	const { user, isAuthenticated, isPending, signOut } = useAuth();
	const [usage, setUsage] = useState<CreditSummary | null>(null);
	const [open, setOpen] = useState(false);

	/** Fetch usage from the API and update state. Best-effort — failures are silent.
	 * Accepts an AbortSignal so callers can cancel in-flight requests on cleanup. */
	const refreshUsage = useCallback((signal?: AbortSignal) => {
		fetch("/api/user/usage", { signal })
			.then((res) => (res.ok ? (res.json() as Promise<CreditSummary>) : null))
			.then((data) => {
				if (data) setUsage(data);
			})
			.catch(() => {});
	}, []);

	/* Pre-cache on mount so the first dropdown open shows data instantly. */
	useEffect(() => {
		if (!isAuthenticated) return;
		const controller = new AbortController();
		refreshUsage(controller.signal);
		return () => controller.abort();
	}, [isAuthenticated, refreshUsage]);

	/* Re-fetch on each dropdown open to stay current after generations. */
	useEffect(() => {
		if (!open || !isAuthenticated) return;
		const controller = new AbortController();
		refreshUsage(controller.signal);
		return () => controller.abort();
	}, [open, isAuthenticated, refreshUsage]);

	/* ── Loading placeholder while session check is in flight ────── */
	if (isPending) {
		return (
			<div className="w-7 h-7 rounded-full bg-nova-surface animate-pulse" />
		);
	}

	/* Session still loading or somehow unauthenticated — nothing to render */
	if (!isAuthenticated || !user) return null;

	/* The bar is a fuel gauge: full when fresh, depleting as credits are spent.
	 * Its denominator is the effective monthly total — allowance + bonus, recovered
	 * as `balance + consumed` (equal by definition) so a bonused user's extra credits
	 * count toward the total. The ratio is the fraction still available; clamped to
	 * [0, 1] and guarding divide-by-zero. */
	const total = usage ? usage.balance + usage.consumed : 0;
	const remainingRatio =
		usage && total > 0 ? Math.min(Math.max(usage.balance / total, 0), 1) : 0;

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			{/* ── Trigger: avatar or initials ──────────────────────── */}
			<Popover.Trigger
				className="flex items-center justify-center w-9 h-9 rounded-full cursor-pointer transition-all duration-150 ring-1 ring-transparent hover:ring-nova-border-bright focus-visible:ring-nova-violet outline-none"
				aria-label="Account menu"
			>
				<UserAvatar user={user} size="sm" />
			</Popover.Trigger>

			{/* ── Dropdown (portal) ────────────────────────────────── */}
			<Popover.Portal>
				<Popover.Positioner
					side="bottom"
					align="end"
					sideOffset={6}
					className={POPOVER_POSITIONER_GLASS_CLS}
				>
					<Popover.Popup className={POPOVER_POPUP_CLS}>
						<div className="w-64 overflow-hidden">
							{/* ── Profile ────────────────────────────────────── */}
							<div className="px-4 pt-4 pb-3 flex items-center gap-3">
								<UserAvatar user={user} size="md" />
								<div className="min-w-0">
									<p className="text-sm font-medium text-nova-text truncate">
										{user.name}
									</p>
									<p className="text-xs text-nova-text-muted truncate">
										{user.email}
									</p>
								</div>
							</div>

							{/* ── Credit bar ─────────────────────────────────── */}
							{usage && (
								<div className="px-4 pb-3">
									<div className="flex items-baseline justify-between mb-1.5">
										<span className="text-[11px] text-nova-text-muted">
											Credits this month
										</span>
										{/* Remaining over the effective monthly total (allowance + bonus).
										 * Using the bonus-inclusive total — not the bare allowance — keeps the
										 * figure honest for users who've been granted extra credits. */}
										<span className="text-[11px] text-nova-text-secondary">
											{usage.balance.toLocaleString()} /{" "}
											{total.toLocaleString()} credits
										</span>
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
							<div className="border-t border-white/[0.06]" />

							{/* ── Settings link ────────────────────────────── */}
							<Link
								href="/settings"
								onClick={() => setOpen(false)}
								className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-nova-text-secondary hover:text-nova-text hover:bg-white/[0.06] transition-colors cursor-pointer"
							>
								<Icon icon={tablerSettings} width="16" height="16" />
								Settings
							</Link>

							{/* ── Divider ────────────────────────────────────── */}
							<div className="border-t border-white/[0.06]" />

							{/* ── Sign out ──────────────────────────────────── */}
							<div>
								<button
									type="button"
									onClick={() => {
										signOut();
										setOpen(false);
									}}
									className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-nova-text-secondary hover:text-nova-rose hover:bg-nova-rose/[0.06] transition-colors cursor-pointer rounded-b-xl"
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
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
