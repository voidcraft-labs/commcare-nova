/**
 * The banner above a table that came from CommCare HQ: where it lives, who
 * manages it now, and the actions that change that.
 *
 * Who manages the table is read from its manifest entry, which every open
 * builder is pushed, so a colleague's Manage in Nova turns this banner (and
 * every edit control on the page) over the moment the frame lands. The rest
 * (the address in CommCare HQ, whether this viewer is connected there, the
 * apps that read the table) is the deployment boundary's view, read again
 * whenever the table's revision moves. The day the copy was last refreshed is
 * read from the table, which this page reads again after its own refresh: a
 * refresh that found CommCare HQ's table unchanged stamps that day and moves
 * no revision, so the manifest never carries it.
 *
 * A control a person can't use stays on screen and says why: a role that
 * can't do it names who can, and a person with no CommCare HQ connection on
 * the table's server is invited to connect, in place of Refresh and the
 * hand-back, which read CommCare HQ with their own account.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { Badge } from "@/components/shadcn/badge";
import { Button } from "@/components/shadcn/button";
import { Spinner } from "@/components/shadcn/spinner";
import type { ManagedTableOutcome } from "@/lib/deployment/managedData";
import {
	letHqManageLookupTableAction,
	manageLookupTableInNovaAction,
	refreshManagedLookupTableAction,
} from "@/lib/deployment/managedDataActions";
import type { LookupTableSnapshot } from "@/lib/lookup/types";
import {
	CONNECT_TO_REFRESH_TABLE,
	LET_HQ_MANAGE_AGAIN,
	MANAGE_IN_NOVA,
	MANAGED_TABLE_BADGE,
	MANAGEMENT_NEEDS_ADMIN,
	managedInNovaBanner,
	managedTableBanner,
	managedTableBannerRefreshed,
	managedTableOutcomeLines,
	OPEN_IN_HQ,
	REFRESH_FROM_HQ,
	REFRESH_NEEDS_EDITOR,
} from "@/lib/publish/managedData";
import { useCanDelete, useProjectCanEdit } from "@/lib/session/hooks";
import { KEPT_REFRESH_BUTTON_PENDING, keptDateText } from "../keptListModel";
import { LetHqManageDialog, ManageInNovaDialog } from "./ManagedTableDialogs";
import type { ProjectDataWorkspace } from "./ProjectDataWorkspaceProvider";
import { managedTableBannerModel } from "./projectDataModel";
import { useManagedLookupTableView, useManifestEntry } from "./useProjectData";

const TRANSPORT_FAILURE =
	"Nova couldn't refresh its copy of this table. Check your connection and try again.";

export function ManagedTableBanner({
	table,
	workspace,
}: {
	table: LookupTableSnapshot;
	workspace: ProjectDataWorkspace;
}) {
	const hq = useManifestEntry(table.id)?.hq ?? table.hq;
	const view = useManagedLookupTableView(table);
	const canEdit = useProjectCanEdit();
	const canDelete = useCanDelete();
	const [dialog, setDialog] = useState<"manage" | "hand-back" | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [outcome, setOutcome] = useState<{
		readonly tone: "status" | "alert";
		readonly lines: readonly string[];
	} | null>(null);

	if (hq === undefined) return null;
	const loaded = view.state.kind === "data" ? view.state.value : null;
	const model = managedTableBannerModel(
		hq,
		loaded?.connected ?? false,
		canEdit,
		canDelete,
	);
	const refreshedAt = table.hq?.refreshedAt;
	const day =
		refreshedAt === undefined ? null : keptDateText(refreshedAt, new Date());

	/** After a change landed: the table, the manifest and the view are read again. */
	const settle = async (answer: ManagedTableOutcome) => {
		setOutcome(managedTableOutcomeLines(answer, hq.domain));
		if (answer.ok) {
			await Promise.all([
				workspace.reload(),
				workspace.reloadManifest(),
				view.reload(),
			]);
		}
	};

	const refresh = async () => {
		if (refreshing) return;
		setRefreshing(true);
		setOutcome(null);
		try {
			await settle(
				await refreshManagedLookupTableAction(table.projectId, table.id),
			);
		} catch {
			setOutcome({ tone: "alert", lines: [TRANSPORT_FAILURE] });
		} finally {
			setRefreshing(false);
		}
	};

	/** The confirmations' action: `null` once the change landed, else its refusal. */
	const change =
		(
			run: (projectId: string, tableId: string) => Promise<ManagedTableOutcome>,
		) =>
		async (): Promise<string | null> => {
			const answer = await run(table.projectId, table.id);
			if (!answer.ok) return answer.message;
			setDialog(null);
			await settle(answer);
			return null;
		};

	const connectLink = (
		<Link
			href="/settings"
			target="_blank"
			rel="noopener noreferrer"
			data-managed-table-connect
			className="nova-focusable inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-nova-violet-bright hover:underline"
		>
			{CONNECT_TO_REFRESH_TABLE}
			<Icon
				icon={tablerExternalLink}
				width="14"
				height="14"
				aria-hidden="true"
			/>
		</Link>
	);
	const reasons: string[] = [];

	let actions: ReactNode;
	if (model.kind === "managed-in-hq") {
		if (model.refresh === "needs-editor") reasons.push(REFRESH_NEEDS_EDITOR);
		if (model.manageInNova === "needs-admin")
			reasons.push(MANAGEMENT_NEEDS_ADMIN);
		actions = (
			<>
				{model.refresh === "connect" && loaded !== null ? (
					connectLink
				) : (
					<Button
						type="button"
						variant="outline"
						className="gap-2"
						disabled={
							loaded === null || model.refresh !== "offered" || refreshing
						}
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
				<Button
					type="button"
					variant="outline"
					disabled={
						loaded === null || model.manageInNova !== "offered" || refreshing
					}
					onClick={() => setDialog("manage")}
				>
					{MANAGE_IN_NOVA}
				</Button>
			</>
		);
	} else {
		if (model.handBack === "needs-admin") reasons.push(MANAGEMENT_NEEDS_ADMIN);
		actions =
			model.handBack === "connect" && loaded !== null ? (
				connectLink
			) : (
				<Button
					type="button"
					variant="outline"
					disabled={loaded === null || model.handBack !== "offered"}
					onClick={() => setDialog("hand-back")}
				>
					{LET_HQ_MANAGE_AGAIN}
				</Button>
			);
	}

	return (
		<aside
			aria-label={
				model.kind === "managed-in-hq"
					? MANAGED_TABLE_BADGE
					: "Managed in Nova, from CommCare HQ"
			}
			data-managed-table-banner={model.kind}
			className="mt-4 max-w-prose space-y-2 rounded-xl border border-nova-violet/30 bg-nova-violet/[0.06] p-4"
		>
			{model.kind === "managed-in-hq" ? (
				<>
					<Badge variant="violet">{MANAGED_TABLE_BADGE}</Badge>
					<p className="text-[13px] leading-relaxed text-nova-text">
						{managedTableBanner(hq.domain)}
					</p>
					{day !== null && (
						<p className="text-[13px] leading-relaxed text-nova-text-secondary">
							{managedTableBannerRefreshed(day)}
						</p>
					)}
				</>
			) : (
				<p className="text-[13px] leading-relaxed text-nova-text">
					{managedInNovaBanner(hq.domain)}
				</p>
			)}
			<div className="flex flex-wrap items-center gap-2 pt-1">{actions}</div>
			{reasons.map((reason) => (
				<p
					key={reason}
					className="text-[12px] leading-snug text-nova-text-muted"
				>
					{reason}
				</p>
			))}
			{view.state.kind === "failed" && (
				<p
					role="alert"
					className="text-[13px] leading-relaxed text-nova-text-secondary"
				>
					Nova couldn't read where this table lives in CommCare HQ just now.{" "}
					<Button
						type="button"
						variant="ghost-action"
						onClick={() => void view.reload()}
					>
						Try again
					</Button>
				</p>
			)}
			{outcome !== null && outcome.lines.length > 0 && (
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
			{loaded !== null && dialog === "manage" && (
				<ManageInNovaDialog
					open
					tableName={table.name}
					domain={hq.domain}
					apps={loaded.apps}
					onCancel={() => setDialog(null)}
					onConfirm={change(manageLookupTableInNovaAction)}
				/>
			)}
			{loaded !== null && dialog === "hand-back" && (
				<LetHqManageDialog
					open
					tableName={table.name}
					domain={hq.domain}
					typedColumns={table.columns
						.filter((column) => column.dataType !== "text")
						.map((column) => column.label)}
					apps={loaded.apps}
					onCancel={() => setDialog(null)}
					onConfirm={change(letHqManageLookupTableAction)}
				/>
			)}
		</aside>
	);
}
