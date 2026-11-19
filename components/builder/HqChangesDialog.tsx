/**
 * The Publishing card's dialog over what changed in CommCare HQ: the one
 * panel, on one project space, opened by the card's See what changed and by
 * the builder header's See what changed in CommCare HQ.
 *
 * Its record is the one the Publishing section holds (`usePublishingRecords`),
 * and every answer that moves the record folds into that store and bumps the
 * session's records revision, so the card and the Publish dialog read it.
 * Publishing over the changes closes this and opens the Publish dialog on the
 * project space with that choice made, so the person is not asked twice.
 *
 * Bringing the changes in reloads the app in this tab, which closes this
 * dialog wherever it was opened. `HqChangesBroughtInHost`, mounted with the
 * builder's header controls, opens it again on the answer the session held
 * (`HqChangesBroughtIn`), so the person reads that the changes are in.
 */
"use client";

import { type ReactElement, useCallback, useEffect } from "react";
import { usePublishingRecords } from "@/components/builder/app-setup/usePublishingRecords";
import { useApplyPreviewDeploymentAnswer } from "@/components/builder/DeploymentTargetProvider";
import { HqChangesPanel } from "@/components/builder/HqChangesPanel";
import {
	cardDriftReference,
	type HqChangesSettled,
} from "@/components/builder/hqChangesPanelModel";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import type { CommCareServer } from "@/lib/deployment";
import type { StoppedPublishingView } from "@/lib/deployment/actions";
import { activeRemoteApp } from "@/lib/deployment/resources";
import type { RemoteChangeDiscard } from "@/lib/deployment/types";
import {
	broughtInLine,
	HQ_CHANGES_DIALOG_TITLE,
} from "@/lib/publish/hqChangesCopy";
import {
	type HqChangesBroughtIn,
	useAccessPhase,
	useAppId,
	useCanDelete,
	useClearHqChangedTarget,
	useClearHqChangesBroughtIn,
	useHqChangesBroughtIn,
	useNoteDeploymentRecordsChanged,
	useRequestPublishDialog,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";

export function HqChangesDialog({
	open,
	onOpenChange,
	target,
	broughtIn,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	/** The project space whose changes the panel reads. */
	readonly target: { readonly server: CommCareServer; readonly domain: string };
	/**
	 * This tab's bring-in there landed and the app reloaded: the dialog says
	 * the changes are in, in place of reading CommCare HQ again.
	 */
	readonly broughtIn?: HqChangesBroughtIn;
}): ReactElement {
	const appId = useAppId();
	const { records, upsert } = usePublishingRecords();
	const noteDeploymentRecordsChanged = useNoteDeploymentRecordsChanged();
	const clearHqChangedTarget = useClearHqChangedTarget();
	const requestPublishDialog = useRequestPublishDialog();
	const applyPreviewAnswer = useApplyPreviewDeploymentAnswer();
	const canStop = useCanDelete();

	const view =
		records.views?.find(
			(candidate) =>
				candidate.deployment.deployment.server === target.server &&
				candidate.deployment.deployment.domain === target.domain,
		) ?? null;
	const { server, domain } = target;

	/* The record the bring-in answered, folded in once the dialog opens on it. */
	useEffect(() => {
		if (broughtIn === undefined) return;
		/* A record Nova could not read after the bring-in is read again. */
		if (broughtIn.deployment !== null) upsert(broughtIn.deployment);
		noteDeploymentRecordsChanged();
	}, [broughtIn, upsert, noteDeploymentRecordsChanged]);

	const handleSettled = useCallback(
		(settled: HqChangesSettled) => {
			clearHqChangedTarget({ server, domain });
			if (settled.deployment !== null) {
				upsert(settled.deployment);
				noteDeploymentRecordsChanged();
			} else if (settled.kind === "brought-in") {
				/* The changes landed and Nova could not read the record after
				 * them: the records are read again. */
				noteDeploymentRecordsChanged();
			}
		},
		[
			clearHqChangedTarget,
			server,
			domain,
			upsert,
			noteDeploymentRecordsChanged,
		],
	);
	const handlePublishOver = useCallback(
		(discard: RemoteChangeDiscard) => {
			onOpenChange(false);
			requestPublishDialog({ domain, discard });
		},
		[onOpenChange, requestPublishDialog, domain],
	);
	/* A state that names publishing over with no digest to name it by: the
	 * Publish dialog on this project space, where the publish stops on the
	 * change with its own Publish over this. */
	const handleOpenPublish = useCallback(() => {
		onOpenChange(false);
		requestPublishDialog({ domain });
	}, [onOpenChange, requestPublishDialog, domain]);
	/* The stop answers with the ended record and what Preview names and plays
	 * now, both read on the server after the ending landed, so they apply as
	 * they came; a record Nova could not read back is read again with the
	 * rest, as a stop that answered anything else is (`onRecordsStale`). */
	const handleStopped = useCallback(
		(next: StoppedPublishingView) => {
			if (next.view !== null) upsert(next.view);
			applyPreviewAnswer(next.preview);
			noteDeploymentRecordsChanged();
			clearHqChangedTarget({ server, domain });
			onOpenChange(false);
		},
		[
			upsert,
			applyPreviewAnswer,
			noteDeploymentRecordsChanged,
			clearHqChangedTarget,
			server,
			domain,
			onOpenChange,
		],
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg" data-hq-changes-dialog>
				<DialogHeader>
					<DialogTitle>{HQ_CHANGES_DIALOG_TITLE}</DialogTitle>
					<p className="text-[13px] text-nova-text-secondary">{domain}</p>
				</DialogHeader>
				<DialogBody>
					{/* Mounted while open, so each opening reads CommCare HQ afresh. */}
					{broughtIn !== undefined ? (
						<p
							role="status"
							className="mt-3 text-[13px] leading-relaxed text-nova-text"
						>
							{broughtInLine(broughtIn.discarded)}
						</p>
					) : open && appId !== undefined ? (
						<HqChangesPanel
							home="card"
							target={{ appId, server, domain }}
							deploymentId={view?.deployment.deployment.id ?? null}
							since={
								view === null ? { kind: "published" } : cardDriftReference(view)
							}
							remoteAppId={
								view === null
									? null
									: (activeRemoteApp(view.deployment)?.remoteId ?? null)
							}
							canStop={canStop}
							onSettled={handleSettled}
							onPublishOver={handlePublishOver}
							onStopped={handleStopped}
							onRecordsStale={noteDeploymentRecordsChanged}
							onOpenPublish={handleOpenPublish}
						/>
					) : null}
				</DialogBody>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>Close</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Opens the Publishing card's dialog on this tab's own bring-in once the
 * reload its commit forced has landed: the card's or the header's dialog
 * that sent it was closed by that reload. Mounted with the builder's header
 * controls, which stand only while app access is resolved, so the dialog
 * opens over the reloaded app and never under the access mask.
 *
 * The answer stays held in the session until the person closes the dialog,
 * and the dialog is drawn from it. A bring-in that answered before its own
 * reload landed opens here at once, and the reload then closes it (the
 * access gate closes every floating layer) and unmounts this host with the
 * header's controls; the held answer is what opens the dialog again once
 * access is resolved. So a close while access is not resolved is the
 * reload's, never the person's, and keeps the answer.
 */
export function HqChangesBroughtInHost(): ReactElement | null {
	const held = useHqChangesBroughtIn();
	const clearHeld = useClearHqChangesBroughtIn();
	const accessPhase = useAccessPhase();
	const session = useBuilderSessionApi();
	if (held === null || held.home !== "card" || accessPhase !== "authorized")
		return null;
	return (
		<HqChangesDialog
			open
			onOpenChange={(next) => {
				if (next) return;
				if (session.getState().accessPhase !== "authorized") return;
				clearHeld();
			}}
			target={{ server: held.server, domain: held.domain }}
			broughtIn={held}
		/>
	);
}
