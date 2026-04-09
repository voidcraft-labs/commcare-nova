/**
 * Impersonation banner — orchid-toned pill in the global header.
 *
 * Rendered when an admin is viewing the app as another user. Shows
 * the impersonated user's name and a "Switch back" button that ends
 * the impersonation session and returns to the admin dashboard.
 *
 * Uses `--nova-orchid` — a warm pink-purple from the xpath "lavender
 * milk bath" palette. Distinct enough to notice against the cool violet
 * UI, but still native to the theme. The switch-back action performs a
 * hard reload (`window.location.href`) rather than client-side navigation
 * to ensure a full session refresh.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerSpy from "@iconify-icons/tabler/spy";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

interface ImpersonationBannerProps {
	userName: string;
	/** Shown on hover — full email provides identity confirmation. */
	userEmail: string;
}

export function ImpersonationBanner({
	userName,
	userEmail,
}: ImpersonationBannerProps) {
	const [loading, setLoading] = useState(false);

	/** End the impersonation session and hard-reload to the admin dashboard.
	 * Always navigates regardless of API success — a failed stop usually means
	 * the session is already stale, and a full reload will sort it out. */
	const handleStopImpersonating = async () => {
		setLoading(true);
		try {
			await authClient.admin.stopImpersonating();
		} catch {
			/* Swallow — the hard reload below handles recovery. */
		}
		window.location.href = "/admin";
	};

	return (
		<div
			className="flex items-center gap-2 rounded-lg border border-nova-orchid/25 bg-nova-orchid/8 px-3 py-1.5 text-sm text-nova-orchid"
			role="status"
			aria-label={`Impersonating ${userName}`}
		>
			<Icon icon={tablerSpy} width="16" height="16" className="shrink-0" />
			<span>
				Viewing as{" "}
				<span className="font-semibold" title={userEmail}>
					{userName}
				</span>
			</span>
			<button
				type="button"
				onClick={handleStopImpersonating}
				disabled={loading}
				className="ml-1 flex items-center gap-1 rounded-md bg-nova-orchid/15 px-2 py-0.5 text-xs font-medium transition-colors hover:bg-nova-orchid/25 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
			>
				<Icon icon={tablerArrowBackUp} width="14" height="14" />
				{loading ? "Switching..." : "Switch back"}
			</button>
		</div>
	);
}
