/** The Publish shell is synchronous. Loading its contents never suspends the Builder. */
"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { Spinner } from "@/components/shadcn/spinner";
import { useAccessPhase } from "@/lib/session/hooks";
import {
	createRecoverableLazyModule,
	getLazyModuleServerSnapshot,
} from "@/lib/ui/recoverableLazyModule";
import type { PublishDialogProps } from "./PublishDialogBody";

export type {
	PublishDownloadOutcome,
	PublishProjectSpaceCompatibilityOutcome,
} from "./PublishDialogBody";

const contents = createRecoverableLazyModule(
	() => import("./PublishDialogBody"),
);
const getServerSnapshot = () =>
	getLazyModuleServerSnapshot<typeof import("./PublishDialogBody")>();

/** Preloading is optional. Its failure belongs to the dialog's retry surface. */
export function preloadPublishDialog(): void {
	void contents.load().catch(() => undefined);
}

export function PublishDialog(props: PublishDialogProps) {
	const accessPhase = useAccessPhase();
	const heading = useRef<HTMLHeadingElement>(null);
	const snapshot = useSyncExternalStore(
		contents.subscribe,
		contents.getSnapshot,
		getServerSnapshot,
	);
	useEffect(() => {
		if (props.open && snapshot.status === "idle") preloadPublishDialog();
	}, [props.open, snapshot.status]);
	if (accessPhase !== "authorized") return null;
	return (
		<Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
			<DialogContent
				initialFocus={heading}
				className="h-[min(42rem,calc(100dvh-2rem))] gap-0 overflow-hidden p-0 sm:max-w-xl"
			>
				<DialogHeader className="border-b border-nova-border px-5 py-4">
					<DialogTitle
						ref={heading}
						tabIndex={-1}
						className="font-display tracking-tighter outline-none"
					>
						Publish app
					</DialogTitle>
					<DialogDescription>
						Choose a destination, then review what it needs
					</DialogDescription>
				</DialogHeader>
				{snapshot.status === "ready" ? (
					<snapshot.module.PublishDialogBody {...props} />
				) : (
					<>
						<DialogBody className="mx-0 flex flex-col items-center justify-center gap-3 px-5">
							{snapshot.status === "error" ? (
								<div role="alert" className="space-y-3 text-center">
									<p>Nova couldn't open publishing. You can try again.</p>
									<Button variant="outline" onClick={preloadPublishDialog}>
										Try again
									</Button>
								</div>
							) : (
								<div
									role="status"
									className="flex items-center gap-2 text-nova-text-secondary"
								>
									<Spinner className="size-4" />
									Opening publishing
								</div>
							)}
						</DialogBody>
						<DialogFooter className="border-t border-nova-border px-5 py-4">
							<DialogClose render={<Button variant="outline" />}>
								Cancel
							</DialogClose>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
