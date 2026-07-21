/**
 * DataReviewScreen — the review surface for saved case values a schema
 * conversion couldn't carry (`/build/{appId}/{moduleUuid}/data-review`).
 *
 * Everything shown is the Server Action's server-computed truth: the
 * case grouping / filter / notice DERIVATIONS live in the pure
 * `dataReviewModel.ts`, the per-entry verdicts come from
 * `listParkedValues` (computed against the property's current
 * declaration, re-proven at write time), and this component only
 * renders and dispatches.
 *
 * Design rules (the review-round bar): the CASE is the anchor — one
 * card per case, its waiting values as rows — because people review
 * records, not floating values. Every action is a visible labeled
 * button (no overflow menus at any width), each row emphasizes its ONE
 * primary action for its state, explanation lives at the point of
 * action (tooltips, the per-property notice), every put-back reports
 * where the value went, and no invented vocabulary — plain words only.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerArchive from "@iconify-icons/tabler/archive";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import tablerRestore from "@iconify-icons/tabler/restore";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import tablerX from "@iconify-icons/tabler/x";
import { useId, useState } from "react";
import { usePromptInputController } from "@/components/ai-elements/prompt-input";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { Button } from "@/components/shadcn/button";
import { Checkbox } from "@/components/shadcn/checkbox";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { useMaterializableCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useModule } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/doc/types";
import type { CaseProperty, CasePropertyDataType } from "@/lib/domain";
import { humanizeId } from "@/lib/domain";
import type {
	CasePropertyFailure,
	ParkedValueEntryWire,
} from "@/lib/preview/engine/caseDataBindingTypes";
import {
	useParkedValues,
	useReplaceParkedValue,
	useRestoreParkedValues,
	useSetParkedValuesDismissed,
} from "@/lib/preview/hooks/useCaseDataBinding";
import { useAppId, useCanEdit, useSetSidebarOpen } from "@/lib/session/hooks";
import { showToast } from "@/lib/ui/toastStore";
import {
	type ConvertBackNotice,
	convertBackNotices,
	DATA_TYPE_LABELS,
	dataTypePhrase,
	displayReviewValue,
	filterReviewEntries,
	groupReviewByCase,
	type ReviewCaseGroup,
	type ReviewFilter,
	readyIds,
	replacementDraftToValue,
	reviewCounts,
} from "./dataReviewModel";

/**
 * The property's CURRENT type for display copy. A declared property
 * with no explicit `data_type` IS text (the schema's implied
 * default) — falling back to the park's `toType` there would name a
 * type the property no longer holds. Only a property missing from
 * the catalog entirely (a rename park's retired source) borrows the
 * park's target as the best available description.
 */
function currentTypeOf(
	decl: CaseProperty | undefined,
	parkTarget: CasePropertyDataType,
): CasePropertyDataType {
	if (decl === undefined) return parkTarget;
	return decl.data_type ?? "text";
}

/** The Replace editor's in-progress draft for one entry. */
interface ReplaceDraft {
	readonly entryId: string;
	readonly text: string;
	readonly selections: readonly string[];
	readonly failures: readonly CasePropertyFailure[] | null;
	readonly saving: boolean;
}

export function DataReviewScreen({ moduleUuid }: { moduleUuid: Uuid }) {
	const appId = useAppId();
	const canEdit = useCanEdit();
	const module = useModule(moduleUuid);
	const caseTypes = useMaterializableCaseTypes();
	const caseType = caseTypes.find(
		(candidate) => candidate.name === module?.caseType,
	);

	const { state, fetching, reload } = useParkedValues({
		appId,
		caseType: caseType?.name,
	});

	const [filter, setFilter] = useState<ReviewFilter>("all");
	const [replaceDraft, setReplaceDraft] = useState<ReplaceDraft | null>(null);
	const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

	const restore = useRestoreParkedValues({ appId, caseType: caseType?.name });
	const setDismissed = useSetParkedValuesDismissed({
		appId,
		caseType: caseType?.name,
	});
	const replace = useReplaceParkedValue({ appId, caseType: caseType?.name });
	const setSidebarOpen = useSetSidebarOpen();
	const composer = usePromptInputController();

	if (caseType === undefined) return null;

	const propertyDecl = (name: string): CaseProperty | undefined =>
		caseType.properties.find((property) => property.name === name);
	const propertyLabel = (name: string): string =>
		propertyDecl(name)?.label ?? humanizeId(name);

	const withBusy = async (ids: readonly string[], run: () => Promise<void>) => {
		setBusyIds((prev) => new Set([...prev, ...ids]));
		try {
			await run();
		} finally {
			setBusyIds((prev) => {
				const next = new Set(prev);
				for (const id of ids) next.delete(id);
				return next;
			});
		}
	};

	const putBackEntries = (ids: readonly string[]) =>
		withBusy(ids, async () => {
			const result = await restore([...ids]);
			if (result.kind !== "restored") {
				showToast(
					"error",
					ids.length === 1
						? "Couldn't put the value back"
						: "Couldn't put the values back",
					result.kind === "error"
						? result.message
						: "You're signed out. Reload the page to sign in again.",
				);
				return;
			}
			// A put-back succeeds SILENTLY from the row's point of view —
			// the entry just leaves the list — so every outcome gets a
			// toast saying where the values went. A kept remainder means
			// the verdict moved between render and write (a teammate's
			// edit, a fresh conversion); the re-listed rows show why.
			if (result.kept === 0) {
				showToast(
					"info",
					result.restored === 1
						? "1 value put back"
						: `${result.restored} values put back`,
					result.restored === 1
						? "It's saved on its case again."
						: "They're saved on their cases again.",
				);
			} else if (result.restored > 0) {
				showToast(
					"warning",
					`Put back ${result.restored} of ${result.restored + result.kept} values`,
					"The rest no longer fit the current type, or their cases hold newer values.",
				);
			} else {
				showToast(
					"warning",
					result.kept === 1
						? "It can't go back right now"
						: "They can't go back right now",
					result.kept === 1
						? "It no longer fits the property's current type, or its case now holds a newer value."
						: "They no longer fit the property's current type, or their cases now hold newer values.",
				);
			}
		});

	const undismissEntries = (ids: readonly string[]) =>
		withBusy(ids, async () => {
			const result = await setDismissed([...ids], false);
			if (result.kind !== "toggled") {
				showToast(
					"error",
					"Couldn't move it back",
					result.kind === "error"
						? result.message
						: "You're signed out. Reload the page to sign in again.",
				);
			}
		});

	const dismissEntries = (ids: readonly string[]) =>
		withBusy(ids, async () => {
			const result = await setDismissed([...ids], true);
			if (result.kind !== "toggled") {
				showToast(
					"error",
					"Couldn't dismiss",
					result.kind === "error"
						? result.message
						: "You're signed out. Reload the page to sign in again.",
				);
				return;
			}
			showToast(
				"info",
				result.count === 1
					? "Value dismissed"
					: `${result.count} values dismissed`,
				result.count === 1
					? "Nothing was deleted. Find it under the Dismissed filter."
					: "Nothing was deleted. Find them under the Dismissed filter.",
				{
					action: {
						label: "Undo",
						onPress: () => {
							void undismissEntries(ids);
						},
					},
				},
			);
		});

	const saveReplacement = (entry: ParkedValueEntryWire) => {
		if (replaceDraft === null || replaceDraft.entryId !== entry.id) return;
		const currentType = propertyDecl(entry.property)?.data_type ?? "text";
		const draft = replacementDraftToValue(
			currentType,
			currentType === "multi_select"
				? replaceDraft.selections
				: replaceDraft.text,
		);
		if (!draft.ok) return;
		setReplaceDraft({ ...replaceDraft, saving: true, failures: null });
		void (async () => {
			const result = await replace(entry.id, draft.value);
			if (result.kind === "replaced") {
				setReplaceDraft(null);
				return;
			}
			if (result.kind === "invalid-value") {
				setReplaceDraft((prev) =>
					prev?.entryId === entry.id
						? { ...prev, saving: false, failures: result.failures }
						: prev,
				);
				return;
			}
			setReplaceDraft(null);
			if (result.kind === "not-found") {
				showToast(
					"info",
					"This value moved on",
					"It was put back, replaced, or its case was removed. The list is refreshed.",
				);
				await reload();
				return;
			}
			showToast(
				"error",
				"Couldn't save the replacement",
				result.kind === "error"
					? result.message
					: "You're signed out. Reload the page to sign in again.",
			);
		})();
	};

	const askNovaToConvertBack = (notice: ConvertBackNotice) => {
		composer.textInput.setInput(
			`Convert ${propertyLabel(notice.property)} back to ${DATA_TYPE_LABELS[notice.fromType]}`,
		);
		setSidebarOpen("chat", true);
		requestAnimationFrame(() => {
			document
				.querySelector<HTMLTextAreaElement>('textarea[name="message"]')
				?.focus();
		});
	};

	const entries = state.kind === "entries" ? state.entries : [];
	const counts = reviewCounts(entries);
	const ready = readyIds(entries);
	const notices = convertBackNotices(entries);
	const groups = groupReviewByCase(filterReviewEntries(entries, filter));

	return (
		<div className="@container">
			<ContentFrame width="5xl" className="px-6 pt-7 pb-16">
				<div className="flex flex-wrap items-start gap-3">
					<div className="min-w-0 flex-1">
						<h1 className="font-display text-2xl font-semibold tracking-tight text-nova-text">
							Data to review
						</h1>
						<p className="mt-2 max-w-2xl text-sm leading-relaxed text-pretty text-nova-text-secondary">
							Saved values that stopped fitting when a property changed. Nothing
							was deleted.
						</p>
					</div>
					{canEdit && ready.length > 1 && filter !== "dismissed" && (
						<Button
							type="button"
							className="min-h-11"
							disabled={ready.some((id) => busyIds.has(id))}
							onClick={() => putBackEntries(ready)}
						>
							<Icon icon={tablerRestore} />
							Put back all {ready.length}
						</Button>
					)}
				</div>
				{!canEdit && entries.length > 0 && (
					<p className="mt-3 max-w-2xl rounded-lg bg-nova-elevated px-3 py-2.5 text-sm leading-relaxed text-nova-text-secondary">
						You can view this list, but putting values back or changing them
						needs edit access
					</p>
				)}

				{state.kind === "loading" || state.kind === "idle" ? (
					<p className="mt-8 flex items-center gap-2 text-sm text-nova-text-secondary">
						<Icon icon={tablerLoader2} className="animate-spin" width="16" />
						Loading…
					</p>
				) : state.kind !== "entries" ? (
					<div
						role="alert"
						className="mt-8 max-w-md rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] p-4"
					>
						<p className="font-medium text-nova-text">This list didn’t load</p>
						<p className="mt-1 text-sm leading-relaxed text-nova-text-secondary">
							{state.kind === "unauthenticated"
								? "You're signed out. Reload the page to sign in again."
								: state.message}
						</p>
						<Button
							type="button"
							variant="outline"
							className="mt-3 min-h-11"
							onClick={() => void reload()}
						>
							<Icon icon={tablerRefresh} />
							Try again
						</Button>
					</div>
				) : entries.length === 0 ? (
					<div className="mt-10 flex max-w-md flex-col items-start gap-3">
						<span className="grid size-10 place-items-center rounded-xl bg-nova-violet/[0.09] text-nova-violet-bright">
							<Icon icon={tablerArchive} width="18" height="18" />
						</span>
						<p className="font-medium text-nova-text">Nothing to review</p>
						<p className="text-sm leading-relaxed text-nova-text-secondary">
							If a property change ever makes saved values stop fitting, they’re
							kept here. Nothing gets deleted.
						</p>
					</div>
				) : (
					<>
						<fieldset className="mt-5 flex flex-wrap items-center gap-2">
							<legend className="sr-only">Filter the list</legend>
							{(
								[
									["all", "All", counts.all],
									["ready", "Ready to put back", counts.ready],
									["dismissed", "Dismissed", counts.dismissed],
								] as const
							).map(([value, label, count]) => (
								<button
									key={value}
									type="button"
									aria-pressed={filter === value}
									onClick={() => setFilter(value)}
									className={`min-h-11 cursor-pointer rounded-full border px-4 text-[13px] font-medium transition-colors ${
										filter === value
											? "border-nova-border-bright bg-nova-violet/[0.12] text-nova-text"
											: "border-nova-border text-nova-text-secondary hover:border-nova-border-bright hover:text-nova-text"
									}`}
								>
									{label} · {count}
								</button>
							))}
							{fetching && (
								<Icon
									icon={tablerLoader2}
									width="14"
									height="14"
									className="animate-spin text-nova-text-muted"
									aria-label="Refreshing…"
								/>
							)}
						</fieldset>

						{filter !== "dismissed" &&
							notices.map((notice) => (
								<div
									key={`${notice.property}|${notice.fromType}|${notice.toType}`}
									className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-nova-violet/25 bg-nova-violet/[0.06] px-4 py-3"
								>
									<Icon
										icon={tablerArrowBackUp}
										width="17"
										height="17"
										className="shrink-0 text-nova-violet-bright"
									/>
									<p className="min-w-60 flex-1 text-[13px] leading-relaxed text-nova-text-secondary">
										{notice.count === 1
											? `${propertyLabel(notice.property)} is now ${dataTypePhrase(notice.toType)} and 1 saved value doesn’t fit. Replace it below, or convert ${propertyLabel(notice.property)} back to ${DATA_TYPE_LABELS[notice.fromType]} and it’ll go back automatically.`
											: `${propertyLabel(notice.property)} is now ${dataTypePhrase(notice.toType)} and ${notice.count} saved values don’t fit. Replace them below, or convert ${propertyLabel(notice.property)} back to ${DATA_TYPE_LABELS[notice.fromType]} and they’ll go back automatically.`}
									</p>
									{canEdit && (
										<SimpleTooltip content="Opens chat with the request written for you. Nova changes the property type, and values that fit go back automatically">
											<Button
												type="button"
												variant="outline"
												className="min-h-10 border-nova-violet/30 bg-nova-violet/[0.08] text-nova-violet-bright not-disabled:hover:bg-nova-violet/[0.16]"
												onClick={() => askNovaToConvertBack(notice)}
											>
												<Icon icon={tablerSparkles} />
												Convert back in chat
											</Button>
										</SimpleTooltip>
									)}
								</div>
							))}

						{groups.length === 0 ? (
							<p className="mt-8 text-sm text-nova-text-secondary">
								{filter === "ready"
									? "Nothing is ready to put back right now. A value becomes ready when it fits its property again."
									: "You haven’t dismissed anything"}
							</p>
						) : (
							groups.map((group) => (
								<ReviewCaseCard
									key={group.caseId}
									group={group}
									canEdit={canEdit}
									busyIds={busyIds}
									replaceDraft={replaceDraft}
									dismissedView={filter === "dismissed"}
									propertyDecl={propertyDecl}
									propertyLabel={propertyLabel}
									onPutBack={(entry) => putBackEntries([entry.id])}
									onDismiss={(entry) => dismissEntries([entry.id])}
									onUndismiss={(entry) => undismissEntries([entry.id])}
									onOpenReplace={(entry) =>
										setReplaceDraft({
											entryId: entry.id,
											text: "",
											selections: [],
											failures: null,
											saving: false,
										})
									}
									onDraftChange={(next) => setReplaceDraft(next)}
									onCancelReplace={() => setReplaceDraft(null)}
									onSaveReplace={saveReplacement}
								/>
							))
						)}
					</>
				)}
			</ContentFrame>
		</div>
	);
}

function ReviewCaseCard({
	group,
	canEdit,
	busyIds,
	replaceDraft,
	dismissedView,
	propertyDecl,
	propertyLabel,
	onPutBack,
	onDismiss,
	onUndismiss,
	onOpenReplace,
	onDraftChange,
	onCancelReplace,
	onSaveReplace,
}: {
	readonly group: ReviewCaseGroup;
	readonly canEdit: boolean;
	readonly busyIds: ReadonlySet<string>;
	readonly replaceDraft: ReplaceDraft | null;
	readonly dismissedView: boolean;
	readonly propertyDecl: (name: string) => CaseProperty | undefined;
	readonly propertyLabel: (name: string) => string;
	readonly onPutBack: (entry: ParkedValueEntryWire) => void;
	readonly onDismiss: (entry: ParkedValueEntryWire) => void;
	readonly onUndismiss: (entry: ParkedValueEntryWire) => void;
	readonly onOpenReplace: (entry: ParkedValueEntryWire) => void;
	readonly onDraftChange: (next: ReplaceDraft) => void;
	readonly onCancelReplace: () => void;
	readonly onSaveReplace: (entry: ParkedValueEntryWire) => void;
}) {
	return (
		<section className="mt-4 overflow-visible rounded-2xl border border-nova-border bg-nova-surface">
			<div className="flex flex-wrap items-baseline gap-x-2.5 px-4 pt-3 pb-1.5">
				<h2 className="text-[15px] font-semibold text-nova-text">
					{group.caseName || "Unnamed case"}
				</h2>
				<span className="text-xs text-nova-text-muted">
					{group.entries.length === 1
						? "1 value to review"
						: `${group.entries.length} values to review`}
				</span>
			</div>

			{group.entries.map((entry) => (
				<ReviewEntryRow
					key={entry.id}
					entry={entry}
					canEdit={canEdit}
					busy={busyIds.has(entry.id)}
					dismissedView={dismissedView}
					replaceDraft={
						replaceDraft?.entryId === entry.id ? replaceDraft : null
					}
					currentDecl={propertyDecl(entry.property)}
					label={propertyLabel(entry.property)}
					caseName={group.caseName}
					onPutBack={() => onPutBack(entry)}
					onDismiss={() => onDismiss(entry)}
					onUndismiss={() => onUndismiss(entry)}
					onOpenReplace={() => onOpenReplace(entry)}
					onDraftChange={onDraftChange}
					onCancelReplace={onCancelReplace}
					onSaveReplace={() => onSaveReplace(entry)}
				/>
			))}
		</section>
	);
}

function ReviewEntryRow({
	entry,
	canEdit,
	busy,
	dismissedView,
	replaceDraft,
	currentDecl,
	label,
	caseName,
	onPutBack,
	onDismiss,
	onUndismiss,
	onOpenReplace,
	onDraftChange,
	onCancelReplace,
	onSaveReplace,
}: {
	readonly entry: ParkedValueEntryWire;
	readonly canEdit: boolean;
	readonly busy: boolean;
	readonly dismissedView: boolean;
	readonly replaceDraft: ReplaceDraft | null;
	readonly currentDecl: CaseProperty | undefined;
	readonly label: string;
	readonly caseName: string;
	readonly onPutBack: () => void;
	readonly onDismiss: () => void;
	readonly onUndismiss: () => void;
	readonly onOpenReplace: () => void;
	readonly onDraftChange: (next: ReplaceDraft) => void;
	readonly onCancelReplace: () => void;
	readonly onSaveReplace: () => void;
}) {
	const display = displayReviewValue(entry.originalValue);
	const currentTypePhrase = dataTypePhrase(
		currentTypeOf(currentDecl, entry.toType),
	);
	// The row's short status — states the server verdict in plain
	// words; the stored `reason` remains the log-grade account.
	const status =
		entry.blockedBy === "type"
			? `Doesn’t fit ${currentTypePhrase}`
			: entry.blockedBy === "occupied"
				? "The case has a newer value"
				: "Ready to put back";
	const putBackTooltip = entry.restorable
		? "Saves this value on its case again"
		: entry.blockedBy === "type"
			? `Still fits ${dataTypePhrase(entry.fromType)}, but not ${currentTypePhrase}. Replace it, or convert the property back`
			: "Putting this back would overwrite the case's newer value. Use Replace to choose what's saved";

	// One emphasized primary per state: Put back when it's ready,
	// Replace when it isn't. Every action stays a visible labeled
	// button at every width — no overflow menus.
	const putBackButton = (
		<SimpleTooltip content={putBackTooltip}>
			<Button
				type="button"
				variant={entry.restorable ? "outline" : "ghost"}
				className={`min-h-10 text-[13px] ${
					entry.restorable ? "text-nova-violet-bright" : "text-nova-text-muted"
				}`}
				disabled={!entry.restorable || busy}
				onClick={onPutBack}
			>
				Put back
			</Button>
		</SimpleTooltip>
	);
	const replaceButton = (
		<SimpleTooltip content={`Enter a new ${label} for this case`}>
			<Button
				type="button"
				variant={entry.restorable ? "ghost" : "outline"}
				className={`min-h-10 text-[13px] ${
					entry.restorable
						? "text-nova-text-secondary"
						: "text-nova-violet-bright"
				}`}
				disabled={busy}
				onClick={onOpenReplace}
			>
				Replace
			</Button>
		</SimpleTooltip>
	);
	const dismissButton = dismissedView ? (
		<SimpleTooltip content="Moves this value back to the All list">
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label="Move back to All"
				className="size-10 text-nova-text-muted"
				disabled={busy}
				onClick={onUndismiss}
			>
				<Icon icon={tablerArrowBackUp} width="15" height="15" />
			</Button>
		</SimpleTooltip>
	) : (
		<SimpleTooltip content="Moves this to the Dismissed list. Nothing is deleted">
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label="Dismiss"
				className="size-10 text-nova-text-muted"
				disabled={busy}
				onClick={onDismiss}
			>
				<Icon icon={tablerX} width="15" height="15" />
			</Button>
		</SimpleTooltip>
	);

	return (
		<div className="border-t border-nova-violet/[0.08]">
			{/* Wide layout — one aligned line per value. */}
			<div className="hidden min-h-13 items-center gap-4 px-4 py-1 @3xl:flex">
				<span className="w-36 shrink-0 truncate text-[13px] font-medium text-nova-text-secondary">
					{label}
				</span>
				<span className="min-w-0 flex-1 truncate text-[13.5px] text-nova-text">
					<span className="text-nova-text-muted">“</span>
					{display}
					<span className="text-nova-text-muted">”</span>
				</span>
				<span className="w-48 shrink-0 text-xs leading-snug text-nova-text-muted">
					{status}
				</span>
				{canEdit && (
					<span className="flex shrink-0 items-center justify-end gap-1">
						{putBackButton}
						{replaceButton}
						{dismissButton}
					</span>
				)}
			</div>

			{/* Narrower canvases — one full-width band: text left, the same
			 * buttons anchored right. A ~700px card is not a phone; the
			 * cluster only wraps under the text when the container is
			 * genuinely phone-narrow. */}
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2 @3xl:hidden">
				<div className="min-w-52 flex-1">
					<p className="text-[13.5px] break-words text-nova-text">
						<span className="font-medium text-nova-text-secondary">
							{label}
						</span>{" "}
						<span className="text-nova-text-muted">“</span>
						{display}
						<span className="text-nova-text-muted">”</span>
					</p>
					<p className="mt-0.5 text-xs text-nova-text-muted">{status}</p>
				</div>
				{canEdit && (
					<div className="flex shrink-0 items-center gap-1">
						{putBackButton}
						{replaceButton}
						{dismissButton}
					</div>
				)}
			</div>

			{replaceDraft !== null && (
				<ReplaceEditor
					draft={replaceDraft}
					currentDecl={currentDecl}
					label={label}
					caseName={caseName}
					displayOriginal={display}
					onDraftChange={onDraftChange}
					onCancel={onCancelReplace}
					onSave={onSaveReplace}
				/>
			)}
		</div>
	);
}

function ReplaceEditor({
	draft,
	currentDecl,
	label,
	caseName,
	displayOriginal,
	onDraftChange,
	onCancel,
	onSave,
}: {
	readonly draft: ReplaceDraft;
	readonly currentDecl: CaseProperty | undefined;
	readonly label: string;
	readonly caseName: string;
	readonly displayOriginal: string;
	readonly onDraftChange: (next: ReplaceDraft) => void;
	readonly onCancel: () => void;
	readonly onSave: () => void;
}) {
	const dataType = currentDecl?.data_type ?? "text";
	const submittable = replacementDraftToValue(
		dataType,
		dataType === "multi_select" ? draft.selections : draft.text,
	).ok;

	return (
		<div className="mx-4 mb-3.5 rounded-lg border border-nova-violet/30 bg-nova-violet/[0.04] px-4 py-3.5">
			<p className="text-[13px] font-medium text-nova-text">
				New {label} for {caseName || "this case"}
			</p>
			<div className="mt-2.5 flex flex-wrap items-center gap-3">
				<ReplacementInput
					dataType={dataType}
					options={currentDecl?.options ?? []}
					draft={draft}
					onDraftChange={onDraftChange}
				/>
				<Button
					type="button"
					className="min-h-11"
					disabled={!submittable || draft.saving}
					onClick={onSave}
				>
					{draft.saving && (
						<Icon icon={tablerLoader2} className="animate-spin" />
					)}
					{draft.saving ? "Saving" : "Save to case"}
				</Button>
				<Button
					type="button"
					variant="ghost"
					className="min-h-11"
					disabled={draft.saving}
					onClick={onCancel}
				>
					Cancel
				</Button>
			</div>
			{draft.failures !== null && draft.failures.length > 0 && (
				<ul role="alert" className="mt-2 space-y-1">
					{draft.failures.map((failure) => (
						<li
							key={`${failure.path} ${failure.message}`}
							className="text-xs leading-relaxed text-nova-rose"
						>
							{failure.message}
						</li>
					))}
				</ul>
			)}
			<p className="mt-2 text-xs text-nova-text-muted">
				Saves to this case’s {label}. The original “{displayOriginal}” stays
				available under Dismissed.
			</p>
		</div>
	);
}

function ReplacementInput({
	dataType,
	options,
	draft,
	onDraftChange,
}: {
	readonly dataType: CasePropertyDataType;
	readonly options: ReadonlyArray<{ value: string; label: string }>;
	readonly draft: ReplaceDraft;
	readonly onDraftChange: (next: ReplaceDraft) => void;
}) {
	const checkboxIdBase = useId();
	const setText = (text: string) =>
		onDraftChange({ ...draft, text, failures: null });

	switch (dataType) {
		case "int":
		case "decimal":
			return (
				<Input
					autoComplete="off"
					data-1p-ignore
					type="number"
					step={dataType === "int" ? 1 : "any"}
					value={draft.text}
					onChange={(event) => setText(event.target.value)}
					aria-label="Replacement value"
					className="min-h-11 w-40"
				/>
			);
		case "date":
			return (
				<Input
					autoComplete="off"
					data-1p-ignore
					type="date"
					value={draft.text}
					onChange={(event) => setText(event.target.value)}
					aria-label="Replacement date"
					className="min-h-11 w-52"
				/>
			);
		case "time":
			return (
				<Input
					autoComplete="off"
					data-1p-ignore
					type="time"
					value={draft.text}
					onChange={(event) => setText(event.target.value)}
					aria-label="Replacement time"
					className="min-h-11 w-40"
				/>
			);
		case "datetime":
			return (
				<Input
					autoComplete="off"
					data-1p-ignore
					type="datetime-local"
					value={draft.text}
					onChange={(event) => setText(event.target.value)}
					aria-label="Replacement date and time"
					className="min-h-11 w-60"
				/>
			);
		case "single_select":
			return (
				<Select
					value={draft.text === "" ? undefined : draft.text}
					onValueChange={(value) =>
						onDraftChange({
							...draft,
							text: typeof value === "string" ? value : "",
							failures: null,
						})
					}
				>
					<SelectTrigger
						aria-label="Replacement selection"
						className="min-h-11 w-56"
					>
						<SelectValue placeholder="Choose an option" />
					</SelectTrigger>
					<SelectContent>
						{options.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			);
		case "multi_select":
			return (
				<fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
					<legend className="sr-only">Replacement selections</legend>
					{options.map((option) => {
						const checked = draft.selections.includes(option.value);
						const id = `${checkboxIdBase}-${option.value}`;
						return (
							<label
								key={option.value}
								htmlFor={id}
								className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-nova-text"
							>
								<Checkbox
									id={id}
									checked={checked}
									onCheckedChange={(next) =>
										onDraftChange({
											...draft,
											selections: next
												? [...draft.selections, option.value]
												: draft.selections.filter(
														(value) => value !== option.value,
													),
											failures: null,
										})
									}
								/>
								{option.label}
							</label>
						);
					})}
				</fieldset>
			);
		case "geopoint":
			return (
				<Input
					autoComplete="off"
					data-1p-ignore
					value={draft.text}
					onChange={(event) => setText(event.target.value)}
					aria-label="Replacement GPS point"
					placeholder="latitude longitude"
					className="min-h-11 w-64"
				/>
			);
		default:
			return (
				<Input
					autoComplete="off"
					data-1p-ignore
					value={draft.text}
					onChange={(event) => setText(event.target.value)}
					aria-label="Replacement value"
					className="min-h-11 w-72"
				/>
			);
	}
}
