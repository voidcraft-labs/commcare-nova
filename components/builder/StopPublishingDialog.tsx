/**
 * The one confirmation before Nova stops publishing an app to a project
 * space: the question, what it does and how it is undone, and the action.
 *
 * The Publishing card and the Publish dialog's stop on a change made in
 * CommCare HQ both open it. Stopping asks CommCare HQ nothing and leaves the
 * app there exactly as it is; the server lets only a member who may delete
 * the Project's apps do it, and an editor who reaches it anyway reads the
 * refusal's own sentence here.
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
import { stopPublishingAction } from "@/lib/deployment/actions";
import {
	STOP_PUBLISHING_CANCEL,
	STOP_PUBLISHING_CONFIRM,
	stopPublishingConfirmBody,
	stopPublishingConfirmTitle,
} from "@/lib/publish/stopPublishing";

type StopPublishingData = Extract<
	Awaited<ReturnType<typeof stopPublishingAction>>,
	{ success: true }
>["data"];

export function StopPublishingDialog({
	open,
	onOpenChange,
	target,
	onStopped,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	/** The deployment to stop: the three fields `stopPublishingAction` takes. */
	readonly target: {
		readonly appId: string;
		readonly server: CommCareServer;
		readonly domain: string;
	};
	/** Called once with the action's answer when the stop succeeds, before the dialog closes. */
	readonly onStopped: (next: StopPublishingData) => void;
}): ReactElement {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { appId, server, domain } = target;

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
			const result = await stopPublishingAction({ appId, server, domain });
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
	}, [appId, server, domain, onStopped, onOpenChange]);

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
