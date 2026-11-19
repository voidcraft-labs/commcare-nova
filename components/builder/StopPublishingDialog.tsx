/**
 * The one confirmation before Nova stops publishing an app to a project
 * space: the question, what it does and how it is undone, and the action.
 *
 * The Publishing card and the Publish dialog's stop on a change made in
 * CommCare HQ both open it. Stopping asks CommCare HQ nothing and leaves the
 * app there exactly as it is; the server lets only a member who may delete
 * the Project's apps do it, and an editor who reaches it anyway reads the
 * refusal's own sentence here.
 *
 * The stop names the HQ app the surface drew it over when it opened, so it
 * ends publishing to that app or to nothing: where the deployment publishes
 * to another HQ app by the time it lands, the server stops nothing and says
 * so, and the dialog keeps naming the app it opened over.
 *
 * A stop that did not answer with a stopped record tells its surface to read
 * the records again (`onRecordsStale`): an answer lost on the way may follow
 * a stop that landed, and a refusal that there is nothing to stop, or that the
 * deployment publishes elsewhere now, means the record on screen is older
 * than the deployment.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import { type ReactElement, useCallback, useState } from "react";
import { stopFailureSentence } from "@/components/builder/app-setup/publishingSectionModel";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { Button } from "@/components/shadcn/button";
import type { CommCareServer } from "@/lib/deployment";
import {
	type StoppedPublishingView,
	stopPublishingAction,
} from "@/lib/deployment/actions";
import {
	STOP_PUBLISHING_CANCEL,
	STOP_PUBLISHING_CONFIRM,
	stopPublishingConfirmBody,
	stopPublishingConfirmTitle,
} from "@/lib/publish/stopPublishing";

/** The deployment a stop names, and the HQ app the surface drew it over. */
export interface StopPublishingTarget {
	readonly appId: string;
	readonly server: CommCareServer;
	readonly domain: string;
	/** The HQ app the deployment's live mapping named when the surface read it. */
	readonly hqAppId: string;
}

export function StopPublishingDialog({
	open,
	onOpenChange,
	target,
	onStopped,
	onRecordsStale,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	/** The deployment to stop: the four fields `stopPublishingAction` takes. */
	readonly target: StopPublishingTarget;
	/** Called once with the action's answer when the stop succeeds, before the dialog closes. */
	readonly onStopped: (next: StoppedPublishingView) => void;
	/**
	 * Called once when the stop answered anything but a stop, or no answer
	 * arrived: the surface reads where the app stands again.
	 */
	readonly onRecordsStale: () => void;
}): ReactElement {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/* The HQ app a stop names is the one the dialog opened over. A surface
	 * that reads its records again while the dialog is open (as a refusal
	 * asks it to) never moves it, so pressing Stop publishing again can't
	 * stop an app the person never looked at; closing and opening again
	 * names the one the surface shows then. */
	const [opened, setOpened] = useState<StopPublishingTarget | null>(
		open ? target : null,
	);
	if (open && opened === null) setOpened(target);
	if (!open && opened !== null) setOpened(null);
	const { appId, server, domain, hqAppId } = opened ?? target;

	const handleOpenChange = useCallback(
		(next: boolean) => {
			/* The stop is on its way; closing now would hide its answer. */
			if (!next && pending) return;
			/* A sentence speaks of the attempt it answered, so the next opening
			 * starts without it. */
			if (!next) setError(null);
			onOpenChange(next);
		},
		[pending, onOpenChange],
	);

	const handleStop = useCallback(async () => {
		setPending(true);
		setError(null);
		try {
			const result = await stopPublishingAction({
				appId,
				server,
				domain,
				hqAppId,
			});
			if (result.success) {
				onStopped(result.data);
				setPending(false);
				onOpenChange(false);
				return;
			}
			setError(stopFailureSentence(result));
		} catch {
			setError(stopFailureSentence(null));
		}
		setPending(false);
		onRecordsStale();
	}, [appId, server, domain, hqAppId, onStopped, onOpenChange, onRecordsStale]);

	return (
		<AlertDialog open={open} onOpenChange={handleOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{stopPublishingConfirmTitle(domain)}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{stopPublishingConfirmBody(domain)}
					</AlertDialogDescription>
					{error !== null ? (
						<p
							role="alert"
							className="text-[13px] leading-relaxed text-nova-rose"
						>
							{error}
						</p>
					) : null}
				</AlertDialogHeader>
				<AlertDialogFooter className="flex-wrap">
					<AlertDialogCancel disabled={pending}>
						{STOP_PUBLISHING_CANCEL}
					</AlertDialogCancel>
					<Button
						type="button"
						variant="ghost-destructive"
						onClick={handleStop}
						disabled={pending}
						aria-busy={pending}
					>
						{pending ? (
							<Icon
								icon={tablerLoader2}
								className="size-4 animate-spin"
								aria-hidden="true"
							/>
						) : null}
						{STOP_PUBLISHING_CONFIRM}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
