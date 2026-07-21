/**
 * DataReviewScreen — the review surface for saved case values a schema
 * conversion couldn't carry (`/build/{appId}/{moduleUuid}/data-review`).
 *
 * Everything shown is the Server Action's server-computed truth: the
 * case grouping / filter DERIVATIONS live in the pure
 * `dataReviewModel.ts`, the per-entry `restorable` verdict comes from
 * `listParkedValues` (computed against the property's current
 * declaration, re-proven at write time), and this component only
 * renders and dispatches.
 *
 * Design rules (the review-round bar): the CASE is the anchor — one
 * card per case, its waiting values as rows, and the whole case one
 * View case dialog away so a decision is made against the record, not
 * a floating value. The page header explains the interface once (what
 * the list is, what the actions do, what returns on its own); each
 * row then SHOWS its state instead of narrating it — the property
 * renders as a reference-style chip whose icon is the property's
 * CURRENT type, beside the literal waiting value. Each row offers
 * every action that works for it as visible labeled buttons — never a
 * disabled button beside a live one. Plain words only, and
 * reassurance lives in the verbs ("kept", "put back"), not appended
 * disclaimers.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerArchive from "@iconify-icons/tabler/archive";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerEye from "@iconify-icons/tabler/eye";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import { type ReactElement, useId, useState } from "react";
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
import { useAppId, useCanEdit } from "@/lib/session/hooks";
import { showToast } from "@/lib/ui/toastStore";
import { CaseDetailDialog } from "./CaseDetailDialog";
import {
	DATA_TYPE_LABELS,
	displayReviewValue,
	filterReviewEntries,
	groupReviewByCase,
	type ReviewCaseGroup,
	type ReviewFilter,
	replacementDraftToValue,
	reviewCounts,
} from "./dataReviewModel";
import { DATA_TYPE_ICONS, NameChip } from "./NameChip";

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

	const [filter, setFilter] = useState<ReviewFilter>("ready");
	const [replaceDraft, setReplaceDraft] = useState<ReplaceDraft | null>(null);
	const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
	const [viewCase, setViewCase] = useState<{
		readonly caseId: string;
		readonly caseName: string;
	} | null>(null);

	const restore = useRestoreParkedValues({ appId, caseType: caseType?.name });
	const setDismissed = useSetParkedValuesDismissed({
		appId,
		caseType: caseType?.name,
	});
	const replace = useReplaceParkedValue({ appId, caseType: caseType?.name });

	if (caseType === undefined) return null;

	const propertyDecl = (name: string): CaseProperty | undefined =>
		caseType.properties.find((property) => property.name === name);
	// The row's chip: the reference-chip variant carrying the
	// property's CURRENT type as its icon — the state shown, not
	// narrated. A property the schema no longer declares (a rename's
	// retired source) keeps the case family's database mark: naming a
	// type for it would be fiction.
	const propertyChip = (name: string): ReactElement => {
		const decl = propertyDecl(name);
		if (decl === undefined) return <NameChip label={name} />;
		const dataType = decl.data_type ?? "text";
		return (
			<NameChip
				label={name}
				icon={DATA_TYPE_ICONS[dataType]}
				iconLabel={`${DATA_TYPE_LABELS[dataType]} property`}
			/>
		);
	};

	const withBusy = async (id: string, run: () => Promise<void>) => {
		setBusyIds((prev) => new Set([...prev, id]));
		try {
			await run();
		} catch {
			// A Server Action call is a fetch — it REJECTS on a dropped
			// connection or a mid-deploy stale action id. Without this
			// catch the press would fail silently (busy resets below, no
			// toast, nothing changed on screen).
			showToast(
				"error",
				"That didn’t go through",
				"The server couldn’t be reached. Check your connection and try again.",
			);
		} finally {
			setBusyIds((prev) => {
				const next = new Set(prev);
				next.delete(id);
				return next;
			});
		}
	};

	const putBackEntry = (id: string) =>
		withBusy(id, async () => {
			const result = await restore([id]);
			if (result.kind !== "restored") {
				showToast(
					"error",
					"Couldn't put the value back",
					result.kind === "error"
						? result.message
						: "You're signed out. Reload the page to sign in again.",
				);
				return;
			}
			// A put-back removes the row, so the toast says where the value
			// went. The kept arm is a race — the verdict moved between
			// render and write (a teammate's edit, a fresh conversion) —
			// and the refreshed list shows the row's new state.
			if (result.restored === 1) {
				showToast("info", "Value put back", "It's saved on its case again.");
			} else {
				showToast(
					"warning",
					"It can't go back right now",
					"The property or the case changed since this list loaded.",
				);
			}
		});

	const undismissEntry = (id: string) =>
		withBusy(id, async () => {
			const result = await setDismissed([id], false);
			if (result.kind !== "toggled") {
				showToast(
					"error",
					"Couldn't move it back",
					result.kind === "error"
						? result.message
						: "You're signed out. Reload the page to sign in again.",
				);
				return;
			}
			if (result.count === 0) {
				showToast(
					"info",
					"This value moved on",
					"It was put back, replaced, or its case was removed. The list is refreshed.",
				);
			}
		});

	const dismissEntry = (id: string) =>
		withBusy(id, async () => {
			const result = await setDismissed([id], true);
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
			// count 0: the entry left the list between render and press (a
			// teammate put it back, or its case was replaced) — claiming
			// it's "under Dismissed" with a dead Undo would be a lie.
			if (result.count === 0) {
				showToast(
					"info",
					"This value moved on",
					"It was put back, replaced, or its case was removed. The list is refreshed.",
				);
				return;
			}
			showToast("info", "Value dismissed", "Find it under Dismissed.", {
				action: {
					label: "Undo",
					onPress: () => {
						void undismissEntry(id);
					},
				},
			});
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
			let result: Awaited<ReturnType<typeof replace>>;
			try {
				result = await replace(entry.id, draft.value);
			} catch {
				// A rejected Server Action fetch (dropped connection, stale
				// action id mid-deploy) must not strand the editor in its
				// saving state — Cancel is disabled while saving, so an
				// uncaught rejection would lock the row until a reload.
				// The typed value stays in the draft for a retry.
				setReplaceDraft((prev) =>
					prev?.entryId === entry.id ? { ...prev, saving: false } : prev,
				);
				showToast(
					"error",
					"Couldn't save the replacement",
					"The server couldn’t be reached. Your new value is still here — try again.",
				);
				return;
			}
			if (result.kind === "replaced") {
				setReplaceDraft(null);
				showToast(
					"info",
					"Value replaced",
					"The new value is saved on the case. The original moved to Dismissed.",
				);
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

	const entries = state.kind === "entries" ? state.entries : [];
	const counts = reviewCounts(entries);
	// The Dismissed pill disables at zero. When the view sits on
	// Dismissed as its last entry leaves, move the STATE itself back to
	// Ready (a guarded render-time reset) — a display-only fallback
	// would leave "dismissed" latched, and the next dismissal from the
	// Ready list would yank the screen back to Dismissed mid-review.
	if (
		state.kind === "entries" &&
		filter === "dismissed" &&
		counts.dismissed === 0
	) {
		setFilter("ready");
	}
	const groups = groupReviewByCase(filterReviewEntries(entries, filter));

	return (
		<ContentFrame width="5xl" className="px-6 pt-7 pb-16">
			<div className="min-w-0">
				<h1 className="font-display text-2xl font-semibold tracking-tight text-nova-text">
					Data to review
				</h1>
				<p className="mt-2 max-w-2xl text-sm leading-relaxed text-pretty text-nova-text-secondary">
					When a property changes and a value it held no longer fits, that value
					comes off its case and waits here. Put it back on the case, replace it
					with one that fits, or dismiss it. If the property changes back,
					waiting values that fit again return on their own.
				</p>
			</div>
			{!canEdit && entries.length > 0 && (
				<p className="mt-3 max-w-2xl rounded-lg bg-nova-elevated px-3 py-2.5 text-sm leading-relaxed text-nova-text-secondary">
					You can view this list, but putting values back or changing them needs
					edit access
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
						If a property change ever leaves a saved value that no longer fits,
						it’s kept here for you to review.
					</p>
				</div>
			) : (
				<>
					<fieldset className="mt-5 flex flex-wrap items-center gap-2">
						<legend className="sr-only">Filter the list</legend>
						{(
							[
								["ready", "Ready to review", counts.ready],
								["dismissed", "Dismissed", counts.dismissed],
							] as const
						).map(([value, label, count]) => (
							<Button
								key={value}
								type="button"
								variant="ghost"
								aria-pressed={filter === value}
								disabled={count === 0 && value === "dismissed"}
								onClick={() => setFilter(value)}
								className={`min-h-11 rounded-full border px-4 text-[13px] ${
									filter === value
										? "border-nova-border-bright bg-nova-violet/[0.12] text-nova-text"
										: "border-nova-border text-nova-text-secondary not-disabled:hover:border-nova-border-bright"
								}`}
							>
								{label} · {count}
							</Button>
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
							Nothing to review right now
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
								propertyChip={propertyChip}
								onViewCase={() =>
									setViewCase({
										caseId: group.caseId,
										caseName: group.caseName,
									})
								}
								onPutBack={(entry) => putBackEntry(entry.id)}
								onDismiss={(entry) => dismissEntry(entry.id)}
								onUndismiss={(entry) => undismissEntry(entry.id)}
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

			{viewCase !== null && (
				<CaseDetailDialog
					appId={appId}
					caseType={caseType}
					caseId={viewCase.caseId}
					caseName={viewCase.caseName}
					onClose={() => setViewCase(null)}
				/>
			)}
		</ContentFrame>
	);
}

function ReviewCaseCard({
	group,
	canEdit,
	busyIds,
	replaceDraft,
	dismissedView,
	propertyDecl,
	propertyChip,
	onViewCase,
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
	readonly propertyChip: (name: string) => ReactElement;
	readonly onViewCase: () => void;
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
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1 pr-2 pl-4">
				<h2 className="min-w-0 text-[15px] font-semibold break-words text-nova-text">
					{group.caseName || "Unnamed case"}
				</h2>
				<Button
					type="button"
					variant="ghost"
					className="min-h-11 text-[13px] text-nova-text-secondary"
					onClick={onViewCase}
				>
					<Icon icon={tablerEye} width="15" height="15" />
					View case
				</Button>
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
					chip={propertyChip(entry.property)}
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
	chip,
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
	readonly chip: ReactElement;
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

	// A row offers every action that works for it: Put back when the
	// value fits its property again, Replace whenever the property is
	// still declared (both at once when both work — the leftmost,
	// violet button is the suggested one), Dismiss always. A button
	// that couldn't work is never rendered at all, let alone disabled
	// beside a live one. A park whose property is no longer declared
	// (a rename's retired source, a removed property) offers only
	// Dismiss and View case: the store rejects a write under an
	// undeclared key, so Put back and Replace would fail on every
	// save — and a put-back reappears by itself if the property is
	// ever declared again.
	const restorable = entry.restorable;
	const replaceable = currentDecl !== undefined;

	return (
		<div className="border-t border-nova-violet/[0.08]">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2">
				<p className="min-w-52 flex-1 text-[13.5px] break-words text-nova-text">
					{chip} <span className="text-nova-text-muted">“</span>
					{display}
					<span className="text-nova-text-muted">”</span>
				</p>
				{canEdit && (
					<div className="flex shrink-0 items-center gap-1.5">
						{dismissedView ? (
							<Button
								type="button"
								variant="ghost"
								className="min-h-11 text-[13px] text-nova-text-secondary"
								disabled={busy}
								onClick={onUndismiss}
							>
								<Icon icon={tablerArrowBackUp} width="15" height="15" />
								Move back to review
							</Button>
						) : (
							<>
								{restorable && (
									<SimpleTooltip content="Saves this value on its case again">
										<Button
											type="button"
											variant="outline"
											className="min-h-11 text-[13px] text-nova-violet-bright"
											disabled={busy}
											onClick={onPutBack}
										>
											Put back
										</Button>
									</SimpleTooltip>
								)}
								{replaceable && (
									<SimpleTooltip content="Enter a new value to save instead">
										<Button
											type="button"
											variant={restorable ? "ghost" : "outline"}
											className={
												restorable
													? "min-h-11 text-[13px] text-nova-text-secondary"
													: "min-h-11 text-[13px] text-nova-violet-bright"
											}
											disabled={busy}
											onClick={onOpenReplace}
										>
											Replace
										</Button>
									</SimpleTooltip>
								)}
								<SimpleTooltip content="Moves this to the Dismissed list">
									<Button
										type="button"
										variant="ghost"
										className="min-h-11 text-[13px] text-nova-text-secondary"
										disabled={busy}
										onClick={onDismiss}
									>
										Dismiss
									</Button>
								</SimpleTooltip>
							</>
						)}
					</div>
				)}
			</div>

			{replaceDraft !== null && (
				<ReplaceEditor
					draft={replaceDraft}
					currentDecl={currentDecl}
					chip={chip}
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
	chip,
	caseName,
	displayOriginal,
	onDraftChange,
	onCancel,
	onSave,
}: {
	readonly draft: ReplaceDraft;
	readonly currentDecl: CaseProperty | undefined;
	readonly chip: ReactElement;
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
				A new {chip} value for {caseName || "this case"}
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
				Saves to this case’s {chip}. The original “{displayOriginal}” moves to
				Dismissed.
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
