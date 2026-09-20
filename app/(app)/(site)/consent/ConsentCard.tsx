/**
 * The card shell and icon chip shared by the OAuth connection surfaces: the
 * consent form (happy path and stale-link branch) and the connection-issue
 * page an authorize failure lands on. One shell keeps the whole connection
 * flow reading as a single Nova screen, whichever way a request turns out.
 *
 * No client-only behavior lives here, so the file carries no `"use client"`:
 * the consent form imports it into its client bundle and the connection-issue
 * page renders it on the server.
 */

import { Icon } from "@iconify/react/offline";

/**
 * Elevated card shell. Uses `bg-nova-deep` (the same tier Nova's
 * `ConfirmDialog` uses) so the consent surface reads as a decision dialog,
 * not a passive panel: it's lifted off the page with border + outer glow
 * rather than a brighter fill.
 *
 * The `tone` prop swaps the accent glow: violet for normal consent, rose
 * for the invalid-link state. The card itself stays dark in both cases:
 * flooding the surface with rose would turn error recovery into a scolding.
 */
export function ConsentCard({
	tone,
	children,
}: {
	tone: "default" | "error";
	children: React.ReactNode;
}) {
	const glow =
		tone === "error"
			? "shadow-[0_0_80px_rgba(212,112,143,0.08),inset_0_1px_0_rgba(255,255,255,0.03)]"
			: "shadow-[0_0_80px_rgba(150,120,242,0.1),inset_0_1px_0_rgba(255,255,255,0.04)]";

	return (
		<div
			className={`relative w-full rounded-2xl border border-nova-border bg-nova-deep p-5 sm:p-6 ${glow}`}
		>
			{/* Hairline top highlight: one-pixel violet gradient along the top
			 *   edge of the card. Reads as a light source from above and adds a
			 *   hint of the hardware-panel motif used in `nova-panel` without
			 *   pulling in the full LED/bezel chrome (which would be too loud
			 *   here, where the card is the only element). */}
			<div
				aria-hidden
				className={`pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent ${
					tone === "error" ? "via-nova-rose/40" : "via-nova-violet/50"
				} to-transparent`}
			/>
			{children}
		</div>
	);
}

/**
 * Rounded-square icon chip that pairs with the consent eyebrow. The happy
 * path uses the small size to keep the identity details from crowding the
 * headline; the invalid-link branch keeps the larger size for error focus.
 */
export function IconChip({
	tone,
	icon,
	size = "md",
}: {
	tone: "violet" | "error";
	icon: Parameters<typeof Icon>[0]["icon"];
	size?: "sm" | "md";
}) {
	const theme =
		tone === "error"
			? {
					ring: "border-nova-rose/30 bg-nova-rose/10",
					icon: "text-nova-rose",
				}
			: {
					ring: "border-nova-violet/30 bg-nova-violet/10",
					icon: "text-nova-violet-bright",
				};
	const box = size === "sm" ? "h-8 w-8 rounded-lg" : "h-11 w-11 rounded-xl";
	const iconSize = size === "sm" ? "18" : "22";
	return (
		<div
			className={`flex items-center justify-center border ${box} ${theme.ring}`}
		>
			<Icon
				icon={icon}
				width={iconSize}
				height={iconSize}
				className={theme.icon}
				aria-hidden
			/>
		</div>
	);
}
