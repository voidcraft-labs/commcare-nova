"use client";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import type { AppSummary } from "@/lib/db/apps";
import { AppCard } from "./AppCard";

interface ReplayableAppListProps {
	apps: AppSummary[];
	/** Email of the app owner — used to build the replay route URL. */
	ownerEmail?: string;
	/** When true, non-error apps link to `/build/{id}`. Defaults to false. */
	linkToApps?: boolean;
	/** When false, replay buttons are hidden. Defaults to true. */
	showReplay?: boolean;
	/** Content to show when the app list is empty. */
	emptyState?: React.ReactNode;
}

/**
 * App list with integrated replay support.
 *
 * Client component because the replay callback uses `router.push` for
 * navigation. Shared between the builds page (user's own apps) and
 * admin user detail page (admin viewing any user's apps).
 */
export function ReplayableAppList({
	apps,
	ownerEmail,
	linkToApps = false,
	showReplay = true,
	emptyState,
}: ReplayableAppListProps) {
	const router = useRouter();

	const handleReplay = useCallback(
		(appId: string) => {
			const params = ownerEmail
				? `?owner=${encodeURIComponent(ownerEmail)}`
				: "";
			router.push(`/build/replay/${appId}${params}`);
		},
		[ownerEmail, router],
	);

	if (apps.length === 0 && emptyState) {
		return <>{emptyState}</>;
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
