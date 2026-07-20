/**
 * SetAsideValuesScreen — the review surface for values a schema
 * conversion couldn't carry (`/build/{appId}/{moduleUuid}/set-aside`).
 *
 * Everything shown is the Server Action's server-computed truth: the
 * grouping/filter/callout DERIVATIONS live in the pure
 * `setAsideModel.ts`, the restore VERDICTS come per-entry from
 * `listParkedValues` (computed against the property's current
 * declaration, re-proven at write time), and this component only
 * renders and dispatches. Copy rules from the design pass: "set
 * aside" is the only vocabulary, "nothing was deleted" appears once,
 * restorability is stated as computed fact, and every dismiss gets an
 * undo toast — dismissing never deletes.
 */
"use client";

import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerNumber123 from "@iconify-icons/tabler/123";
import tablerArchive from "@iconify-icons/tabler/archive";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import tablerCalendar from "@iconify-icons/tabler/calendar";
import tablerCircleCheck from "@iconify-icons/tabler/circle-check";
import tablerCircleDot from "@iconify-icons/tabler/circle-dot";
import tablerClock from "@iconify-icons/tabler/clock";
import tablerCursorText from "@iconify-icons/tabler/cursor-text";
import tablerDots from "@iconify-icons/tabler/dots";
import tablerDotsVertical from "@iconify-icons/tabler/dots-vertical";
import tablerListCheck from "@iconify-icons/tabler/list-check";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerMapPin from "@iconify-icons/tabler/map-pin";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import tablerRestore from "@iconify-icons/tabler/restore";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import tablerX from "@iconify-icons/tabler/x";
import { useId, useState } from "react";
import { usePromptInputController } from "@/components/ai-elements/prompt-input";
import { ContentFrame } from "@/components/builder/ContentFrame";
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
import { Checkbox } from "@/components/shadcn/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
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
	DATA_TYPE_LABELS,
	displaySetAsideValue,
	filterSetAsideEntries,
	formatSetAsideTimestamp,
	groupSetAsideEntries,
	replacementDraftToValue,
	type SetAsideFilter,
	type SetAsideGroup,
	setAsideCounts,
} from "./setAsideModel";

const DATA_TYPE_ICONS: Record<CasePropertyDataType, IconifyIcon> = {
	text: tablerCursorText,
	int: tablerNumber123,
	decimal: tablerNumber123,
	date: tablerCalendar,
	time: tablerClock,
	datetime: tablerCalendar,
	single_select: tablerCircleDot,
	multi_select: tablerListCheck,
	geopoint: tablerMapPin,
};

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

/** The Fix editor's in-progress draft for one entry. */
interface FixDraft {
	readonly entryId: string;
	readonly text: string;
	readonly selections: readonly string[];
	readonly failures: readonly CasePropertyFailure[] | null;
	readonly saving: boolean;
}

export function SetAsideValuesScreen({ moduleUuid }: { moduleUuid: Uuid }) {
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

	const [filter, setFilter] = useState<SetAsideFilter>("all");
	const [fixDraft, setFixDraft] = useState<FixDraft | null>(null);
	const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
	const [confirmDismissAll, setConfirmDismissAll] =
		useState<SetAsideGroup | null>(null);
	const [dismissingAll, setDismissingAll] = useState(false);

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

	const restoreEntries = (ids: readonly string[]) =>
		withBusy(ids, async () => {
			const result = await restore([...ids]);
			if (result.kind !== "restored") {
				showToast(
					"error",
					"Couldn't restore",
					result.kind === "error"
						? result.message
						: "You're signed out. Reload the page to sign in again.",
				);
				return;
			}
			if (result.kept > 0) {
				// The verdict moved between render and write (a teammate's
				// edit, a fresh conversion) — the re-listed rows show why.
				// The hook's invalidation already refreshes the list.
				showToast(
					"warning",
					result.kept === 1
						? "1 value stayed set aside"
						: `${result.kept} values stayed set aside`,
					"They no longer fit the property's current type, or the case now holds a newer value.",
				);
			}
		});

	const undismissEntries = (ids: readonly string[]) =>
		withBusy(ids, async () => {
			const result = await setDismissed([...ids], false);
			if (result.kind !== "toggled") {
				showToast(
					"error",
					"Couldn't bring the value back",
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
				"Nothing was deleted — dismissed values stay under the Dismissed filter.",
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

	const saveFix = (entry: ParkedValueEntryWire) => {
		if (fixDraft === null || fixDraft.entryId !== entry.id) return;
		const currentType = propertyDecl(entry.property)?.data_type ?? "text";
		const draft = replacementDraftToValue(
			currentType,
			currentType === "multi_select" ? fixDraft.selections : fixDraft.text,
		);
		if (!draft.ok) return;
		setFixDraft({ ...fixDraft, saving: true, failures: null });
		void (async () => {
			const result = await replace(entry.id, draft.value);
			if (result.kind === "replaced") {
				setFixDraft(null);
				return;
			}
			if (result.kind === "invalid-value") {
				setFixDraft((prev) =>
					prev?.entryId === entry.id
						? { ...prev, saving: false, failures: result.failures }
						: prev,
				);
				return;
			}
			setFixDraft(null);
			if (result.kind === "not-found") {
				showToast(
					"info",
					"This value moved on",
					"It was restored, replaced, or its case was removed — the list is refreshed.",
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

	const askNovaToConvertBack = (group: SetAsideGroup) => {
		composer.textInput.setInput(
			`Convert ${propertyLabel(group.property)} back to ${DATA_TYPE_LABELS[group.fromType]}`,
		);
		setSidebarOpen("chat", true);
		requestAnimationFrame(() => {
			document
				.querySelector<HTMLTextAreaElement>('textarea[name="message"]')
				?.focus();
		});
	};

	const entries = state.kind === "entries" ? state.entries : [];
	const counts = setAsideCounts(entries);
	const groups = groupSetAsideEntries(filterSetAsideEntries(entries, filter));

	return (
		<div className="@container">
			<ContentFrame width="5xl" className="px-6 pt-7 pb-16">
				<h1 className="font-display text-2xl font-semibold tracking-tight text-nova-text">
					Set-aside values
				</h1>
				<p className="mt-2 max-w-2xl text-sm leading-relaxed text-pretty text-nova-text-secondary">
					When a property changes type, saved values that don’t fit are set
					aside instead of deleted. Restore a value, enter a replacement, or
					dismiss it.
				</p>
				{!canEdit && entries.length > 0 && (
					<p className="mt-3 max-w-2xl rounded-lg bg-nova-elevated px-3 py-2.5 text-sm leading-relaxed text-nova-text-secondary">
						You can view set-aside values, but restoring or changing them needs
						edit access
					</p>
				)}

				{state.kind === "loading" || state.kind === "idle" ? (
					<p className="mt-8 flex items-center gap-2 text-sm text-nova-text-secondary">
						<Icon icon={tablerLoader2} className="animate-spin" width="16" />
						Loading set-aside values…
					</p>
				) : state.kind !== "entries" ? (
					<div
						role="alert"
						className="mt-8 max-w-md rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] p-4"
					>
						<p className="font-medium text-nova-text">
							Set-aside values didn’t load
						</p>
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
						<p className="font-medium text-nova-text">Nothing is set aside</p>
						<p className="text-sm leading-relaxed text-nova-text-secondary">
							When a case property’s type changes, any saved values that don’t
							fit the new type are kept here instead of being deleted.
						</p>
					</div>
				) : (
					<>
						<fieldset className="mt-5 flex flex-wrap items-center gap-2">
							<legend className="sr-only">Filter set-aside values</legend>
							{(
								[
									["all", "All", counts.all],
									["restorable", "Restorable", counts.restorable],
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
									{label} {count}
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

						{groups.length === 0 ? (
							<p className="mt-8 text-sm text-nova-text-secondary">
								{filter === "restorable"
									? "Nothing can be restored right now — values become restorable when their property accepts them again."
									: "No dismissed values."}
							</p>
						) : (
							groups.map((group) => (
								<SetAsideGroupCard
									key={group.key}
									group={group}
									filter={filter}
									canEdit={canEdit}
									busyIds={busyIds}
									fixDraft={fixDraft}
									currentDecl={propertyDecl(group.property)}
									label={propertyLabel(group.property)}
									onRestore={restoreEntries}
									onDismiss={dismissEntries}
									onUndismiss={undismissEntries}
									onDismissAll={() => setConfirmDismissAll(group)}
									onOpenFix={(entry) =>
										setFixDraft({
											entryId: entry.id,
											text: "",
											selections: [],
											failures: null,
											saving: false,
										})
									}
									onDraftChange={(next) => setFixDraft(next)}
									onCancelFix={() => setFixDraft(null)}
									onSaveFix={saveFix}
									onAskNova={() => askNovaToConvertBack(group)}
								/>
							))
						)}

						{filter !== "dismissed" && counts.dismissed > 0 && (
							<p className="mt-5 text-[13px] text-nova-text-muted">
								{counts.dismissed === 1
									? "1 dismissed value stays"
									: `${counts.dismissed} dismissed values stay`}{" "}
								available under{" "}
								<button
									type="button"
									className="cursor-pointer font-medium text-nova-violet-bright hover:text-nova-text"
									onClick={() => setFilter("dismissed")}
								>
									Dismissed
								</button>
							</p>
						)}
					</>
				)}
			</ContentFrame>

			<AlertDialog
				open={confirmDismissAll !== null}
				onOpenChange={(nextOpen, eventDetails) => {
					if (!nextOpen && dismissingAll) {
						eventDetails.cancel();
						return;
					}
					if (!nextOpen) setConfirmDismissAll(null);
				}}
			>
				<AlertDialogContent className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display">
							Dismiss all{" "}
							{confirmDismissAll !== null
								? confirmDismissAll.entries.length
								: ""}{" "}
							values for “
							{confirmDismissAll !== null
								? propertyLabel(confirmDismissAll.property)
								: ""}
							”?
						</AlertDialogTitle>
						<AlertDialogDescription className="text-left text-pretty">
							They leave this list but nothing is deleted — every value stays
							available (and restorable) under the Dismissed filter.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={dismissingAll}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={dismissingAll}
							onClick={() => {
								const group = confirmDismissAll;
								if (group === null) return;
								setDismissingAll(true);
								void (async () => {
									try {
										await dismissEntries(
											group.entries.map((entry) => entry.id),
										);
									} finally {
										setDismissingAll(false);
										setConfirmDismissAll(null);
									}
								})();
							}}
						>
							{dismissingAll && (
								<Icon icon={tablerLoader2} className="animate-spin" />
							)}
							{dismissingAll ? "Dismissing" : "Dismiss all"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

function SetAsideGroupCard({
	group,
	filter,
	canEdit,
	busyIds,
	fixDraft,
	currentDecl,
	label,
	onRestore,
	onDismiss,
	onUndismiss,
	onDismissAll,
	onOpenFix,
	onDraftChange,
	onCancelFix,
	onSaveFix,
	onAskNova,
}: {
	readonly group: SetAsideGroup;
	readonly filter: SetAsideFilter;
	readonly canEdit: boolean;
	readonly busyIds: ReadonlySet<string>;
	readonly fixDraft: FixDraft | null;
	readonly currentDecl: CaseProperty | undefined;
	readonly label: string;
	readonly onRestore: (ids: readonly string[]) => void;
	readonly onDismiss: (ids: readonly string[]) => void;
	readonly onUndismiss: (ids: readonly string[]) => void;
	readonly onDismissAll: () => void;
	readonly onOpenFix: (entry: ParkedValueEntryWire) => void;
	readonly onDraftChange: (next: FixDraft) => void;
	readonly onCancelFix: () => void;
	readonly onSaveFix: (entry: ParkedValueEntryWire) => void;
	readonly onAskNova: () => void;
}) {
	const currentTypeLabel =
		DATA_TYPE_LABELS[currentTypeOf(currentDecl, group.toType)];
	const count = group.entries.length;
	const showConvertBackHint =
		canEdit &&
		group.isTypeChange &&
		group.restorableIds.length === 0 &&
		group.fitsOriginalCount > 0 &&
		filter !== "dismissed";
	const showAllRestorable =
		group.allRestorable && count > 0 && filter !== "dismissed";

	return (
		<section className="mt-5 overflow-visible rounded-2xl border border-nova-border bg-nova-surface">
			<div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
				<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-nova-violet/10 text-nova-violet-bright">
					<Icon icon={DATA_TYPE_ICONS[group.toType]} width="16" height="16" />
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2.5">
						<span className="text-[15px] font-semibold text-nova-text">
							{label}
						</span>
						{group.isTypeChange ? (
							<span className="inline-flex items-center gap-1.5 rounded-full border border-nova-border px-2.5 py-0.5 font-mono text-[11px] text-nova-text-secondary">
								{DATA_TYPE_LABELS[group.fromType]}
								<Icon icon={tablerArrowRight} width="11" height="11" />
								{DATA_TYPE_LABELS[group.toType]}
							</span>
						) : (
							<span className="inline-flex items-center rounded-full border border-nova-border px-2.5 py-0.5 font-mono text-[11px] text-nova-text-secondary">
								options removed
							</span>
						)}
					</div>
					<p className="mt-0.5 text-xs text-nova-text-muted">
						{count === 1 ? "1 value" : `${count} values`} · set aside{" "}
						{formatSetAsideTimestamp(group.latestCreatedAt, new Date())}
					</p>
				</div>
				{canEdit && group.restorableIds.length > 1 && (
					<Button
						type="button"
						variant="outline"
						className="min-h-10"
						disabled={group.restorableIds.some((id) => busyIds.has(id))}
						onClick={() => onRestore(group.restorableIds)}
					>
						<Icon icon={tablerRestore} />
						Restore all {group.restorableIds.length}
					</Button>
				)}
				{canEdit && filter !== "dismissed" && (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									type="button"
									variant="ghost"
									size="icon"
									aria-label={`More actions for ${label}`}
									className="size-11"
								/>
							}
						>
							<Icon icon={tablerDotsVertical} width="18" height="18" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={onDismissAll}>
								Dismiss all {count}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>

			{showConvertBackHint && (
				<div className="mx-4 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-nova-violet/25 bg-nova-violet/[0.06] px-3.5 py-3">
					<Icon
						icon={tablerArrowBackUp}
						width="17"
						height="17"
						className="shrink-0 text-nova-violet-bright"
					/>
					<p className="min-w-60 flex-1 text-[13px] leading-relaxed text-nova-text-secondary">
						None of these fit a {DATA_TYPE_LABELS[group.toType]}, but{" "}
						{group.fitsOriginalCount === count
							? `all ${count}`
							: `${group.fitsOriginalCount} of the ${count}`}{" "}
						still fit {DATA_TYPE_LABELS[group.fromType]}. If {label} becomes a{" "}
						{DATA_TYPE_LABELS[group.fromType]} property again, those values can
						be restored.
					</p>
					<Button
						type="button"
						variant="outline"
						className="min-h-10 border-nova-violet/30 bg-nova-violet/[0.08] text-nova-violet-bright not-disabled:hover:bg-nova-violet/[0.16]"
						onClick={onAskNova}
					>
						<Icon icon={tablerSparkles} />
						Ask Nova to convert it back
					</Button>
				</div>
			)}

			{showAllRestorable && (
				<div className="mx-4 mb-3 flex items-center gap-2.5 rounded-lg border border-nova-emerald/30 bg-nova-emerald/[0.05] px-3.5 py-2.5">
					<Icon
						icon={tablerCircleCheck}
						width="16"
						height="16"
						className="shrink-0 text-nova-emerald"
					/>
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						{label} is a {currentTypeLabel} again — all {count} original{" "}
						{count === 1 ? "value fits" : "values fit"} the current type and can
						be restored.
					</p>
				</div>
			)}

			{/* Column captions — wide layout only. */}
			<div className="hidden items-center gap-4 px-4 py-1.5 text-[11px] font-semibold tracking-wider text-nova-text-muted uppercase @3xl:flex">
				<span className="w-40 shrink-0">Case</span>
				<span className="min-w-0 flex-1">Original value</span>
				<span className="w-48 shrink-0">Why it didn’t fit</span>
				{canEdit && <span className="w-52 shrink-0" />}
			</div>

			{group.entries.map((entry) => (
				<SetAsideEntryRow
					key={entry.id}
					entry={entry}
					canEdit={canEdit}
					busy={busyIds.has(entry.id)}
					dismissedView={filter === "dismissed"}
					fixDraft={fixDraft?.entryId === entry.id ? fixDraft : null}
					currentDecl={currentDecl}
					label={label}
					fromType={group.fromType}
					onRestore={() => onRestore([entry.id])}
					onDismiss={() => onDismiss([entry.id])}
					onUndismiss={() => onUndismiss([entry.id])}
					onOpenFix={() => onOpenFix(entry)}
					onDraftChange={onDraftChange}
					onCancelFix={onCancelFix}
					onSaveFix={() => onSaveFix(entry)}
				/>
			))}
		</section>
	);
}

function SetAsideEntryRow({
	entry,
	canEdit,
	busy,
	dismissedView,
	fixDraft,
	currentDecl,
	label,
	fromType,
	onRestore,
	onDismiss,
	onUndismiss,
	onOpenFix,
	onDraftChange,
	onCancelFix,
	onSaveFix,
}: {
	readonly entry: ParkedValueEntryWire;
	readonly canEdit: boolean;
	readonly busy: boolean;
	readonly dismissedView: boolean;
	readonly fixDraft: FixDraft | null;
	readonly currentDecl: CaseProperty | undefined;
	readonly label: string;
	readonly fromType: CasePropertyDataType;
	readonly onRestore: () => void;
	readonly onDismiss: () => void;
	readonly onUndismiss: () => void;
	readonly onOpenFix: () => void;
	readonly onDraftChange: (next: FixDraft) => void;
	readonly onCancelFix: () => void;
	readonly onSaveFix: () => void;
}) {
	const display = displaySetAsideValue(entry.originalValue);
	const currentTypeLabel =
		DATA_TYPE_LABELS[currentTypeOf(currentDecl, entry.toType)];
	// The row's short "why" — the stored `reason` is the log-grade
	// account; the row states the same fact in the malformed-value
	// voice, derived from the server verdict.
	const whyText =
		entry.blockedBy === "type"
			? `Doesn’t fit a ${currentTypeLabel}`
			: entry.blockedBy === "occupied"
				? "The case has a newer value"
				: "Fits the current type";
	const blockedReason =
		entry.blockedBy === "type"
			? `Fits ${DATA_TYPE_LABELS[fromType]}, not ${currentTypeLabel} — convert the type back to restore it`
			: entry.blockedBy === "occupied"
				? "The case already holds a value here — restoring would overwrite it. Use Fix to change it deliberately."
				: null;

	const restoreButton = (
		<SimpleTooltip content={entry.restorable ? null : blockedReason}>
			<Button
				type="button"
				variant="ghost"
				className="min-h-11 text-[13px] text-nova-violet-bright"
				disabled={!entry.restorable || busy}
				onClick={onRestore}
			>
				Restore
			</Button>
		</SimpleTooltip>
	);
	const fixButton = (
		<Button
			type="button"
			variant="ghost"
			className="min-h-11 text-[13px] text-nova-violet-bright"
			disabled={busy}
			onClick={onOpenFix}
		>
			Fix
		</Button>
	);
	const dismissButton = dismissedView ? (
		<SimpleTooltip content="Move back to the active list">
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label="Un-dismiss"
				className="size-11 text-nova-text-muted"
				disabled={busy}
				onClick={onUndismiss}
			>
				<Icon icon={tablerArrowBackUp} width="15" height="15" />
			</Button>
		</SimpleTooltip>
	) : (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			aria-label="Dismiss"
			className="size-11 text-nova-text-muted"
			disabled={busy}
			onClick={onDismiss}
		>
			<Icon icon={tablerX} width="15" height="15" />
		</Button>
	);

	return (
		<div className="border-t border-nova-violet/[0.08]">
			{/* Wide layout — aligned columns. */}
			<div className="hidden min-h-13 items-center gap-4 px-4 py-0.5 @3xl:flex">
				<span className="w-40 shrink-0 truncate text-[13.5px] font-medium text-nova-text">
					{entry.caseName || "Unnamed case"}
				</span>
				<span className="min-w-0 flex-1 truncate font-mono text-[13px] text-nova-text">
					<span className="text-nova-text-muted">“</span>
					{display}
					<span className="text-nova-text-muted">”</span>
				</span>
				<span className="w-48 shrink-0 text-xs leading-snug text-nova-text-muted">
					{whyText}
				</span>
				{canEdit && (
					<span className="flex w-52 shrink-0 items-center justify-end gap-0.5">
						{restoreButton}
						{fixButton}
						{dismissButton}
					</span>
				)}
			</div>

			{/* Narrow layout — stacked card with a collapsed action menu. */}
			<div className="px-4 py-3 @3xl:hidden">
				<div className="flex items-center gap-2">
					<span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-nova-text">
						{entry.caseName || "Unnamed case"}
					</span>
					{canEdit && (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										type="button"
										variant="ghost"
										size="icon"
										aria-label={`Actions for ${entry.caseName || "this value"}`}
										className="size-11"
									/>
								}
							>
								<Icon icon={tablerDots} width="16" height="16" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									disabled={!entry.restorable || busy}
									onClick={onRestore}
								>
									Restore
								</DropdownMenuItem>
								<DropdownMenuItem disabled={busy} onClick={onOpenFix}>
									Fix
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={busy}
									onClick={dismissedView ? onUndismiss : onDismiss}
								>
									{dismissedView ? "Un-dismiss" : "Dismiss"}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
				<p className="mt-0.5 font-mono text-[13px] break-words text-nova-text">
					<span className="text-nova-text-muted">“</span>
					{display}
					<span className="text-nova-text-muted">”</span>
				</p>
				<p className="mt-1 text-xs text-nova-text-muted">{whyText}</p>
			</div>

			{fixDraft !== null && (
				<FixEditor
					entry={entry}
					draft={fixDraft}
					currentDecl={currentDecl}
					label={label}
					displayOriginal={display}
					onDraftChange={onDraftChange}
					onCancel={onCancelFix}
					onSave={onSaveFix}
				/>
			)}
		</div>
	);
}

function FixEditor({
	entry,
	draft,
	currentDecl,
	label,
	displayOriginal,
	onDraftChange,
	onCancel,
	onSave,
}: {
	readonly entry: ParkedValueEntryWire;
	readonly draft: FixDraft;
	readonly currentDecl: CaseProperty | undefined;
	readonly label: string;
	readonly displayOriginal: string;
	readonly onDraftChange: (next: FixDraft) => void;
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
				Replacement {label.toLowerCase()} — {entry.caseName || "this case"}
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
				Saves to this case’s {label}. The original value “{displayOriginal}”
				stays on this entry, under Dismissed.
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
	readonly draft: FixDraft;
	readonly onDraftChange: (next: FixDraft) => void;
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
					className="min-h-11 w-64 font-mono"
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
