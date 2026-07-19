"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import {
	sessionContext,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";

export type AssignedCasesMode = "all" | "current-user" | "custom";
type StandardAssignedCasesMode = Exclude<AssignedCasesMode, "custom">;

const CURRENT_USER_OWNER_EXCLUSION = term(sessionContext("userid"));

const MODE_LABELS: Record<AssignedCasesMode, string> = {
	all: "Show in Results",
	"current-user": "Hide from Results",
	custom: "Keep saved setting",
};

export function assignedCasesMode(
	value: ValueExpression | undefined,
): AssignedCasesMode {
	if (value === undefined) return "all";
	if (
		value.kind === "term" &&
		value.term.kind === "session-context" &&
		value.term.field === "userid"
	) {
		return "current-user";
	}
	return "custom";
}

/**
 * The one authoring home for the owner-exclusion rule. It sits beside the
 * ordinary Cases available conditions because both constrain the same Results
 * population, while imported expressions remain lossless and readably opaque.
 */
export function AssignedCasesSetting({
	value,
	onChange,
	canEdit,
	hasError = false,
	reviewRequest,
}: {
	readonly value: ValueExpression | undefined;
	readonly onChange: (next: ValueExpression | undefined) => void;
	readonly canEdit: boolean;
	readonly hasError?: boolean;
	/** Repeated semantic requests must reopen a manually collapsed disclosure
	 * and land on the actual repair control, not merely the surrounding card. */
	readonly reviewRequest?: { readonly token: number };
}) {
	const selectId = useId();
	const mode = assignedCasesMode(value);
	const active = mode !== "all";
	const needsDisclosure = active || hasError;
	const [open, setOpen] = useState(needsDisclosure);
	const [pendingReplacement, setPendingReplacement] =
		useState<StandardAssignedCasesMode | null>(null);
	const wasNeeded = useRef(needsDisclosure);
	const disclosureTriggerRef = useRef<HTMLButtonElement>(null);
	const selectTriggerRef = useRef<HTMLButtonElement>(null);
	const pendingReviewTokenRef = useRef<number | null>(null);
	const handledReviewTokenRef = useRef<number | null>(null);
	useEffect(() => {
		if (needsDisclosure && !wasNeeded.current) setOpen(true);
		wasNeeded.current = needsDisclosure;
	}, [needsDisclosure]);
	useEffect(() => {
		if (
			reviewRequest === undefined ||
			handledReviewTokenRef.current === reviewRequest.token
		) {
			return;
		}
		handledReviewTokenRef.current = reviewRequest.token;
		pendingReviewTokenRef.current = reviewRequest.token;
		setOpen(true);
	}, [reviewRequest]);
	useLayoutEffect(() => {
		if (
			!open ||
			reviewRequest === undefined ||
			pendingReviewTokenRef.current !== reviewRequest.token
		) {
			return;
		}
		const frame = requestAnimationFrame(() => {
			(selectTriggerRef.current ?? disclosureTriggerRef.current)?.focus({
				preventScroll: true,
			});
			selectTriggerRef.current?.scrollIntoView({
				block: "center",
			});
			pendingReviewTokenRef.current = null;
		});
		return () => cancelAnimationFrame(frame);
	}, [open, reviewRequest]);

	const applyStandardMode = (next: StandardAssignedCasesMode) => {
		onChange(next === "all" ? undefined : CURRENT_USER_OWNER_EXCLUSION);
	};

	const setMode = (next: AssignedCasesMode | null) => {
		if (next === null || next === mode) return;
		if (next === "custom") return;
		if (mode === "custom") {
			setPendingReplacement(next);
			return;
		}
		applyStandardMode(next);
	};

	return (
		<>
			<Collapsible open={open} onOpenChange={setOpen}>
				<CollapsibleTrigger
					render={
						<Button
							ref={disclosureTriggerRef}
							type="button"
							variant="ghost"
							size="xl"
							className="w-full justify-start gap-2 rounded-none px-4 text-left not-disabled:hover:bg-white/[0.025] dark:not-disabled:hover:bg-white/[0.025]"
							aria-invalid={hasError || undefined}
						/>
					}
				>
					<Icon
						icon={tablerChevronRight}
						width="14"
						height="14"
						className={`shrink-0 text-nova-text-muted transition-transform ${open ? "rotate-90" : ""}`}
					/>
					<span className="min-w-0 flex-1 text-[14px] font-medium text-nova-text-secondary">
						More availability settings
					</span>
					{hasError ? (
						<span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-nova-rose">
							<Icon icon={tablerAlertCircle} width="14" height="14" />
							Needs attention
						</span>
					) : active ? (
						<span className="shrink-0 text-[12px] font-medium text-nova-violet-bright">
							In use
						</span>
					) : null}
				</CollapsibleTrigger>
				<CollapsibleContent className="space-y-3 px-4 pb-4 pt-2">
					{hasError ? (
						<div
							role="alert"
							className="flex items-start gap-2 rounded-xl border border-nova-rose/30 bg-nova-rose/[0.04] px-3 py-2.5 text-[13px] leading-relaxed text-nova-rose"
						>
							<Icon
								icon={tablerAlertCircle}
								width="15"
								height="15"
								className="mt-0.5 shrink-0"
							/>
							<p>
								{canEdit
									? "This saved assigned cases setting can’t run as written. Choose Show in Results or Hide from Results to replace it."
									: "This assigned cases setting needs attention. Ask someone who can edit the app to replace it."}
							</p>
						</div>
					) : null}
					<div>
						<label
							htmlFor={canEdit ? selectId : undefined}
							className="text-[13px] font-medium leading-5 text-nova-text-secondary"
						>
							Cases assigned to the person using the app
						</label>
						<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
							Choose whether those cases can appear in Results
						</p>
					</div>

					{canEdit ? (
						<Select value={mode} onValueChange={setMode}>
							<SelectTrigger
								ref={selectTriggerRef}
								id={selectId}
								data-assigned-cases-select
								className="h-auto min-h-11 w-full border-white/[0.08] bg-nova-deep/50 px-3 text-[14px] text-nova-text"
							>
								<SelectValue>{MODE_LABELS[mode]}</SelectValue>
							</SelectTrigger>
							<SelectContent align="start">
								<SelectItem value="all" className="min-h-11">
									{MODE_LABELS.all}
								</SelectItem>
								<SelectItem value="current-user" className="min-h-11">
									{MODE_LABELS["current-user"]}
								</SelectItem>
								{mode === "custom" && (
									<SelectItem value="custom" className="min-h-11">
										{MODE_LABELS.custom}
									</SelectItem>
								)}
							</SelectContent>
						</Select>
					) : (
						<p className="text-[14px] leading-relaxed text-nova-text-secondary">
							{mode === "all"
								? "These cases can appear in Results"
								: mode === "current-user"
									? "These cases are hidden from Results"
									: "Your saved setting decides which assigned cases can appear"}
						</p>
					)}

					{mode === "custom" && (
						<div
							role="status"
							className="rounded-xl border border-white/[0.07] bg-nova-deep/30 p-3"
						>
							<p className="text-[14px] font-medium text-nova-text-secondary">
								Some assigned cases may be hidden
							</p>
							<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
								{canEdit
									? "Your saved setting decides which ones can appear. Choose another option to replace it."
									: "Your saved setting decides which ones can appear"}
							</p>
						</div>
					)}
				</CollapsibleContent>
			</Collapsible>

			<AlertDialog
				open={pendingReplacement !== null}
				onOpenChange={(nextOpen) => {
					if (!nextOpen) setPendingReplacement(null);
				}}
			>
				<AlertDialogContent finalFocus={selectTriggerRef} className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle>
							{pendingReplacement === "all"
								? "Show assigned cases in Results?"
								: "Hide cases assigned to the person using the app?"}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingReplacement === "all"
								? "This replaces your saved setting. Cases it currently hides can appear in Results. You can undo this change."
								: "This replaces your saved setting, so some cases it currently hides may appear in Results. You can undo this change."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								if (pendingReplacement === null) return;
								applyStandardMode(pendingReplacement);
								setPendingReplacement(null);
							}}
						>
							{pendingReplacement === "all" ? "Show cases" : "Hide cases"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
