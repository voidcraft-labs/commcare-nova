/**
 * The wait while a read or a create of one app is in flight: one spinner, the
 * stage the request's own stream names, a count of files that moves, patient
 * company after twenty seconds, and what leaving does. One component, two
 * sets of words, each with its form for a request lost twice.
 *
 * The count moves several times a second on an app with many files, so the
 * visible line is hidden from assistive technology and a visually hidden copy
 * of it, updated at most every ten files, is what the status region says.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BringInScreenLayout } from "@/components/bring-in/BringInScreenLayout";
import type { BringInModel } from "@/components/bring-in/bringInModel";
import { Button } from "@/components/shadcn/button";
import { Spinner } from "@/components/shadcn/spinner";
import type { ReadingStage } from "@/lib/deployment";
import {
	BRING_IN_ACTIONS,
	CREATING_LEAD,
	CREATING_LEAVE_LINE,
	CREATING_LOST_LINE,
	CREATING_SLOW_LINE,
	CREATING_STATUS,
	READING_LEAVE_LINE,
	READING_LOST_AFTER_CREATE_LINE,
	READING_LOST_LINE,
	READING_SLOW_LINE,
	readingStatusLine,
	TRYING_AGAIN,
} from "@/lib/publish/bringInCopy";
import { READING_STAGE_LABELS } from "@/lib/publish/hqReadingCopy";

/** How long a wait runs before the screen keeps the person company. */
const SLOW_AFTER_MS = 20_000;

/** How many files the announced count moves by. */
const ANNOUNCE_EVERY = 10;

type FileCount = { readonly done: number; readonly total: number };

function stageLabel(stage: ReadingStage, files: FileCount | null): string {
	const entry = READING_STAGE_LABELS[stage];
	return typeof entry === "function" ? entry(files) : entry;
}

/** The count a screen reader is told: moved only every ten files, and at the last. */
function announcedCount(files: FileCount | null): FileCount | null {
	if (files === null || files.done === files.total) return files;
	return {
		done: files.done - (files.done % ANNOUNCE_EVERY),
		total: files.total,
	};
}

/** True once the wait that began at `since` has run twenty seconds. */
function useSlowWait(since: number | null): boolean {
	const [reachedFor, setReachedFor] = useState<number | null>(null);
	useEffect(() => {
		if (since === null) return;
		const remaining = since + SLOW_AFTER_MS - Date.now();
		if (remaining <= 0) {
			setReachedFor(since);
			return;
		}
		const timer = setTimeout(() => setReachedFor(since), remaining);
		return () => clearTimeout(timer);
	}, [since]);
	return since !== null && reachedFor === since;
}

export function BringInReading({
	mode,
	model,
	appName,
	lost,
	onRetry,
}: {
	readonly mode: "reading" | "creating";
	readonly model: BringInModel;
	/** CommCare HQ's name for the app, where the page knows it. */
	readonly appName: string | null;
	/** Two requests in a row ended with no last line: the screen waits for the person. */
	readonly lost: boolean;
	readonly onRetry: () => void;
}) {
	const slow = useSlowWait(model.waitingSince);
	const { stage, files } = model;
	const reading = mode === "reading";
	/* On `creating` the heading already says what the stage would. */
	const showsStage = stage !== null && !lost && stage !== "creating";
	const title = reading ? readingStatusLine(appName) : CREATING_STATUS;
	return (
		<BringInScreenLayout
			title={
				<span className="inline-flex items-start gap-2.5">
					{lost ? null : (
						/* The heading says what is happening; the spinner is no second
						 * status region. */
						<Spinner
							role="presentation"
							aria-label={undefined}
							aria-hidden="true"
							className="mt-1 size-4 shrink-0 text-nova-text-muted"
						/>
					)}
					<span>{title}</span>
				</span>
			}
			lead={model.lead}
			status={
				<>
					{showsStage ? (
						<p className="mb-2 text-sm text-nova-text-secondary">
							<span aria-hidden="true">{stageLabel(stage, files)}</span>
							<span className="sr-only">
								{stageLabel(stage, announcedCount(files))}
							</span>
						</p>
					) : null}
					{model.lost === 1 ? (
						<p className="mb-2 text-sm font-medium text-nova-amber">
							{TRYING_AGAIN}
						</p>
					) : null}
				</>
			}
			description={reading ? undefined : CREATING_LEAD}
			footer={
				<>
					{lost ? (
						<Button type="button" onClick={onRetry}>
							{BRING_IN_ACTIONS.tryAgain}
						</Button>
					) : null}
					<Button
						variant="outline"
						nativeButton={false}
						render={<Link href="/" />}
					>
						{BRING_IN_ACTIONS.goToYourApps}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-3 text-sm leading-relaxed text-nova-text-secondary">
				{lost ? (
					<p role="alert" className="text-nova-text">
						{!reading
							? CREATING_LOST_LINE
							: model.lead === null
								? READING_LOST_LINE
								: /* The read a create's `read-again` asked for: that
									 * create may have added files to the Project. */
									READING_LOST_AFTER_CREATE_LINE}
					</p>
				) : null}
				{/* A read keeps its reassurance above what leaving does; a create
				 * says what leaving does first, under its lead, and the
				 * reassurance after it. */}
				{reading && slow && !lost ? <p>{READING_SLOW_LINE}</p> : null}
				<p className="text-nova-text-muted">
					{reading ? READING_LEAVE_LINE : CREATING_LEAVE_LINE}
				</p>
				{!reading && slow && !lost ? <p>{CREATING_SLOW_LINE}</p> : null}
			</div>
		</BringInScreenLayout>
	);
}
