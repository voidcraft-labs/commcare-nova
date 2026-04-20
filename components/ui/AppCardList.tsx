"use client";
import { useCallback } from "react";
import type { AppSummary } from "@/lib/db/apps";
import { useExternalNavigate } from "@/lib/routing/hooks";
import { AppCard } from "./AppCard";

interface AppCardListProps {
	apps: AppSummary[];
	/** When true, non-error apps link to `/build/{id}`. Defaults to false. */
	linkToApps?: boolean;
	/** When true, replay buttons are shown (admin-only feature). Defaults to false. */
	showReplay?: boolean;
}

/**
 * Grid of app cards. Shared between the home page (user's own apps)
 * and admin user detail page (admin viewing any user's apps).
 */
export function AppCardList({
	apps,
	linkToApps = false,
	showReplay = false,
}: AppCardListProps) {
	const navigate = useExternalNavigate();

	const handleReplay = useCallback(
		(appId: string) => {
			navigate.push(`/build/replay/${appId}`);
		},
		[navigate],
	);

	if (apps.length === 0) {
		return (
			<p className="py-12 text-center text-sm text-nova-text-muted">
				No apps yet.
			</p>
		);
	}

	return (
		<div className="grid gap-3">
			{apps.map((app, i) => (
				<AppCard
					key={app.id}
					app={app}
					index={i}
					href={
						linkToApps && app.status !== "error"
							? `/build/${app.id}`
							: undefined
					}
					onReplay={showReplay ? handleReplay : undefined}
				/>
			))}
		</div>
	);
}
