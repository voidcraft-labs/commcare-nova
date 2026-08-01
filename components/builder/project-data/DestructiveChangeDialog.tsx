/**
 * The confirmation in front of a change that destroys shared data or breaks a
 * contract other apps depend on.
 *
 * **It names the apps.** Reference edges are exact and transactional, so this
 * surface can say "Household register and Referral follow-up still use this"
 * instead of warning generically that something somewhere might break. The
 * pre-flight read runs while the dialog opens — advisory by construction,
 * because a scan races a concurrent app commit and only the transactional edge
 * check under the table lock can authorize the change. If the commit refuses
 * anyway, its own blocking set is rendered in exactly the same words, so the
 * author never sees the warning and the refusal disagree.
 *
 * A soft-deleted app still holds its edges and still blocks the change, so it
 * is named WITH its trashed state. A blocker the author cannot find reads as
 * a phantom, and they will go looking for it.
 *
 * This is a real dialog, not the builder's confirm-in-place pattern: it has to
 * name a list, explain a consequence, and carry a typed destructive action,
 * which is more than an armed button can hold. Base UI's dialog primitives own
 * focus entry, containment, and return, so it needs no `useInlineConfirmFocus`.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import { useEffect, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { Button } from "@/components/shadcn/button";
import type { LookupColumnId } from "@/lib/domain/lookupIds";
import { getLookupReferencingAppsAction } from "@/lib/lookup/actions";
import type {
	LookupGovernanceFailure,
	LookupReferencingAppSummary,
	LookupTableSnapshot,
} from "@/lib/lookup/types";
import { PROJECT_DATA_SHARED_NOTICE } from "@/lib/routing/types";
import { useProjectId } from "@/lib/session/hooks";

export function DestructiveChangeDialog({
	open,
	table,
	columnId,
	title,
	consequence,
	confirmLabel,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	table: LookupTableSnapshot;
	/** Absent for a whole-table change; present narrows the blockers to the
	 *  apps that reference THAT column. */
	columnId?: LookupColumnId;
	title: string;
	consequence: string;
	confirmLabel: string;
	onCancel: () => void;
	/** Resolves `null` when the change landed, or the refusal that stopped it.
	 *  A refusal keeps the dialog open, beside the action that produced it —
	 *  and its `blockingApps` replace the advisory list, because the commit's
	 *  answer is the authoritative one. */
	onConfirm: () => Promise<LookupGovernanceFailure | null>;
}) {
	const projectId = useProjectId();
	const [preflight, setPreflight] = useState<
		| { readonly kind: "loading" }
		| {
				readonly kind: "ready";
				readonly blockers: readonly LookupReferencingAppSummary[];
		  }
		| { readonly kind: "failed"; readonly message: string }
	>({ kind: "loading" });
	const [retryGeneration, setRetryGeneration] = useState(0);
	const [working, setWorking] = useState(false);
	const [refusal, setRefusal] = useState<string | null>(null);
	const [refusedBy, setRefusedBy] = useState<
		readonly LookupReferencingAppSummary[] | null
	>(null);
	/* `true` means the transactional writer proved a reference exists but its
	 * secondary naming query failed. It is still an authoritative block; an
	 * empty advisory list must never turn that refusal into an enabled button. */
	const [unnamedReferenceRefusal, setUnnamedReferenceRefusal] = useState(false);

	useEffect(() => {
		void retryGeneration;
		/* A governance conflict advances the captured table generation in the
		 * parent. Re-run this advisory scan before enabling its second,
		 * explicitly reviewed confirmation. */
		void table.tableRevision;
		if (!open) return;
		setRefusal(null);
		setRefusedBy(null);
		setUnnamedReferenceRefusal(false);
		if (projectId === undefined) {
			setPreflight({
				kind: "failed",
				message:
					"Nova cannot verify which apps use this yet. Wait for the project to finish loading, then try again.",
			});
			return;
		}
		let live = true;
		setPreflight({ kind: "loading" });
		void getLookupReferencingAppsAction(projectId, {
			tableId: table.id,
			...(columnId === undefined ? {} : { columnId }),
		})
			.then((result) => {
				if (!live) return;
				setPreflight(
					result.success
						? { kind: "ready", blockers: result.value }
						: { kind: "failed", message: result.message },
				);
			})
			.catch(() => {
				if (!live) return;
				setPreflight({
					kind: "failed",
					message:
						"Nova could not check which apps use this. Check your connection and try again.",
				});
			});
		return () => {
			live = false;
		};
	}, [
		open,
		projectId,
		table.id,
		table.tableRevision,
		columnId,
		retryGeneration,
	]);

	/* The commit's own blocking set wins over the pre-flight one: it is the
	 * authoritative answer, and it may name an app that started referencing the
	 * resource while this dialog was open. */
	const named =
		refusedBy ??
		(preflight.kind === "ready" ? preflight.blockers : ([] as const));
	const blocked = named.length > 0 || unnamedReferenceRefusal;
	const checking = preflight.kind === "loading";
	const preflightFailed = preflight.kind === "failed";

	return (
		<AlertDialog
			open={open}
			onOpenChange={(next) => !next && !working && onCancel()}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>
						{PROJECT_DATA_SHARED_NOTICE} {consequence}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogBody>
					{checking ? (
						<p
							role="status"
							className="flex items-center gap-2 text-[13px] text-nova-text-secondary"
						>
							<Icon
								icon={tablerLoader2}
								width="16"
								height="16"
								className="animate-spin motion-reduce:animate-none"
								aria-hidden="true"
							/>
							Checking which apps use this…
						</p>
					) : preflight.kind === "failed" ? (
						<div
							role="alert"
							className="rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] p-3"
						>
							<p className="text-[13px] leading-relaxed text-nova-text-secondary">
								{preflight.message} Nothing can be changed until this check
								succeeds.
							</p>
							<Button
								type="button"
								variant="outline"
								className="mt-2 min-h-11"
								onClick={() => setRetryGeneration((current) => current + 1)}
							>
								<Icon icon={tablerRefresh} aria-hidden="true" />
								Try again
							</Button>
						</div>
					) : blocked ? (
						<div
							role={refusedBy === null ? undefined : "alert"}
							className="space-y-2 rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] p-3"
						>
							<p className="flex items-start gap-2 text-[13px] font-medium text-nova-text">
								<Icon
									icon={tablerAlertTriangle}
									width="16"
									height="16"
									className="mt-0.5 shrink-0 text-nova-rose"
									aria-hidden="true"
								/>
								{unnamedReferenceRefusal
									? "An app still uses this, so it can’t be changed"
									: named.length === 1
										? "One app still uses this, so it can’t be changed"
										: `${named.length} apps still use this, so it can’t be changed`}
							</p>
							{!unnamedReferenceRefusal && (
								<ul className="space-y-1 text-[13px] text-nova-text-secondary">
									{named.map((app) => (
										<li key={app.appId} className="[overflow-wrap:anywhere]">
											{app.appName}
											{app.deleted && (
												<span className="text-nova-text-muted">
													{" "}
													— in the trash, but it still counts
												</span>
											)}
										</li>
									))}
								</ul>
							)}
							<p className="text-[13px] leading-relaxed text-nova-text-secondary">
								{unnamedReferenceRefusal
									? "Nova could not load the app’s name. Nothing changed. Check references again before trying this action."
									: `Point ${named.length === 1 ? "that app" : "those apps"} somewhere else first, then come back.`}
							</p>
							{unnamedReferenceRefusal && (
								<Button
									type="button"
									variant="outline"
									className="min-h-11"
									onClick={() => {
										setPreflight({ kind: "loading" });
										setUnnamedReferenceRefusal(false);
										setRefusal(null);
										setRetryGeneration((current) => current + 1);
									}}
								>
									<Icon icon={tablerRefresh} aria-hidden="true" />
									Check references again
								</Button>
							)}
						</div>
					) : (
						<p
							role="status"
							className="text-[13px] leading-relaxed text-nova-text-secondary"
						>
							No app in this project uses it right now.
						</p>
					)}

					{refusal !== null && !blocked && (
						<p
							role="alert"
							className="text-[13px] leading-relaxed text-nova-rose"
						>
							{refusal}
						</p>
					)}
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={working} onClick={onCancel}>
						Cancel
					</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						disabled={checking || preflightFailed || working || blocked}
						onClick={async (event) => {
							/* The dialog stays open on a refusal so the reason lands beside
							 * the action, rather than closing and toasting it somewhere the
							 * author has already navigated away from. */
							event.preventDefault();
							setWorking(true);
							setRefusal(null);
							try {
								const failed = await onConfirm();
								if (failed !== null) {
									setRefusal(failed.message);
									if (
										failed.code === "referenced" &&
										(failed.blockingApps === undefined ||
											failed.blockingApps.length === 0)
									) {
										setUnnamedReferenceRefusal(true);
										setRefusedBy(null);
									} else if (failed.blockingApps !== undefined) {
										setRefusedBy(failed.blockingApps);
									}
								}
							} catch {
								setRefusal(
									"The change could not be made. Check your connection and try again.",
								);
							} finally {
								setWorking(false);
							}
						}}
					>
						{working ? "Working…" : confirmLabel}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
