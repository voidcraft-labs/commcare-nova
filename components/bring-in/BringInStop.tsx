/**
 * A stop: a read of CommCare HQ ended at something that is no fact about the
 * app's content (a key HQ refused, a membership that ended, an app already in
 * Nova). One block draws every stop, from
 * `lib/publish/hqFindingCopy.ts::circumstanceBlock`: the whole screen for a
 * read's stop and a create's `changed` answer that carries one, the App
 * field's place for a stop met while choosing, and the block above the review
 * for a create answered `held`.
 *
 * Amber and an information mark, never a tick and never rose: a stop is no
 * error of the person's and no failure of Nova's. Nothing here decides which
 * actions a stop offers; `STOP_ACTIONS` does.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerExternalLink from "@iconify-icons/tabler/external-link";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import Link from "next/link";
import type { ReactNode } from "react";
import {
	type BringInLead,
	BringInScreenLayout,
} from "@/components/bring-in/BringInScreenLayout";
import {
	type StopAction,
	stopActionLabel,
} from "@/components/bring-in/bringInModel";
import { Button } from "@/components/shadcn/button";
import { stopNothingChangedLine } from "@/lib/publish/bringInCopy";
import {
	type CircumstanceContext,
	circumstanceBlock,
} from "@/lib/publish/hqFindingCopy";
import type { CircumstanceFinding } from "@/lib/publish/hqFindings";

/** One action of a stop, as a button or a link. The first a stop offers is its primary. */
export function StopActionControl({
	action,
	primary,
	onAction,
}: {
	readonly action: StopAction;
	readonly primary: boolean;
	readonly onAction: (action: StopAction) => void;
}) {
	const variant = primary ? "default" : "outline";
	const label = stopActionLabel(action);
	switch (action.kind) {
		case "open-settings":
			return (
				<Button
					variant={variant}
					nativeButton={false}
					render={
						<a href="/settings" target="_blank" rel="noopener noreferrer" />
					}
				>
					{label}
					<Icon icon={tablerExternalLink} aria-hidden="true" />
					<span className="sr-only">, opens in a new tab</span>
				</Button>
			);
		case "go-to-apps":
			return (
				<Button
					variant={variant}
					nativeButton={false}
					render={<Link href="/" />}
				>
					{label}
				</Button>
			);
		case "open-app":
			return (
				<Button
					variant={variant}
					nativeButton={false}
					render={<Link href={`/build/${action.appId}`} />}
				>
					{label}
				</Button>
			);
		case "check-again":
		case "choose-another-app":
			return (
				<Button
					type="button"
					variant={variant}
					onClick={() => onAction(action)}
				>
					{label}
				</Button>
			);
	}
}

/**
 * The block of one stop: its title, its body and its next step, every
 * placeholder filled. It sits under a screen's own heading (the picker's, or
 * the review's for a create answered `held`), so its title is an `h2`; a held
 * stop passes no actions, since the review's own button is the way on.
 */
export function BringInStopBlock({
	finding,
	context,
	children,
}: {
	readonly finding: CircumstanceFinding;
	readonly context: CircumstanceContext;
	/** What stands under the next step: the actions of a stop met while choosing. */
	readonly children?: ReactNode;
}) {
	const block = circumstanceBlock(finding, context);
	return (
		<section
			aria-label={block.title}
			className="rounded-xl border border-nova-amber/20 bg-nova-amber/[0.06] p-4"
		>
			<div className="flex items-start gap-3">
				<Icon
					icon={tablerInfoCircle}
					className="mt-0.5 size-5 shrink-0 text-nova-amber"
					aria-hidden="true"
				/>
				<div className="min-w-0 [overflow-wrap:anywhere]">
					<h2 className="text-sm font-semibold text-nova-text">
						{block.title}
					</h2>
					<p className="mt-1 text-sm leading-relaxed text-nova-text-secondary">
						{block.body}
					</p>
					<p className="mt-2 text-sm leading-relaxed text-nova-text-secondary">
						{block.next}
					</p>
				</div>
			</div>
			{children !== undefined ? (
				<div className="mt-3 flex flex-col gap-2 pl-8 @min-[35rem]:flex-row @min-[35rem]:flex-wrap">
					{children}
				</div>
			) : null}
		</section>
	);
}

/**
 * A stop as the whole screen: the title as the screen's heading, the body and
 * the next step, the line that nothing was created (under every stop but an
 * app already in Nova, whose own words say where the app is), a create's lead
 * above the heading where the model holds one, and the stop's actions.
 */
export function BringInStop({
	finding,
	context,
	lead,
	actions,
	onAction,
}: {
	readonly finding: CircumstanceFinding;
	readonly context: CircumstanceContext;
	/** Where the stop came from a create's answer, its lead. */
	readonly lead: BringInLead;
	readonly actions: readonly StopAction[];
	readonly onAction: (action: StopAction) => void;
}) {
	const block = circumstanceBlock(finding, context);
	const showsNothingChanged = finding.code !== "already-in-nova";
	const source = lead === null ? "read" : "create";
	return (
		<BringInScreenLayout
			title={block.title}
			icon="info"
			lead={lead}
			description={
				<>
					<p>{block.body}</p>
					<p className="mt-2">{block.next}</p>
				</>
			}
			footer={actions.map((action, index) => (
				<StopActionControl
					key={action.kind}
					action={action}
					primary={index === 0}
					onAction={onAction}
				/>
			))}
		>
			{showsNothingChanged ? (
				<p className="pl-8 text-sm leading-relaxed text-nova-text-muted">
					{stopNothingChangedLine(source)}
				</p>
			) : null}
		</BringInScreenLayout>
	);
}
