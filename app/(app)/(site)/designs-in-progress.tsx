/**
 * Designs in progress (§15.9) — a separate section on the app list, above the
 * app cards.
 *
 * These are not apps and must not look like app cards: a design has no
 * modules, no forms, nothing to preview or publish. It is a conversation that
 * has not produced a workflow yet, so the row says where it got to and offers
 * the only two things that can be done with it — carry on, or let it go.
 *
 * Each row owns its own discard state (idle → confirming → discarding), like
 * the app cards do; the Server Action's `revalidatePath` re-runs the parent
 * RSC and the row drops out of the list on success.
 */

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerMessageQuestion from "@iconify-icons/tabler/message-question";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import Link from "next/link";
import { useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { Badge } from "@/components/shadcn/badge";
import { Button } from "@/components/shadcn/button";
import { Spinner } from "@/components/shadcn/spinner";
import { RelativeTime } from "@/components/ui/RelativeTime";
import type { DesignInProgressSummary } from "@/lib/db/designInProgress";
import { designStageLabel } from "@/lib/generation/designProgressWire";
import { discardDesign } from "./design-actions";

export function DesignsInProgress({
	designs,
}: {
	readonly designs: readonly DesignInProgressSummary[];
}) {
	if (designs.length === 0) return null;
	return (
		<section aria-labelledby="designs-in-progress-heading" className="mb-8">
			<h2
				id="designs-in-progress-heading"
				className="mb-1 text-sm font-medium text-nova-text"
			>
				Designs in progress
			</h2>
			<p className="mb-3 text-xs leading-5 text-nova-text-muted">
				Nova is still working these out with you. An app appears in your list as
				soon as the first workflow is built.
			</p>
			<ul className="grid gap-3">
				{designs.map((design) => (
					<li key={design.designSessionId} className="min-w-0">
						<DesignRow design={design} />
					</li>
				))}
			</ul>
		</section>
	);
}

type RowState =
	| { readonly type: "idle" }
	| { readonly type: "discarding" }
	| { readonly type: "error"; readonly message: string };

function DesignRow({ design }: { readonly design: DesignInProgressSummary }) {
	const [state, setState] = useState<RowState>({ type: "idle" });
	const [confirmOpen, setConfirmOpen] = useState(false);
	const discarding = state.type === "discarding";

	const runDiscard = async () => {
		setState({ type: "discarding" });
		try {
			const result = await discardDesign(design.designSessionId);
			if (result.success) {
				/* The revalidate drops this row from the list, so the component
				 * unmounts and there is no state to settle. */
				setConfirmOpen(false);
				return;
			}
			setConfirmOpen(false);
			setState({ type: "error", message: result.error });
		} catch {
			setConfirmOpen(false);
			setState({
				type: "error",
				message:
					"Nova couldn't reach the server to discard this design. Check your connection and try again.",
			});
		}
	};

	return (
		<div className="relative rounded-lg border border-nova-border bg-nova-surface p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-nova-violet/10">
					<Icon
						icon={tablerSparkles}
						aria-hidden="true"
						className="size-5 text-nova-violet-bright"
					/>
				</div>
				<div className="min-w-0 flex-1">
					<h3 className="truncate font-medium text-nova-text">
						{design.title}
					</h3>
					<p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-nova-text-secondary">
						{/* Stage is text, never color alone (§15.13). */}
						<span className="whitespace-nowrap">
							{designStageLabel(design.stage)}
						</span>
						<RelativeTime
							date={new Date(design.lastActivityAt)}
							className="whitespace-nowrap text-nova-text-muted first-letter:uppercase"
						/>
						{design.awaitingInput && (
							<Badge variant="amber">
								<Icon
									icon={tablerMessageQuestion}
									aria-hidden="true"
									className="size-3.5"
								/>
								Needs your answer
							</Badge>
						)}
					</p>
					{state.type === "error" && (
						<p role="alert" className="mt-1 text-xs leading-5 text-nova-rose">
							{state.message}
						</p>
					)}
					{!design.recoverable && (
						<p className="mt-1 flex items-start gap-1.5 text-xs leading-5 text-nova-text-muted">
							<Icon
								icon={tablerAlertTriangle}
								aria-hidden="true"
								className="mt-0.5 size-3.5 shrink-0 text-nova-amber"
							/>
							This design stopped on an error it can't carry on from. Open it to
							read what happened, or discard it.
						</p>
					)}
				</div>
				<div className="flex w-full shrink-0 items-center justify-end gap-2 min-[480px]:w-auto">
					<Button
						render={
							<Link href={`/build/new?design=${design.designSessionId}`} />
						}
						nativeButton={false}
						variant="outline"
						aria-label={`Resume ${design.title}`}
					>
						Resume
					</Button>
					<Button
						type="button"
						variant="ghost-destructive"
						disabled={discarding}
						onClick={() => {
							setState({ type: "idle" });
							setConfirmOpen(true);
						}}
						aria-label={`Discard ${design.title}`}
					>
						{discarding ? <Spinner /> : null}
						{discarding ? "Discarding" : "Discard"}
					</Button>
				</div>
			</div>

			<AlertDialog
				open={confirmOpen}
				onOpenChange={(open) => {
					/* Keep the confirmation up while the discard is in flight so its
					 * outcome lands somewhere the person is looking. */
					if (!open && discarding) return;
					setConfirmOpen(open);
				}}
			>
				<AlertDialogContent className="text-left" aria-busy={discarding}>
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display tracking-tighter">
							Discard this design?
						</AlertDialogTitle>
						{/* Discarding abandons the session and refunds an unsettled hold,
						    while retained records remain internal. User-facing copy names
						    the consequence without promising deletion. */}
						<AlertDialogDescription className="text-left text-pretty">
							Nova won’t continue this design, and you can’t return to it after
							discarding
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={discarding}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={discarding}
							onClick={() => void runDiscard()}
						>
							{discarding ? <Spinner /> : null}
							{discarding ? "Discarding" : "Discard design"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
