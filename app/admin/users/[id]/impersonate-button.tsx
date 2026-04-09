/**
 * Impersonate button — starts an admin impersonation session.
 *
 * Calls Better Auth's `admin.impersonateUser()` which creates a new
 * session mimicking the target user (default 1-hour duration). On
 * success, hard-reloads to `/` so the app renders with the impersonated
 * user's data. The hard reload ensures a full session cookie refresh —
 * client-side navigation would show stale state from the cookie cache.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerSpy from "@iconify-icons/tabler/spy";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

interface ImpersonateButtonProps {
	/** The user ID to impersonate. */
	userId: string;
	/** Display name — used for the tooltip. */
	userName: string;
}

export function ImpersonateButton({
	userId,
	userName,
}: ImpersonateButtonProps) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");

	const handleImpersonate = async () => {
		setLoading(true);
		setError("");
		const { error: err } = await authClient.admin.impersonateUser({ userId });
		if (err) {
			setError(err.message ?? "Failed to impersonate");
			setLoading(false);
			return;
		}
		/* Hard reload — the session cookie now represents the impersonated
		 * user. window.location.href forces a full server-side re-render. */
		window.location.href = "/";
	};

	return (
		<div className="flex items-center gap-2">
			<button
				type="button"
				onClick={handleImpersonate}
				disabled={loading}
				title={`View app as ${userName}`}
				className="inline-flex items-center gap-1.5 rounded-lg border border-nova-border bg-nova-surface px-3 py-1.5 text-sm font-medium text-nova-text transition-all hover:border-nova-border-bright hover:bg-nova-elevated cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
			>
				<Icon icon={tablerSpy} width="16" height="16" />
				{loading ? "Impersonating..." : "Impersonate"}
			</button>
			{error && <span className="text-xs text-nova-rose">{error}</span>}
		</div>
	);
}
