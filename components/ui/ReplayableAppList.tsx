"use client";
import { useReplay } from "@/hooks/useReplay";
import type { AppSummary } from "@/lib/db/apps";
import { AppCard } from "./AppCard";

interface ReplayableAppListProps {
	apps: AppSummary[];
	/** URL prefix for the replay logs endpoint — `${prefix}/${appId}/logs`. */
	logsUrlPrefix: string;
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
 * Client component because useReplay manages state and the replay callback
 * is an event handler passed to AppCard. Shared between the builds page
 * (user's own apps) and admin user detail page (admin viewing any user's apps).
 *
 * Props are all serializable (no functions) so this component can be rendered
 * from a Server Component parent.
 */
export function ReplayableAppList({
	apps,
	logsUrlPrefix,
	linkToApps = false,
	showReplay = true,
	emptyState,
}: ReplayableAppListProps) {
	const buildUrl = (id: string) => `${logsUrlPrefix}/${id}/logs`;
	const { handleReplay, replayingId, replayError } = useReplay({ buildUrl });

	if (apps.length === 0 && emptyState) {
		return <>{emptyState}</>;
	}

	return (
		<>
			{replayError && (
				<div className="text-center py-4" role="alert">
					<p className="text-nova-rose">{replayError}</p>
				</div>
			)}

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
						replayingId={replayingId}
					/>
				))}
			</div>
		</>
	);
}
