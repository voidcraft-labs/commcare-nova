/**
 * The banner above an organization whose places are a copy CommCare HQ
 * manages: where they live, when the copy was last refreshed, and the refresh.
 *
 * The organization's own read says where the places come from (its `hq`);
 * the address in CommCare HQ and whether this viewer is connected there are
 * the deployment boundary's view, read once here, because `lib/organization`
 * reaches no CommCare HQ server. What a refresh pressed in this tab answered
 * (the places it kept because a persona or an owner rule still uses them)
 * stays until the tab's next refresh or reload: it is no stored fact.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Spinner } from "@/components/shadcn/spinner";
import {
	readManagedPlacesViewAction,
	refreshManagedPlacesAction,
} from "@/lib/deployment/managedDataActions";
import type { OrganizationSnapshot } from "@/lib/organization/types";
import {
	CONNECT_TO_REFRESH_PLACES,
	MANAGED_PLACES_LABEL,
	MANAGED_PLACES_NO_EXTERNAL_IDS,
	managedPlacesBanner,
	managedPlacesLeftOut,
	OPEN_IN_HQ,
	REFRESH_FROM_HQ,
	REFRESH_NEEDS_EDITOR,
} from "@/lib/publish/managedData";
import { useProjectCanEdit } from "@/lib/session/hooks";
import { KEPT_REFRESH_BUTTON_PENDING, keptDateText } from "../keptListModel";
import {
	managedPlacesOutcomeLines,
	managedPlacesRefreshControl,
} from "./organizationUi";

type PlacesView = NonNullable<
	Awaited<ReturnType<typeof readManagedPlacesViewAction>>
>;

const TRANSPORT_FAILURE =
	"Nova couldn't reach CommCare HQ's copy of these places. Check your connection and try again.";

type RefreshLines = {
	readonly tone: "status" | "alert";
	readonly lines: readonly string[];
};

/**
 * The last refresh's answer in this tab, by app. It outlives the banner's
 * unmount on a section switch and goes with the page, so a kept place stays
 * named until the next refresh or a reload.
 */
const lastRefreshByApp = new Map<string, RefreshLines>();

export function ManagedPlacesBanner({
	appId,
	hq,
	onRefreshed,
}: {
	appId: string;
	hq: NonNullable<OrganizationSnapshot["hq"]>;
	/** Reads the organization again once a refresh changed the copy. */
	onRefreshed: () => void;
}) {
	const canEdit = useProjectCanEdit();
	const [view, setView] = useState<
		| { readonly kind: "loading" }
		| { readonly kind: "data"; readonly value: PlacesView }
		| { readonly kind: "failed" }
	>({ kind: "loading" });
	const [attempt, setAttempt] = useState(0);
	const [refreshing, setRefreshing] = useState(false);
	const [outcome, setShownOutcome] = useState<RefreshLines | null>(
		() => lastRefreshByApp.get(appId) ?? null,
	);
	const setOutcome = (next: RefreshLines | null) => {
		if (next === null) lastRefreshByApp.delete(appId);
		else lastRefreshByApp.set(appId, next);
		setShownOutcome(next);
	};

	useEffect(() => {
		void attempt;
		let live = true;
		setView({ kind: "loading" });
		readManagedPlacesViewAction(appId)
			.then((value) => {
				if (live)
					setView(
						value === null ? { kind: "failed" } : { kind: "data", value },
					);
			})
			.catch(() => {
				if (live) setView({ kind: "failed" });
			});
		return () => {
			live = false;
		};
	}, [appId, attempt]);

	const loaded = view.kind === "data" ? view.value : null;
	const control = managedPlacesRefreshControl(
		loaded?.connected ?? false,
		canEdit,
	);
	const leftOut = managedPlacesLeftOut(hq.leftOut);

	const refresh = async () => {
		if (refreshing) return;
		setRefreshing(true);
		setOutcome(null);
		try {
			const answer = await refreshManagedPlacesAction(appId);
			setOutcome(managedPlacesOutcomeLines(answer));
			if (answer.ok) onRefreshed();
		} catch {
			setOutcome({ tone: "alert", lines: [TRANSPORT_FAILURE] });
		} finally {
			setRefreshing(false);
		}
	};

	return (
		<aside
			aria-labelledby="managed-places-banner-label"
			data-managed-places-banner
			className="max-w-prose space-y-2 rounded-xl border border-nova-violet/30 bg-nova-violet/[0.06] p-4"
		>
			<h3
				id="managed-places-banner-label"
				className="text-sm font-semibold text-nova-text"
			>
				{MANAGED_PLACES_LABEL}
			</h3>
			<p className="text-[13px] leading-relaxed text-nova-text-secondary">
				{managedPlacesBanner(
					hq.domain,
					keptDateText(hq.refreshedAt, new Date()),
				)}
			</p>
			<div className="flex flex-wrap items-center gap-2 pt-1">
				{control === "connect" && loaded !== null ? (
					<Link
						href="/settings"
						target="_blank"
						rel="noopener noreferrer"
						data-managed-places-connect
						className="nova-focusable inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-nova-violet-bright hover:underline"
					>
						{CONNECT_TO_REFRESH_PLACES}
						<Icon
							icon={tablerExternalLink}
							width="14"
							height="14"
							aria-hidden="true"
						/>
					</Link>
				) : (
					<Button
						type="button"
						variant="outline"
						className="gap-2"
						disabled={loaded === null || control !== "offered" || refreshing}
						onClick={() => void refresh()}
					>
						{refreshing ? (
							<Spinner className="size-4" />
						) : (
							<Icon
								icon={tablerRefresh}
								width="16"
								height="16"
								aria-hidden="true"
							/>
						)}
						{refreshing ? KEPT_REFRESH_BUTTON_PENDING : REFRESH_FROM_HQ}
					</Button>
				)}
				{loaded !== null && (
					<Button
						variant="ghost"
						className="gap-2"
						nativeButton={false}
						render={
							<a
								href={loaded.hqUrl}
								target="_blank"
								rel="noopener noreferrer"
							/>
						}
					>
						{OPEN_IN_HQ}
						<Icon
							icon={tablerExternalLink}
							width="14"
							height="14"
							aria-hidden="true"
						/>
					</Button>
				)}
			</div>
			{control === "needs-editor" && (
				<p className="text-[12px] leading-snug text-nova-text-muted">
					{REFRESH_NEEDS_EDITOR}
				</p>
			)}
			{view.kind === "failed" && (
				<p
					role="alert"
					className="text-[13px] leading-relaxed text-nova-text-secondary"
				>
					Nova couldn't read where these places live in CommCare HQ just now.{" "}
					<Button
						type="button"
						variant="ghost-action"
						onClick={() => setAttempt((current) => current + 1)}
					>
						Try again
					</Button>
				</p>
			)}
			<p className="text-[12px] leading-snug text-nova-text-muted">
				{MANAGED_PLACES_NO_EXTERNAL_IDS}
			</p>
			{leftOut !== null && (
				<p className="text-[13px] leading-relaxed text-nova-text-secondary">
					{leftOut}
				</p>
			)}
			{outcome !== null && (
				<div
					role={outcome.tone}
					className={`space-y-1 text-[13px] leading-relaxed ${
						outcome.tone === "alert"
							? "text-nova-rose"
							: "text-nova-text-secondary"
					}`}
				>
					{outcome.lines.map((line) => (
						<p key={line} className="[overflow-wrap:anywhere]">
							{line}
						</p>
					))}
				</div>
			)}
		</aside>
	);
}
