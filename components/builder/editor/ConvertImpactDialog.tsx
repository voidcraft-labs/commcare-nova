/**
 * ConvertImpactDialog — the consent step for a kind conversion whose
 * per-row cast can fail (`planKindConversion`'s `dataLossRisk`).
 *
 * Opens the moment the convert gesture lands, checks the real impact
 * via `conversionImpactAction` (the store's own cast over the store's
 * own population, held cases included), and then:
 *
 *   - nothing would be set aside → the conversion dispatches with no
 *     further question (there is nothing to consent to; the brief
 *     "Checking saved data" state is the only trace);
 *   - some values can't convert → the dialog states the counts, shows
 *     the values, and the destructive action carries the consequence
 *     in its own label. Cancel changes nothing.
 *
 * The dispatched conversion is the ordinary gated `convertField`
 * batch — consent lives HERE, never on the mutations, so replay and
 * undo re-run the store migration unconditionally and the review
 * surface stays the recovery path.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DATA_TYPE_LABELS } from "@/components/builder/data-review/dataReviewModel";
import {
	DATA_TYPE_ICONS,
	NameChip,
} from "@/components/builder/data-review/NameChip";
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
import { Spinner } from "@/components/shadcn/spinner";
import type { CasePropertyDataType, FieldKind } from "@/lib/domain";
import { fieldRegistry } from "@/lib/domain";
import { conversionImpactAction } from "@/lib/preview/engine/caseDataBinding";
import type { JsonValue } from "@/lib/preview/engine/caseDataBindingTypes";

/** One pending conversion awaiting its impact check — the plan's
 *  `dataLossRisk` plus the addressing the dispatch needs. */
export interface ConvertImpactRequest {
	readonly fieldUuid: string;
	readonly toKind: FieldKind;
	readonly caseType: string;
	readonly property: string;
	readonly fromType: CasePropertyDataType;
	readonly toType: CasePropertyDataType;
}

/** What saved values would have to become, per destination type — the
 *  plural noun the "can’t become …" sentence hangs on. Sentence
 *  vocabulary only: the property CHIP keeps announcing data-review's
 *  `DATA_TYPE_LABELS`, so the same chip reads identically on every
 *  surface that renders it. */
const TYPE_NOUNS: Record<CasePropertyDataType, string> = {
	text: "text",
	int: "whole numbers",
	decimal: "numbers",
	date: "dates",
	time: "times of day",
	datetime: "dates with time",
	single_select: "single choices",
	multi_select: "choice lists",
	geopoint: "locations",
};

/** A sample value as the dialog shows it: strings in quotes, a
 *  selection list space-joined the way the app displays it, anything
 *  else via JSON — truncated so one long value can't blow the layout. */
function sampleText(value: JsonValue): string {
	const text = Array.isArray(value)
		? value.map(String).join(" ")
		: typeof value === "string"
			? value
			: JSON.stringify(value);
	const clipped = text.length > 42 ? `${text.slice(0, 41)}…` : text;
	return `“${clipped}”`;
}

type ImpactState =
	| { kind: "checking" }
	| {
			kind: "impact";
			totalWithValue: number;
			uncastable: number;
			alreadyHeld: number;
			samples: JsonValue[];
	  }
	| { kind: "error"; message: string };

export function ConvertImpactDialog({
	appId,
	request,
	onCancel,
	onConfirm,
}: {
	readonly appId: string;
	/** The conversion awaiting consent; null renders nothing. */
	readonly request: ConvertImpactRequest | null;
	readonly onCancel: () => void;
	/** Dispatch the conversion. The caller clears `request`. */
	readonly onConfirm: (request: ConvertImpactRequest) => void;
}) {
	/* The answered state is BOUND to the request it answers — the
	 * component stays mounted across requests (null-request renders
	 * nothing but keeps state), so an unbound state would let request
	 * A's zero-uncastable verdict auto-confirm request B before B's
	 * check even starts, silently bypassing the consent this dialog
	 * exists to collect. Any state whose request isn't the CURRENT one
	 * reads as "checking". */
	const [answered, setAnswered] = useState<{
		request: ConvertImpactRequest;
		state: ImpactState;
	} | null>(null);
	/* Generation counter: a result only lands while its fetch is still
	 * the newest one, so a request switch (or unmount) can't let a slow
	 * response clobber a fresher state. */
	const generation = useRef(0);

	const check = useCallback(() => {
		if (request === null) return;
		const gen = ++generation.current;
		setAnswered(null);
		const answer = (state: ImpactState) => {
			if (gen !== generation.current) return;
			setAnswered({ request, state });
		};
		conversionImpactAction({
			appId,
			caseType: request.caseType,
			property: request.property,
			toType: request.toType,
		}).then(
			(result) => {
				if (result.kind === "impact") {
					answer(result);
				} else {
					answer({
						kind: "error",
						message:
							result.kind === "unauthenticated"
								? "Your session ended. Sign in again, then retry."
								: result.message,
					});
				}
			},
			// A rejected action call (network failure, an interrupted
			// deploy) must land in the error state — an unhandled
			// rejection would strand the dialog on "Checking saved data"
			// with no way forward but Cancel.
			(err: unknown) => {
				answer({
					kind: "error",
					message:
						err instanceof Error ? err.message : "The check didn’t complete.",
				});
			},
		);
	}, [appId, request]);

	useEffect(() => {
		check();
		return () => {
			generation.current++;
		};
	}, [check]);

	const state: ImpactState =
		answered !== null && answered.request === request
			? answered.state
			: { kind: "checking" };

	/* Nothing would be set aside → nothing to consent to: dispatch and
	 * close without a question. Effect-driven so the render stays pure;
	 * the ref latches per request so a re-render (or an unstable
	 * `onConfirm` identity) can't dispatch the conversion twice. */
	const autoConfirmed = useRef<ConvertImpactRequest | null>(null);
	useEffect(() => {
		if (request === null) return;
		if (
			state.kind === "impact" &&
			state.uncastable === 0 &&
			autoConfirmed.current !== request
		) {
			autoConfirmed.current = request;
			onConfirm(request);
		}
	}, [state, request, onConfirm]);

	if (request === null) return null;

	const toLabel = fieldRegistry[request.toKind].label;
	const noun = TYPE_NOUNS[request.toType];
	const newlyHeld =
		state.kind === "impact" ? state.uncastable - state.alreadyHeld : 0;

	return (
		<AlertDialog
			open
			onOpenChange={(nextOpen) => {
				if (!nextOpen) onCancel();
			}}
		>
			<AlertDialogContent className="text-left">
				<AlertDialogHeader>
					<AlertDialogTitle className="font-display">
						Convert to {toLabel}?
					</AlertDialogTitle>
					{state.kind === "checking" && (
						<AlertDialogDescription className="flex items-center gap-2 text-left">
							<Spinner className="size-4 shrink-0" />
							Checking saved data…
						</AlertDialogDescription>
					)}
					{state.kind === "impact" && state.uncastable > 0 && (
						<AlertDialogDescription className="text-left">
							{state.uncastable} of {state.totalWithValue} saved{" "}
							{state.totalWithValue === 1 ? "value" : "values"} under{" "}
							<NameChip
								label={request.property}
								icon={DATA_TYPE_ICONS[request.fromType]}
								iconLabel={DATA_TYPE_LABELS[request.fromType]}
							/>{" "}
							can’t become {noun}. Each one moves to Data to review, and its
							case is held out of the app until you decide it there. Convert
							back and the values return automatically.
						</AlertDialogDescription>
					)}
					{state.kind === "error" && (
						<AlertDialogDescription className="text-left">
							Nova couldn’t check what this conversion would do to saved data.{" "}
							{state.message}
						</AlertDialogDescription>
					)}
				</AlertDialogHeader>
				{state.kind === "impact" && state.uncastable > 0 && (
					<div className="rounded-lg border border-white/[0.06] bg-nova-deep/50 p-3 text-[13px] leading-relaxed text-nova-text-secondary">
						{state.samples.map(sampleText).join(" · ")}
						{state.uncastable > state.samples.length &&
							` · and ${state.uncastable - state.samples.length} more`}
						{state.alreadyHeld > 0 && (
							<p className="mt-1 text-nova-text-muted">
								{state.alreadyHeld} of the affected cases{" "}
								{state.alreadyHeld === 1 ? "is" : "are"} already held for other
								values.
							</p>
						)}
					</div>
				)}
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					{state.kind === "impact" && state.uncastable > 0 && (
						<AlertDialogAction
							variant="destructive"
							onClick={() => onConfirm(request)}
						>
							{newlyHeld > 0
								? `Convert and hold ${newlyHeld} ${newlyHeld === 1 ? "case" : "cases"}`
								: "Convert"}
						</AlertDialogAction>
					)}
					{state.kind === "error" && (
						<AlertDialogAction onClick={check}>Check again</AlertDialogAction>
					)}
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
