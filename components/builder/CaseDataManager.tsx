/**
 * Builder-owned case-data controls. This lives in the breadcrumb strip rather
 * than inside the simulated app: Preview stays faithful to what a frontline
 * user sees, while the builder keeps one predictable place to create or
 * replace the real case rows used for testing.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import { useState } from "react";
import { describePopulateError } from "@/components/preview/shared/sampleData";
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
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import type { CaseType } from "@/lib/domain";
import {
	useCaseCount,
	usePopulateSampleCases,
	useResetSampleCases,
} from "@/lib/preview/hooks/useCaseDataBinding";
import { showToast } from "@/lib/ui/toastStore";

type Operation = "create" | "replace" | null;

function caseLabel(count: number): string {
	return `${count.toLocaleString()} ${count === 1 ? "case" : "cases"}`;
}

export function CaseDataManager({
	appId,
	caseType,
	canEdit,
	hasLinkedChildren,
}: {
	readonly appId: string;
	readonly caseType: CaseType;
	readonly canEdit: boolean;
	readonly hasLinkedChildren: boolean;
}) {
	const { state: countState, fetching } = useCaseCount({
		appId,
		caseType: caseType.name,
	});
	const populate = usePopulateSampleCases({ appId, caseType });
	const reset = useResetSampleCases({ appId, caseType });
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [operation, setOperation] = useState<Operation>(null);
	const [error, setError] = useState<string | null>(null);

	const count = countState.kind === "count" ? countState.count : undefined;
	const triggerSummary =
		count !== undefined
			? caseLabel(count)
			: countState.kind === "error" || countState.kind === "unauthenticated"
				? "Unavailable"
				: "Loading…";

	const createSamples = async () => {
		setOperation("create");
		setError(null);
		try {
			const result = await populate();
			if (result.kind !== "ok") {
				setError(describePopulateError(result, "Generate"));
				return;
			}
			setPopoverOpen(false);
			showToast(
				"info",
				"Sample cases created",
				`${caseLabel(result.inserted)} are ready to use in Preview.`,
			);
		} catch {
			setError("Could not create sample cases. Try again.");
		} finally {
			setOperation(null);
		}
	};

	const replaceSamples = async () => {
		setOperation("replace");
		setError(null);
		try {
			const result = await reset();
			if (result.kind !== "ok") {
				setError(describePopulateError(result, "Reset"));
				return;
			}
			setConfirmOpen(false);
			showToast(
				"info",
				"Case data replaced",
				`${caseLabel(result.inserted)} are ready to use in Preview.`,
			);
		} catch {
			setError("Could not replace these cases. Try again.");
		} finally {
			setOperation(null);
		}
	};

	const loading = operation !== null;

	return (
		<>
			<Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
				<PopoverTrigger
					aria-label={`Case data, ${triggerSummary}`}
					className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-nova-border bg-nova-surface/70 px-2.5 text-sm text-nova-text-secondary transition-colors hover:border-nova-violet/45 hover:bg-nova-elevated hover:text-nova-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nova-violet-bright/60 xl:px-3"
				>
					<Icon icon={tablerDatabase} width="16" height="16" />
					<span className="hidden items-center gap-2 xl:inline-flex">
						<span>Case data</span>
						<span className="text-nova-text-muted" aria-hidden="true">
							·
						</span>
					</span>
					<span className="text-nova-text">{triggerSummary}</span>
					{fetching && count !== undefined && (
						<Icon
							icon={tablerLoader2}
							width="14"
							height="14"
							className="animate-spin text-nova-text-muted"
							aria-label="Refreshing case count"
						/>
					)}
				</PopoverTrigger>
				<PopoverContent align="end" sideOffset={8} className="w-80 gap-4 p-4">
					<PopoverHeader>
						<PopoverTitle className="font-display text-base text-nova-text">
							Case data
						</PopoverTitle>
						<PopoverDescription className="leading-relaxed text-nova-text-secondary">
							These are the real cases used while you test this module.
						</PopoverDescription>
					</PopoverHeader>

					{countState.kind === "count" ? (
						<div className="space-y-3">
							<div>
								<p className="text-lg font-semibold text-nova-text">
									{caseLabel(countState.count)}
								</p>
								<p className="mt-0.5 text-xs leading-relaxed text-nova-text-muted">
									This total is unfiltered, so it may be larger than the current
									Results view.
								</p>
							</div>
							{canEdit ? (
								countState.count === 0 ? (
									<Button
										type="button"
										size="xl"
										className="w-full"
										disabled={loading}
										onClick={() => void createSamples()}
									>
										<Icon
											icon={
												operation === "create" ? tablerLoader2 : tablerSparkles
											}
											className={
												operation === "create" ? "animate-spin" : undefined
											}
										/>
										{operation === "create"
											? "Creating sample cases…"
											: "Create sample cases"}
									</Button>
								) : (
									<Button
										type="button"
										variant="outline"
										size="xl"
										className="w-full"
										disabled={loading}
										onClick={() => {
											setError(null);
											setPopoverOpen(false);
											setConfirmOpen(true);
										}}
									>
										<Icon icon={tablerRefresh} />
										Replace all {caseLabel(countState.count)}…
									</Button>
								)
							) : (
								<p className="rounded-lg bg-white/[0.04] px-3 py-2.5 text-xs leading-relaxed text-nova-text-muted">
									Only editors can create or replace case data.
								</p>
							)}
						</div>
					) : countState.kind === "error" ? (
						<p className="text-xs leading-relaxed text-nova-rose">
							{countState.message}
						</p>
					) : countState.kind === "unauthenticated" ? (
						<p className="text-xs leading-relaxed text-nova-text-secondary">
							Sign in again to view case data.
						</p>
					) : (
						<p className="flex items-center gap-2 text-sm text-nova-text-secondary">
							<Icon icon={tablerLoader2} className="animate-spin" />
							Loading case data…
						</p>
					)}

					{error && (
						<p
							role="alert"
							className="whitespace-pre-line text-xs leading-relaxed text-nova-rose"
						>
							{error}
						</p>
					)}
				</PopoverContent>
			</Popover>

			<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<AlertDialogContent className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display">
							Replace all {caseLabel(count ?? 0)}?
						</AlertDialogTitle>
						<AlertDialogDescription className="text-left text-pretty">
							This deletes every current case for this module—including cases
							entered by hand or through Preview—and replaces them with a new
							sample set.
							{hasLinkedChildren && (
								<>
									{" "}
									Cases elsewhere in this app that are linked to these cases
									will be kept, but those links will be cleared.
								</>
							)}{" "}
							This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{error && (
						<p
							role="alert"
							className="whitespace-pre-line text-xs leading-relaxed text-nova-rose"
						>
							{error}
						</p>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel size="xl" disabled={loading}>
							Keep current cases
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							size="xl"
							disabled={loading}
							onClick={() => void replaceSamples()}
						>
							{operation === "replace" && (
								<Icon icon={tablerLoader2} className="animate-spin" />
							)}
							{operation === "replace"
								? "Replacing cases…"
								: `Replace ${caseLabel(count ?? 0)}`}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
