/**
 * App-wide case-property inventory and simultaneous rename authoring.
 *
 * This is the only builder surface that changes property identity. A field's
 * “Saves to” editor only retargets that field's own complete binding.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import tablerEdit from "@iconify-icons/tabler/edit";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerLock from "@iconify-icons/tabler/lock";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerTrash from "@iconify-icons/tabler/trash";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	availableCasePropertyRenameSources,
	type CasePropertyRenameDraftRow,
	casePropertyInventoryNames,
	casePropertyRenameSourceId,
	casePropertyRenameSources,
	parseCasePropertyRenameSourceId,
} from "@/components/builder/casePropertyRenameDraft";
import { propertyDisplayLabel } from "@/components/builder/shared/primitives/propertyDisplay";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useReconcilerContext } from "@/lib/collab/context";
import type {
	CasePropertyRenameImpact,
	CasePropertyRenameImpactGroupKey,
} from "@/lib/doc/casePropertyRenameImpact";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCasePropertyRenameReview } from "@/lib/doc/hooks/useCasePropertyRenameReview";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import {
	authoredCasePropertyNameSchema,
	CASE_SCALAR_PROPERTY_NAMES,
	type CaseType,
	humanizeId,
	standardCasePropertyDisplayLabel,
} from "@/lib/domain";
import type {
	CasePropertyRenamePreflightResult,
	CasePropertyRenameStorageImpact,
} from "@/lib/preview/engine/casePropertyRenamePreflightTypes";
import { useCasePropertyRenamePreflight } from "@/lib/preview/hooks/useCasePropertyRenamePreflight";

type Stage = "overview" | "compose" | "review";

const IMPACT_LABELS: Readonly<
	Record<CasePropertyRenameImpactGroupKey, string>
> = {
	"field-writers": "Question destinations",
	"case-operation-writes": "Case action writes",
	"typed-reads": "Conditions, calculations, and displays",
	"catalog-declarations": "Property definitions",
};

function typeLabel(value: string): string {
	return humanizeId(value) || value;
}

function propertyLabel(value: string): string {
	if (CASE_SCALAR_PROPERTY_NAMES.has(value)) {
		const standard = standardCasePropertyDisplayLabel(value);
		return standard === value ? humanizeId(value) || value : standard;
	}
	return humanizeId(value) || value;
}

function destinationError(value: string): string | null {
	const parsed = authoredCasePropertyNameSchema.safeParse(value);
	return parsed.success
		? null
		: (parsed.error.issues[0]?.message ?? "Choose a valid property name.");
}

function preflightError(result: CasePropertyRenamePreflightResult): string {
	switch (result.kind) {
		case "conflict":
			return result.conflicts
				.map(
					(conflict) =>
						`${typeLabel(conflict.caseType)} already has “${propertyLabel(conflict.property)}” in ${conflict.count.toLocaleString()} ${
							conflict.carrier === "case-row"
								? `case row${conflict.count === 1 ? "" : "s"}`
								: `saved value${conflict.count === 1 ? "" : "s"} in Data to review`
						}.`,
				)
				.join(" ");
		case "invalid":
			return (
				result.messages[0] ??
				"This rename no longer matches the app. Review it again."
			);
		case "forbidden":
			return "You no longer have access to review this app.";
		case "unauthenticated":
			return "You’re signed out. Reload the page, then try again.";
		case "not-found":
			return "This app is no longer available.";
		case "ok":
			return "";
	}
}

function ImpactReview({
	impact,
	storage,
}: {
	readonly impact: CasePropertyRenameImpact;
	readonly storage: CasePropertyRenameStorageImpact;
}) {
	return (
		<div className="grid gap-4">
			<div className="rounded-xl border border-nova-border bg-nova-elevated/45 p-4">
				<p className="font-medium text-nova-text">
					{impact.totalOccurrences.toLocaleString()} app reference
					{impact.totalOccurrences === 1 ? "" : "s"} will follow the new names
				</p>
				<ul className="mt-3 grid gap-2">
					{impact.groups.map((group) => (
						<li
							key={group.key}
							className="flex min-w-0 items-baseline justify-between gap-3 text-sm"
						>
							<span className="min-w-0 text-nova-text-secondary">
								{IMPACT_LABELS[group.key]}
							</span>
							<span className="shrink-0 tabular-nums text-nova-text">
								{group.occurrences.toLocaleString()}
							</span>
						</li>
					))}
				</ul>
			</div>
			<div className="rounded-xl border border-nova-border bg-nova-elevated/45 p-4">
				<p className="font-medium text-nova-text">Saved case data</p>
				<p className="mt-1 text-sm leading-relaxed text-nova-text-secondary">
					{storage.renamedRows.toLocaleString()} case row
					{storage.renamedRows === 1 ? "" : "s"} and{" "}
					{storage.renamedParkedValues.toLocaleString()} saved value
					{storage.renamedParkedValues === 1 ? "" : "s"} will follow the same
					simultaneous rename in Data to review.
				</p>
			</div>
		</div>
	);
}

export function CasePropertyRenameDialog({
	open,
	onOpenChange,
	caseTypes,
	canEdit,
	initialCaseType,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly caseTypes: readonly CaseType[];
	readonly canEdit: boolean;
	readonly initialCaseType?: string;
}) {
	const projectProse = useProseProjection();
	const titleRef = useRef<HTMLHeadingElement>(null);
	const nameInputId = useId();
	const { inline } = useBlueprintMutations();
	const reconcilerContext = useReconcilerContext();
	const { state: preflightState, preflight } = useCasePropertyRenamePreflight();
	const [stage, setStage] = useState<Stage>("overview");
	const [rows, setRows] = useState<readonly CasePropertyRenameDraftRow[]>([]);
	const [storageImpact, setStorageImpact] =
		useState<CasePropertyRenameStorageImpact | null>(null);
	const [reviewSeq, setReviewSeq] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const orderedCaseTypes = useMemo(() => {
		if (initialCaseType === undefined) return caseTypes;
		return [...caseTypes].toSorted((a, b) => {
			if (a.name === initialCaseType) return -1;
			if (b.name === initialCaseType) return 1;
			return 0;
		});
	}, [caseTypes, initialCaseType]);
	const sources = useMemo(
		() => casePropertyRenameSources(orderedCaseTypes),
		[orderedCaseTypes],
	);
	const renames = useMemo(
		() =>
			rows.map((row) => ({
				caseType: row.caseType,
				from: row.property,
				to: row.to,
			})),
		[rows],
	);
	const review = useCasePropertyRenameReview(renames);
	const rowNameErrors = rows.map((row) => destinationError(row.to));
	const relationReady =
		rows.length > 0 &&
		rowNameErrors.every((rowError) => rowError === null) &&
		review.ok;

	const reset = useCallback(() => {
		setStage("overview");
		setRows([]);
		setStorageImpact(null);
		setReviewSeq(null);
		setError(null);
		setSaving(false);
	}, []);

	useEffect(() => {
		if (!open) reset();
	}, [open, reset]);

	const addSource = useCallback((caseType: string, property: string) => {
		setRows((current) => [...current, { caseType, property, to: "" }]);
		setStage("compose");
		setStorageImpact(null);
		setReviewSeq(null);
		setError(null);
	}, []);

	const reviewRename = useCallback(async () => {
		if (!relationReady || !review.ok) return;
		setError(null);
		const result = await preflight(renames);
		if (result === undefined) return;
		if (result.kind !== "ok") {
			setError(preflightError(result));
			return;
		}
		setStorageImpact(result.report);
		setReviewSeq(result.mutationSeq);
		setStage("review");
		requestAnimationFrame(() => titleRef.current?.focus());
	}, [preflight, relationReady, renames, review]);

	const saveRename = useCallback(async () => {
		if (
			!canEdit ||
			!review.ok ||
			storageImpact === null ||
			reviewSeq === null
		) {
			return;
		}
		setSaving(true);
		setError(null);
		let saved = false;
		try {
			// Case rows can change independently of the Blueprint. Recheck them
			// immediately before the semantic command; the authoritative writer
			// proves the same relation again inside its transaction.
			const current = await preflight(renames);
			if (current === undefined) return;
			if (current.kind !== "ok") {
				setError(preflightError(current));
				setStage("compose");
				setStorageImpact(null);
				setReviewSeq(null);
				return;
			}
			if (reconcilerContext === null) {
				setError("Saving is not available. Reload the app, then try again.");
				return;
			}
			const reconciler = reconcilerContext.reconciler;
			const baseSeq = reconciler.getSnapshot().baseSeq;
			if (
				current.mutationSeq !== reviewSeq ||
				current.mutationSeq !== baseSeq
			) {
				setError("Case data changed; review again.");
				setStage("compose");
				setStorageImpact(null);
				setReviewSeq(null);
				return;
			}
			const watch = reconciler.watchNextHumanBatch([
				{
					kind: "renameCaseProperties",
					renames: renames.map(({ caseType, from, to }) => ({
						caseType,
						from,
						to,
					})),
				},
			]);
			const outcome = inline.renameCaseProperties(renames);
			if (!outcome.ok) {
				watch.cancel();
				setError(
					outcome.messages[0] ??
						"This rename is no longer available. Review it again.",
				);
				setStage("compose");
				setStorageImpact(null);
				setReviewSeq(null);
				return;
			}
			const saveOutcome = await watch.promise;
			switch (saveOutcome.kind) {
				case "saved":
					saved = true;
					break;
				case "conflict":
					setError("Case data changed; review again.");
					setStage("compose");
					setStorageImpact(null);
					setReviewSeq(null);
					break;
				case "accessChanged":
					setError(
						"Your access changed before this rename was saved. Review it again when editing is available.",
					);
					setStage("compose");
					setStorageImpact(null);
					setReviewSeq(null);
					break;
				case "tooLarge":
					setError(
						"This rename is too large to save in one request. Reload the app before making more changes.",
					);
					break;
				case "permanent":
					setError(
						"Saving is paused. Reload the app to continue from the last saved version.",
					);
					break;
				case "error":
					setError("Nova couldn’t save this rename. Try again.");
					break;
				case "cancelled":
					setError("Saving was interrupted. Review the rename again.");
					setStage("compose");
					setStorageImpact(null);
					setReviewSeq(null);
					break;
			}
		} finally {
			setSaving(false);
			if (saved) onOpenChange(false);
		}
	}, [
		canEdit,
		inline,
		onOpenChange,
		preflight,
		reconcilerContext,
		renames,
		review,
		reviewSeq,
		storageImpact,
	]);

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen, eventDetails) => {
				if (!nextOpen && saving) {
					eventDetails.cancel();
					titleRef.current?.focus();
					return;
				}
				onOpenChange(nextOpen);
			}}
		>
			<DialogContent
				initialFocus={titleRef}
				aria-busy={saving || preflightState.kind === "checking"}
				className="sm:max-w-2xl"
			>
				<DialogHeader>
					<DialogTitle
						ref={titleRef}
						tabIndex={-1}
						className="outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-nova-violet-bright/75"
					>
						{stage === "overview"
							? "Case properties"
							: stage === "compose"
								? "Rename case properties"
								: "Review case-property rename"}
					</DialogTitle>
					<DialogDescription>
						{stage === "overview"
							? "These names are shared by forms, case actions, conditions, displays, and saved case data throughout the app."
							: stage === "compose"
								? "Build one complete rename. Add every occupied destination as another source to make swaps, chains, and cycles without overwriting data."
								: "Nova will change every typed reference and every matching saved value together."}
					</DialogDescription>
				</DialogHeader>

				<DialogBody>
					{(saving || preflightState.kind === "checking") && (
						<p role="status" aria-live="polite" className="sr-only">
							{saving ? "Saving case-property rename…" : "Checking impact…"}
						</p>
					)}

					{stage === "overview" && (
						<div className="grid max-h-[55dvh] gap-4 overflow-y-auto pr-1">
							{orderedCaseTypes.map((caseType) => (
								<section
									key={caseType.name}
									aria-labelledby={`case-properties-${caseType.name}`}
									className="rounded-xl border border-nova-border"
								>
									<h3
										id={`case-properties-${caseType.name}`}
										className="border-b border-nova-border px-4 py-3 font-medium text-nova-text"
									>
										{typeLabel(caseType.name)}
									</h3>
									<ul className="divide-y divide-nova-border">
										{casePropertyInventoryNames(caseType).map((property) => {
											const locked = CASE_SCALAR_PROPERTY_NAMES.has(property);
											const authoredProperty = caseType.properties.find(
												(candidate) => candidate.name === property,
											);
											return (
												<li
													key={property}
													className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3"
												>
													<div className="min-w-0 flex-1">
														<p className="break-words font-medium text-nova-text [overflow-wrap:anywhere]">
															{authoredProperty === undefined
																? propertyLabel(property)
																: propertyDisplayLabel(
																		authoredProperty,
																		projectProse,
																	)}
														</p>
														<p className="break-all font-mono text-xs text-nova-text-muted">
															#{caseType.name}/{property}
														</p>
													</div>
													{locked ? (
														<span className="inline-flex min-h-11 shrink-0 items-center gap-1.5 text-xs text-nova-text-muted">
															<Icon icon={tablerLock} />
															Managed by Nova
														</span>
													) : canEdit ? (
														<Button
															type="button"
															variant="outline"
															className="min-h-11 shrink-0"
															onClick={() => addSource(caseType.name, property)}
														>
															<Icon icon={tablerEdit} />
															Rename
														</Button>
													) : null}
												</li>
											);
										})}
									</ul>
								</section>
							))}
						</div>
					)}

					{stage === "compose" && (
						<div className="grid gap-4">
							<div className="grid gap-3">
								{rows.map((row, index) => {
									const available = availableCasePropertyRenameSources(
										sources,
										rows,
										index,
									);
									const rowError =
										rowNameErrors[index] ??
										(!review.ok && review.renameIndex === index
											? review.reason
											: null);
									return (
										<div
											key={`${row.caseType}\0${row.property}`}
											className="grid gap-3 rounded-xl border border-nova-border bg-nova-elevated/35 p-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] sm:items-end"
										>
											<div className="grid min-w-0 gap-1.5 text-xs font-medium text-nova-text-secondary">
												<span id={`${nameInputId}-${index}-source`}>
													Current property
												</span>
												<Select
													value={casePropertyRenameSourceId(
														row.caseType,
														row.property,
													)}
													onValueChange={(value) => {
														if (value === null) return;
														const source =
															parseCasePropertyRenameSourceId(value);
														if (source === undefined) return;
														setRows((current) =>
															current.map((candidate, candidateIndex) =>
																candidateIndex === index
																	? { ...source, to: candidate.to }
																	: candidate,
															),
														);
													}}
												>
													<SelectTrigger
														aria-labelledby={`${nameInputId}-${index}-source`}
														wrapValue
														className="min-h-11 w-full"
													>
														<SelectValue>
															#{row.caseType}/{row.property}
														</SelectValue>
													</SelectTrigger>
													<SelectContent>
														{orderedCaseTypes.map((caseType) => (
															<SelectGroup key={caseType.name}>
																<SelectLabel>
																	{typeLabel(caseType.name)}
																</SelectLabel>
																{available
																	.filter(
																		(source) =>
																			source.caseType === caseType.name,
																	)
																	.map((source) => (
																		<SelectItem
																			key={casePropertyRenameSourceId(
																				source.caseType,
																				source.property,
																			)}
																			value={casePropertyRenameSourceId(
																				source.caseType,
																				source.property,
																			)}
																			wrap
																		>
																			#{source.caseType}/{source.property}
																		</SelectItem>
																	))}
															</SelectGroup>
														))}
													</SelectContent>
												</Select>
											</div>
											<Icon
												icon={tablerArrowRight}
												className="hidden self-center text-nova-text-muted sm:block"
												aria-hidden="true"
											/>
											<label
												htmlFor={`${nameInputId}-${index}`}
												className="grid min-w-0 gap-1.5 text-xs font-medium text-nova-text-secondary"
											>
												New name
												<Input
													id={`${nameInputId}-${index}`}
													value={row.to}
													aria-invalid={rowError !== null}
													aria-describedby={
														rowError
															? `${nameInputId}-${index}-error`
															: undefined
													}
													className="min-h-11 font-mono"
													placeholder="preferred_name"
													autoComplete="off"
													data-1p-ignore
													onChange={(event) => {
														const to = event.target.value;
														setRows((current) =>
															current.map((candidate, candidateIndex) =>
																candidateIndex === index
																	? { ...candidate, to }
																	: candidate,
															),
														);
														setError(null);
													}}
												/>
												{rowError && (
													<span
														id={`${nameInputId}-${index}-error`}
														className="text-xs leading-relaxed text-nova-rose"
													>
														{rowError}
													</span>
												)}
											</label>
											<Button
												type="button"
												variant="ghost"
												size="icon-lg"
												className="min-h-11 min-w-11 self-end text-nova-text-muted"
												aria-label={`Remove rename for ${row.property}`}
												onClick={() =>
													setRows((current) =>
														current.filter(
															(_, candidateIndex) => candidateIndex !== index,
														),
													)
												}
											>
												<Icon icon={tablerTrash} />
											</Button>
										</div>
									);
								})}
							</div>
							{availableCasePropertyRenameSources(sources, rows).length > 0 && (
								<Select
									value={null}
									onValueChange={(value) => {
										if (value === null) return;
										const source = parseCasePropertyRenameSourceId(value);
										if (source !== undefined) {
											addSource(source.caseType, source.property);
										}
									}}
								>
									<SelectTrigger className="min-h-11 w-full sm:w-auto">
										<Icon icon={tablerPlus} />
										<SelectValue placeholder="Rename another property" />
									</SelectTrigger>
									<SelectContent>
										{orderedCaseTypes.map((caseType) => (
											<SelectGroup key={caseType.name}>
												<SelectLabel>{typeLabel(caseType.name)}</SelectLabel>
												{availableCasePropertyRenameSources(sources, rows)
													.filter((source) => source.caseType === caseType.name)
													.map((source) => (
														<SelectItem
															key={casePropertyRenameSourceId(
																source.caseType,
																source.property,
															)}
															value={casePropertyRenameSourceId(
																source.caseType,
																source.property,
															)}
															wrap
														>
															#{source.caseType}/{source.property}
														</SelectItem>
													))}
											</SelectGroup>
										))}
									</SelectContent>
								</Select>
							)}
							{!review.ok &&
								rows.length > 0 &&
								review.renameIndex === undefined && (
									<p className="text-sm leading-relaxed text-nova-rose">
										{review.reason}
									</p>
								)}
						</div>
					)}

					{stage === "review" && review.ok && storageImpact !== null && (
						<>
							<ul className="grid gap-2">
								{renames.map((rename) => (
									<li
										key={`${rename.caseType}\0${rename.from}`}
										className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-nova-border px-3 py-2.5 font-mono text-xs"
									>
										<span className="break-all">
											#{rename.caseType}/{rename.from}
										</span>
										<Icon
											icon={tablerArrowRight}
											className="shrink-0 text-nova-text-muted"
										/>
										<span className="break-all">
											#{rename.caseType}/{rename.to}
										</span>
									</li>
								))}
							</ul>
							<ImpactReview impact={review.impact} storage={storageImpact} />
						</>
					)}

					{error && (
						<p
							role="alert"
							className="rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] p-3 text-sm leading-relaxed text-nova-rose"
						>
							{error}
						</p>
					)}
				</DialogBody>

				<DialogFooter className="flex-col-reverse sm:flex-row">
					{stage === "overview" ? (
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							Done
						</Button>
					) : (
						<Button
							type="button"
							variant="outline"
							disabled={saving || preflightState.kind === "checking"}
							onClick={() => {
								setError(null);
								if (stage === "review") {
									setStage("compose");
									setStorageImpact(null);
									setReviewSeq(null);
								} else if (rows.length === 0) {
									setStage("overview");
								} else {
									setStage("overview");
								}
							}}
						>
							Back
						</Button>
					)}
					{stage === "compose" && (
						<Button
							type="button"
							disabled={!relationReady || preflightState.kind === "checking"}
							onClick={() => void reviewRename()}
						>
							{preflightState.kind === "checking" && (
								<Icon icon={tablerLoader2} className="animate-spin" />
							)}
							Review impact
						</Button>
					)}
					{stage === "review" && canEdit && (
						<Button
							type="button"
							disabled={saving}
							onClick={() => void saveRename()}
						>
							{saving && <Icon icon={tablerLoader2} className="animate-spin" />}
							{saving ? "Saving" : "Rename everywhere"}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
