/**
 * Levels — the rungs of the organization.
 *
 * A level answers two questions that CommCare stores as eight interacting
 * booleans and that authors routinely conflate: which cases a worker
 * RECEIVES, and which places a worker can SEE and address. They are scoped
 * independently on the platform, and the whole design of this editor is to
 * keep them visibly apart — two labelled groups, each a closed set of
 * choices in plain language, never a list of flags.
 *
 * The second group stays collapsed while it holds its default, because
 * "their own part of the organization" is right for almost every level and
 * an expanded set of radio buttons would imply a decision the author does
 * not have to make.
 */
"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Checkbox } from "@/components/shadcn/checkbox";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import { Label } from "@/components/shadcn/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { Textarea } from "@/components/shadcn/textarea";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	useLocationProperties,
	useOrganizationLevels,
} from "@/lib/doc/hooks/useOrganizationCollections";
import { removeOrganizationLevelPlan } from "@/lib/doc/organizationMutations";
import type { Uuid } from "@/lib/doc/types";
import {
	ancestorLevels,
	asUuid,
	type DescendantCaseScope,
	LEVEL_CODE_MAX_LENGTH,
	LEVEL_CODE_PATTERN,
	type LevelAddressBook,
	type LevelCaseFlow,
	type OrganizationLevel,
} from "@/lib/domain";
import {
	type OrganizationLevelPatch,
	organizationLevelPatchIssue,
} from "@/lib/organization/levelUpdateVerdicts";
import type { StoredLocation } from "@/lib/organization/types";
import { useAccessPhase, useCanEdit } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import { useRemovedRowFocus } from "@/lib/ui/hooks/useRemovedRowFocus";
import { DraftCommitInput } from "./DraftCommitField";
import { uniqueLevelCode } from "./organizationUi";
import { EntryRow, Subsection, SubsectionEmpty } from "./subsection";

/** Sentinel for "no parent": a Select item cannot carry an empty value. */
const TOP_LEVEL = "__top__";
const NO_LEVEL_LIMIT = "__none__";

export function LevelsSubsection({
	occupiedLevelUuids,
	locations,
}: {
	/** Levels that currently hold at least one place, so a removal can say
	 *  so immediately rather than after a round trip. */
	occupiedLevelUuids: ReadonlySet<string>;
	locations: readonly StoredLocation[];
}) {
	const levels = useOrganizationLevels();
	const canEdit = useCanEdit();
	const accessPhase = useAccessPhase();
	const sessionApi = useBuilderSessionApi();
	const mutations = useBlueprintMutations();
	const [openUuid, setOpenUuid] = useState<string | undefined>(undefined);
	const [adding, setAdding] = useState(false);
	const rowFocus = useRemovedRowFocus(levels.length);

	useEffect(() => {
		if (!adding || canEdit) return;
		if (accessPhase === "refreshing" || accessPhase === "reconnecting") return;
		setAdding(false);
	}, [accessPhase, adding, canEdit]);

	const add = (name: string, authoredCode: string) => {
		if (!sessionApi.getState().canEdit) return false;
		const result = mutations.addOrganizationLevel({
			name,
			code:
				authoredCode.trim() === ""
					? uniqueLevelCode(name, levels)
					: authoredCode.trim(),
			// A new rung goes under the deepest existing one, which is what an
			// author adding levels top-down means every time. Changing it is one
			// control away.
			...(levels.length > 0 && {
				parentLevelUuid: levels[levels.length - 1].uuid,
			}),
			caseFlow: {
				workers: "assigned",
				ownsCases: true,
				descendantCases: { kind: "none" },
			},
			addressBook: { reach: "own-branch" },
		});
		if (result.ok) {
			setAdding(false);
			setOpenUuid(result.uuid);
			rowFocus.focusRow(levels.length);
			return true;
		}
		return false;
	};

	return (
		<Subsection
			id="app-setup-levels"
			title="Levels"
			description="Define the kinds of place in your organization, such as regions, districts, facilities, or wards. For each level, choose whether people work there, whether its places own cases, and what those workers can see."
			addLabel="Add level"
			onAdd={() => setAdding(true)}
			canEdit={canEdit && !adding}
			addButtonRef={rowFocus.addRef}
		>
			{levels.length === 0 ? (
				<SubsectionEmpty>
					Start with the widest level, such as a region or state. Then add the
					levels below it.
				</SubsectionEmpty>
			) : (
				levels.map((level, index) => (
					<LevelRow
						key={level.uuid}
						level={level}
						peers={levels}
						occupied={occupiedLevelUuids.has(level.uuid)}
						locations={locations}
						open={openUuid === level.uuid}
						onOpenChange={(next) => setOpenUuid(next ? level.uuid : undefined)}
						rowFocusRef={rowFocus.register(index)}
						onRemove={() => rowFocus.onRemoved(index)}
					/>
				))
			)}
			{adding && (
				<AddLevelForm
					levels={levels}
					disabled={!canEdit || accessPhase !== "authorized"}
					onCancel={() => {
						setAdding(false);
						rowFocus.focusRow(levels.length);
					}}
					onSubmit={add}
				/>
			)}
		</Subsection>
	);
}

function AddLevelForm({
	levels,
	disabled,
	onCancel,
	onSubmit,
}: {
	levels: readonly OrganizationLevel[];
	disabled: boolean;
	onCancel: () => void;
	onSubmit: (name: string, code: string) => boolean;
}) {
	const [name, setName] = useState("");
	const [code, setCode] = useState("");
	const [error, setError] = useState<
		{ field: "name" | "code" | "form"; message: string } | undefined
	>();
	const nameId = useId();
	const codeId = useId();
	const nameErrorId = useId();
	const codeDescriptionId = useId();
	const codeErrorId = useId();
	const formErrorId = useId();
	const nameRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (!disabled) nameRef.current?.focus();
	}, [disabled]);

	const submit = () => {
		const cleanName = name.trim();
		const cleanCode = code.trim();
		if (cleanName === "") {
			setError({ field: "name", message: "Add a name for this level." });
			return;
		}
		if (
			cleanCode !== "" &&
			(cleanCode.length > LEVEL_CODE_MAX_LENGTH ||
				!LEVEL_CODE_PATTERN.test(cleanCode))
		) {
			setError({
				field: "code",
				message:
					"Use a code that starts with a letter or underscore and contains only letters, numbers, underscores, or hyphens.",
			});
			return;
		}
		if (!onSubmit(cleanName, cleanCode)) {
			setError({
				field: "form",
				message: "Couldn't add this level. Use a different name or code.",
			});
		}
	};

	return (
		<fieldset
			disabled={disabled}
			className="flex flex-col gap-3 rounded-lg border border-nova-border bg-nova-deep/40 p-3"
		>
			<FieldGroup className="gap-4">
				<Field data-invalid={error?.field === "name" || undefined}>
					<FieldLabel htmlFor={nameId}>Level name</FieldLabel>
					<Input
						ref={nameRef}
						id={nameId}
						value={name}
						autoComplete="off"
						data-1p-ignore
						aria-invalid={error?.field === "name" || undefined}
						aria-describedby={error?.field === "name" ? nameErrorId : undefined}
						onChange={(event) => {
							setName(event.target.value);
							if (error?.field === "name") setError(undefined);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") submit();
						}}
						placeholder="Facility"
					/>
					{error?.field === "name" && (
						<FieldError id={nameErrorId}>{error.message}</FieldError>
					)}
				</Field>
				<Field data-invalid={error?.field === "code" || undefined}>
					<FieldLabel htmlFor={codeId}>Code (optional)</FieldLabel>
					<Input
						id={codeId}
						value={code}
						autoComplete="off"
						data-1p-ignore
						aria-invalid={error?.field === "code" || undefined}
						aria-describedby={
							error?.field === "code"
								? `${codeDescriptionId} ${codeErrorId}`
								: codeDescriptionId
						}
						onChange={(event) => {
							setCode(event.target.value);
							if (error?.field === "code") setError(undefined);
						}}
						placeholder={
							name.trim() === "" ? "facility" : uniqueLevelCode(name, levels)
						}
					/>
					<FieldDescription id={codeDescriptionId}>
						Leave this blank to create a code from the name. You can't change
						the code later.
					</FieldDescription>
					{error?.field === "code" && (
						<FieldError id={codeErrorId}>{error.message}</FieldError>
					)}
				</Field>
			</FieldGroup>
			{error?.field === "form" && (
				<FieldError id={formErrorId}>{error.message}</FieldError>
			)}
			<div className="flex gap-2">
				<Button type="button" onClick={submit}>
					Add level
				</Button>
				<Button type="button" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</fieldset>
	);
}

/** The one-line summary shown on a collapsed row. */
function summarize(level: OrganizationLevel): string {
	const flow = level.caseFlow;
	if (flow.workers === "none") {
		return flow.ownsCases ? "Owns cases, nobody works here" : "Structure only";
	}
	if (!flow.ownsCases) return "People work here, owns nothing itself";
	return flow.descendantCases.kind === "none"
		? "People work here, owns its cases"
		: "People work here, owns its cases and those below";
}

function LevelRow({
	level,
	peers,
	occupied,
	locations,
	open,
	onOpenChange,
	rowFocusRef,
	onRemove,
}: {
	level: OrganizationLevel;
	peers: readonly OrganizationLevel[];
	occupied: boolean;
	locations: readonly StoredLocation[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	rowFocusRef: (element: HTMLButtonElement | null) => void;
	onRemove: () => void;
}) {
	const canEdit = useCanEdit();
	const mutations = useBlueprintMutations();
	const doc = useBlueprintDoc((state) => state);
	const [levelIssue, setLevelIssue] = useState<string | undefined>();
	const properties = useLocationProperties();
	const nameId = useId();
	const nameDescriptionId = useId();
	const parentId = useId();
	const descriptionId = useId();

	// Collapsed rows render only their summary. Do not run hierarchy walks (or
	// any cross-store verdict that consumes `locations`) for every closed row.
	const levelRecord = open
		? Object.fromEntries(peers.map((p) => [p.uuid, p]))
		: {};
	const above = open ? ancestorLevels(level, levelRecord) : [];
	const selfAndBelow = open
		? peers.filter(
				(candidate) =>
					candidate.uuid === level.uuid ||
					ancestorLevels(candidate, levelRecord).some(
						(ancestor) => ancestor.uuid === level.uuid,
					),
			)
		: [];
	// The structural list excludes only self and descendants. Exact cross-store
	// verdicts stay attached to each remaining choice so a refused move remains
	// visible with its recovery reason instead of disappearing from the menu.
	const parentOptions = open
		? peers.filter(
				(candidate) =>
					candidate.uuid !== level.uuid &&
					!ancestorLevels(candidate, levelRecord).some(
						(a) => a.uuid === level.uuid,
					),
			)
		: [];
	const issueFor = (patch: OrganizationLevelPatch) =>
		organizationLevelPatchIssue(doc, locations, level.uuid, patch);
	const commitPatch = (patch: OrganizationLevelPatch) => {
		const issue = issueFor(patch);
		if (issue !== undefined) {
			setLevelIssue(issue);
			return;
		}
		setLevelIssue(undefined);
		mutations.updateOrganizationLevel(level.uuid, patch);
	};

	return (
		<EntryRow
			triggerRef={rowFocusRef}
			summary={level.name}
			detail={summarize(level)}
			open={open}
			onOpenChange={onOpenChange}
			keepMounted={false}
		>
			{open ? (
				<div className="flex flex-col gap-4">
					<Field>
						<FieldLabel htmlFor={nameId}>Name</FieldLabel>
						<DraftCommitInput
							id={nameId}
							ariaDescribedBy={nameDescriptionId}
							value={level.name}
							disabled={
								!canEdit ||
								(level.parentLevelUuid !== undefined &&
									issueFor({ parentLevelUuid: null }) !== undefined &&
									parentOptions.length === 0)
							}
							validate={(name) =>
								name === "" ? "Enter a name for this level." : undefined
							}
							onCommit={(name) =>
								mutations.inline.updateOrganizationLevel(level.uuid, {
									name,
								})
							}
						/>
						<FieldDescription id={nameDescriptionId}>
							Saves as{" "}
							<code className="text-nova-text-secondary [overflow-wrap:anywhere]">
								{level.code}
							</code>
							. The code stays the same when you rename this level.
						</FieldDescription>
					</Field>

					<div className="flex flex-col gap-1.5">
						<Label
							htmlFor={parentId}
							className="text-[12px] font-medium text-nova-text-secondary"
						>
							Sits under
						</Label>
						<Select
							value={level.parentLevelUuid ?? TOP_LEVEL}
							disabled={!canEdit}
							onValueChange={(value) => {
								if (typeof value !== "string") return;
								commitPatch({
									parentLevelUuid: value === TOP_LEVEL ? null : asUuid(value),
								});
							}}
						>
							<SelectTrigger id={parentId} wrapValue className="w-full">
								<SelectValue>
									{level.parentLevelUuid === undefined
										? "No parent (top level)"
										: (peers.find((p) => p.uuid === level.parentLevelUuid)
												?.name ?? "A level that no longer exists")}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<IssueSelectItem
									value={TOP_LEVEL}
									issue={issueFor({ parentLevelUuid: null })}
								>
									No parent (top level)
								</IssueSelectItem>
								{parentOptions.map((candidate) => (
									<IssueSelectItem
										key={candidate.uuid}
										value={candidate.uuid}
										issue={issueFor({ parentLevelUuid: candidate.uuid })}
									>
										{candidate.name}
									</IssueSelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<CaseFlowGroup
						level={level}
						peers={selfAndBelow}
						issueFor={issueFor}
						onPatch={commitPatch}
					/>
					<AddressBookGroup
						level={level}
						above={above}
						peers={peers}
						selfAndBelow={selfAndBelow}
						issueFor={issueFor}
						onPatch={commitPatch}
					/>

					{levelIssue !== undefined && (
						<p
							role="alert"
							className="text-[12px] leading-relaxed text-nova-red"
						>
							{levelIssue}
						</p>
					)}

					<div className="flex flex-col gap-1.5">
						<Label
							htmlFor={descriptionId}
							className="text-[12px] font-medium text-nova-text-secondary"
						>
							Notes
						</Label>
						<Textarea
							id={descriptionId}
							rows={2}
							value={level.description ?? ""}
							autoComplete="off"
							data-1p-ignore
							disabled={!canEdit}
							onChange={(e) =>
								mutations.updateOrganizationLevel(level.uuid, {
									description: e.target.value === "" ? null : e.target.value,
								})
							}
						/>
					</div>

					{properties.length > 0 && (
						<p className="text-[12px] leading-relaxed text-nova-text-muted">
							Places at this level carry{" "}
							{properties
								.filter(
									(property) =>
										property.levelUuids === undefined ||
										property.levelUuids.some((uuid) => uuid === level.uuid),
								)
								.map((property) => property.label)
								.join(", ") || "no extra information"}
							.
						</p>
					)}

					{canEdit && (
						<RemoveLevel
							level={level}
							occupied={occupied}
							onRemove={onRemove}
						/>
					)}
				</div>
			) : null}
		</EntryRow>
	);
}

/**
 * Which cases a worker at this level receives — one of the two axes.
 *
 * `descendantCases` only appears when people work here, because CommCare
 * reads it off the type of a location a worker is ASSIGNED to: on a level
 * nobody can be assigned to, it is inert. The schema makes that state
 * unexpressible and this makes it invisible, which is the same fact told
 * twice on purpose.
 */
function CaseFlowGroup({
	level,
	peers,
	issueFor,
	onPatch,
}: {
	level: OrganizationLevel;
	peers: readonly OrganizationLevel[];
	issueFor: (patch: OrganizationLevelPatch) => string | undefined;
	onPatch: (patch: OrganizationLevelPatch) => void;
}) {
	const canEdit = useCanEdit();
	const descendantId = useId();
	const flow = level.caseFlow;

	const set = (next: LevelCaseFlow) => onPatch({ caseFlow: next });
	const workersOff: LevelCaseFlow = {
		workers: "none",
		ownsCases: flow.ownsCases,
	};
	const workersOn: LevelCaseFlow = {
		workers: "assigned",
		ownsCases: flow.ownsCases,
		descendantCases: { kind: "none" },
	};
	const ownsCasesToggled: LevelCaseFlow =
		flow.workers === "assigned"
			? { ...flow, ownsCases: !flow.ownsCases }
			: { workers: "none", ownsCases: !flow.ownsCases };
	const workersIssue = issueFor({
		caseFlow: flow.workers === "assigned" ? workersOff : workersOn,
	});
	const ownsCasesIssue = issueFor({ caseFlow: ownsCasesToggled });

	return (
		<fieldset className="rounded-lg border border-nova-border p-3">
			<legend className="px-1 text-[12px] font-medium text-nova-text-secondary">
				Cases
			</legend>
			<div className="flex flex-col gap-2.5">
				<Choice
					label="People work here"
					checked={flow.workers === "assigned"}
					disabled={!canEdit || workersIssue !== undefined}
					issue={workersIssue}
					onChange={(checked) => set(checked ? workersOn : workersOff)}
					hint="Personas and deployed workers can be assigned to places at this level."
				/>
				<Choice
					label="Places here own cases"
					checked={flow.ownsCases}
					disabled={!canEdit || ownsCasesIssue !== undefined}
					issue={ownsCasesIssue}
					onChange={(checked) =>
						set(
							flow.workers === "assigned"
								? { ...flow, ownsCases: checked }
								: { workers: "none", ownsCases: checked },
						)
					}
					hint={
						flow.workers === "none"
							? "Cases can be owned here even when no worker is assigned here."
							: "Assigned workers receive the cases their place owns."
					}
				/>
				{flow.workers === "assigned" && (
					<div className="flex flex-col gap-1.5 pl-6">
						<Label
							htmlFor={descendantId}
							className="text-[12px] font-medium text-nova-text-secondary"
						>
							Include cases from places below in worker delivery
						</Label>
						<Select
							value={scopeValue(flow.descendantCases)}
							disabled={!canEdit}
							onValueChange={(value) => {
								if (typeof value !== "string") return;
								set({ ...flow, descendantCases: scopeFromValue(value) });
							}}
						>
							<SelectTrigger id={descendantId} wrapValue className="w-full">
								<SelectValue>
									{descendantLabel(flow.descendantCases, peers)}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<IssueSelectItem
									value="none"
									issue={issueFor({
										caseFlow: { ...flow, descendantCases: { kind: "none" } },
									})}
								>
									Only their own place
								</IssueSelectItem>
								<IssueSelectItem
									value="all"
									issue={issueFor({
										caseFlow: { ...flow, descendantCases: { kind: "all" } },
									})}
								>
									Everything below
								</IssueSelectItem>
								{peers.map((ancestor) => (
									<IssueSelectItem
										key={ancestor.uuid}
										value={`down-to:${ancestor.uuid}`}
										issue={issueFor({
											caseFlow: {
												...flow,
												descendantCases: {
													kind: "down-to",
													levelUuid: ancestor.uuid,
												},
											},
										})}
									>
										Down to {ancestor.name}
									</IssueSelectItem>
								))}
							</SelectContent>
						</Select>
						{flow.descendantCases.kind === "down-to" && (
							<p className="text-[12px] leading-relaxed text-nova-amber">
								This choice needs matching support in the project you publish
								to. Otherwise workers receive cases from every place below.
							</p>
						)}
					</div>
				)}
			</div>
		</fieldset>
	);
}

/** The trigger's text for each address-book reach. */
const REACH_LABELS: Readonly<Record<LevelAddressBook["reach"], string>> = {
	"own-branch": "Their own place, everything under it, and the chain above",
	"own-branch-limited": "Their own place, but only certain levels",
	"shared-branch": "Everything under a level further up",
	"whole-organization": "The whole organization",
};

/** The trigger's text for a descendant-cases scope. */
function descendantLabel(
	scope: DescendantCaseScope,
	levels: readonly OrganizationLevel[],
): string {
	if (scope.kind === "all") return "Everything below";
	if (scope.kind === "none") return "Only their own place";
	const named = levels.find((level) => level.uuid === scope.levelUuid);
	return named === undefined
		? "Down to a level that no longer exists"
		: `Down to ${named.name}`;
}

function scopeValue(scope: DescendantCaseScope): string {
	return scope.kind === "down-to" ? `down-to:${scope.levelUuid}` : scope.kind;
}

function scopeFromValue(value: string): DescendantCaseScope {
	if (value === "all") return { kind: "all" };
	if (value.startsWith("down-to:")) {
		return {
			kind: "down-to",
			levelUuid: asUuid(value.slice("down-to:".length)),
		};
	}
	return { kind: "none" };
}

/**
 * Which places a worker at this level can see and name — the other axis.
 *
 * Four coherent starting shapes, followed by only the depth controls that
 * apply to the selected shape. CommCare's raw fixture flags also admit
 * combinations its own query calls undefined outcomes; those never appear.
 */
function AddressBookGroup({
	level,
	above,
	peers,
	selfAndBelow,
	issueFor,
	onPatch,
}: {
	level: OrganizationLevel;
	above: readonly OrganizationLevel[];
	peers: readonly OrganizationLevel[];
	selfAndBelow: readonly OrganizationLevel[];
	issueFor: (patch: OrganizationLevelPatch) => string | undefined;
	onPatch: (patch: OrganizationLevelPatch) => void;
}) {
	const canEdit = useCanEdit();
	const reachId = useId();
	const fromId = useId();
	const downToId = useId();
	const topSliceId = useId();
	const book = level.addressBook;
	const bookWithoutDownTo = { ...book };
	delete (bookWithoutDownTo as { downToLevelUuid?: Uuid }).downToLevelUuid;
	const bookWithoutTopSlice = { ...book };
	delete (bookWithoutTopSlice as { alsoIncludeTopDownToLevelUuid?: Uuid })
		.alsoIncludeTopDownToLevelUuid;
	const isDefault =
		book.reach === "own-branch" &&
		book.downToLevelUuid === undefined &&
		book.alsoIncludeTopDownToLevelUuid === undefined;
	const [expanded, setExpanded] = useState(!isDefault);
	useEffect(() => {
		if (!isDefault) setExpanded(true);
	}, [isDefault]);

	const set = (next: LevelAddressBook) => onPatch({ addressBook: next });
	const downToOptions = (() => {
		if (book.reach === "whole-organization") return peers;
		if (book.reach === "shared-branch") {
			const from = peers.find(
				(candidate) => candidate.uuid === book.fromLevelUuid,
			);
			if (from === undefined) return [];
			return peers.filter(
				(candidate) =>
					candidate.uuid === from.uuid ||
					ancestorLevels(
						candidate,
						Object.fromEntries(peers.map((p) => [p.uuid, p])),
					).some((ancestor) => ancestor.uuid === from.uuid),
			);
		}
		return selfAndBelow;
	})();
	const limitedSelection = (candidate: OrganizationLevel, checked: boolean) => {
		const current = new Set(
			book.reach === "own-branch-limited" ? book.levelUuids : [],
		);
		if (checked) {
			current.add(level.uuid);
			current.add(candidate.uuid);
			for (const ancestor of ancestorLevels(
				candidate,
				Object.fromEntries(peers.map((peer) => [peer.uuid, peer])),
			)) {
				if (
					ancestor.uuid === level.uuid ||
					selfAndBelow.some((below) => below.uuid === ancestor.uuid)
				) {
					current.add(ancestor.uuid);
				}
			}
		} else {
			for (const selectedUuid of [...current]) {
				const selected = peers.find((peer) => peer.uuid === selectedUuid);
				if (
					selectedUuid === candidate.uuid ||
					(selected !== undefined &&
						ancestorLevels(
							selected,
							Object.fromEntries(peers.map((peer) => [peer.uuid, peer])),
						).some((ancestor) => ancestor.uuid === candidate.uuid))
				) {
					current.delete(selectedUuid);
				}
			}
		}
		return selfAndBelow
			.filter((candidateLevel) => current.has(candidateLevel.uuid))
			.map((candidateLevel) => candidateLevel.uuid);
	};

	if (!expanded) {
		return (
			<div className="flex items-center justify-between gap-3 rounded-lg border border-nova-border px-3 py-2.5">
				<p className="text-[12px] text-nova-text-secondary">
					Workers here can see their own part of the organization.
				</p>
				<Button
					type="button"
					variant="ghost-action"
					className="shrink-0"
					onClick={() => setExpanded(true)}
					disabled={!canEdit}
				>
					Change
				</Button>
			</div>
		);
	}

	return (
		<fieldset className="rounded-lg border border-nova-border p-3">
			<legend className="px-1 text-[12px] font-medium text-nova-text-secondary">
				What workers here can see
			</legend>
			<p className="mb-2.5 text-[12px] leading-relaxed text-nova-text-muted">
				Seeing a place is separate from receiving its cases. Use this setting to
				control which places workers can name in case-owner rules.
			</p>
			<div className="flex flex-col gap-2.5">
				<Label htmlFor={reachId} className="sr-only">
					How much of the organization workers here can see
				</Label>
				<Select
					value={book.reach}
					disabled={!canEdit}
					onValueChange={(value) => {
						if (typeof value !== "string") return;
						if (value === "own-branch") return set({ reach: "own-branch" });
						if (value === "whole-organization") {
							return set({ reach: "whole-organization" });
						}
						if (value === "own-branch-limited") {
							return set({
								reach: "own-branch-limited",
								levelUuids: [level.uuid],
							});
						}
						if (above[0] !== undefined) {
							set({ reach: "shared-branch", fromLevelUuid: above[0].uuid });
						}
					}}
				>
					<SelectTrigger id={reachId} wrapValue className="w-full">
						<SelectValue>{REACH_LABELS[book.reach]}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<IssueSelectItem
							value="own-branch"
							issue={issueFor({ addressBook: { reach: "own-branch" } })}
						>
							Their own place, everything under it, and the chain above
						</IssueSelectItem>
						<IssueSelectItem
							value="own-branch-limited"
							issue={
								selfAndBelow.length === 0
									? "Add this level to the hierarchy before limiting its branch."
									: issueFor({
											addressBook: {
												reach: "own-branch-limited",
												levelUuids: [level.uuid],
											},
										})
							}
						>
							Their own place, but only certain levels
						</IssueSelectItem>
						<IssueSelectItem
							value="shared-branch"
							issue={
								above[0] === undefined
									? "Add a level above this one before sharing a higher branch."
									: issueFor({
											addressBook: {
												reach: "shared-branch",
												fromLevelUuid: above[0].uuid,
											},
										})
							}
						>
							Everything under a level further up
						</IssueSelectItem>
						<IssueSelectItem
							value="whole-organization"
							issue={issueFor({
								addressBook: { reach: "whole-organization" },
							})}
						>
							The whole organization
						</IssueSelectItem>
					</SelectContent>
				</Select>
				{book.reach === "shared-branch" && above.length > 0 && (
					<div className="flex flex-col gap-1.5 pl-6">
						<Label
							htmlFor={fromId}
							className="text-[12px] font-medium text-nova-text-secondary"
						>
							Starting from
						</Label>
						<Select
							value={book.fromLevelUuid}
							disabled={!canEdit}
							onValueChange={(value) => {
								if (typeof value !== "string") return;
								set({ ...book, fromLevelUuid: asUuid(value) });
							}}
						>
							<SelectTrigger id={fromId} wrapValue className="w-full">
								<SelectValue>
									{above.find((a) => a.uuid === book.fromLevelUuid)?.name ??
										"A level that no longer exists"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{above.map((ancestor) => (
									<IssueSelectItem
										key={ancestor.uuid}
										value={ancestor.uuid}
										issue={issueFor({
											addressBook: {
												...book,
												fromLevelUuid: ancestor.uuid,
											},
										})}
									>
										{ancestor.name}
									</IssueSelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}
				{book.reach === "own-branch-limited" && (
					<fieldset className="flex flex-col gap-2 pl-6">
						<legend className="text-[12px] font-medium text-nova-text-secondary">
							Levels to carry in their own branch
						</legend>
						{selfAndBelow.map((candidate) => {
							const checked = book.levelUuids.includes(candidate.uuid);
							const issue = issueFor({
								addressBook: {
									...book,
									levelUuids: limitedSelection(candidate, !checked),
								},
							});
							return (
								<Choice
									key={candidate.uuid}
									label={candidate.name}
									hint=""
									issue={
										candidate.uuid === level.uuid
											? "A worker always carries their own level."
											: issue
									}
									checked={checked}
									disabled={
										!canEdit ||
										candidate.uuid === level.uuid ||
										issue !== undefined
									}
									onChange={(next) =>
										set({
											...book,
											levelUuids: limitedSelection(candidate, next),
										})
									}
								/>
							);
						})}
					</fieldset>
				)}
				{book.reach !== "own-branch-limited" && (
					<div className="flex flex-col gap-1.5 pl-6">
						<Label
							htmlFor={downToId}
							className="text-[12px] font-medium text-nova-text-secondary"
						>
							Stop descending at
						</Label>
						<Select
							value={book.downToLevelUuid ?? NO_LEVEL_LIMIT}
							disabled={!canEdit}
							onValueChange={(value) => {
								if (typeof value !== "string") return;
								const { downToLevelUuid: _downTo, ...withoutDownTo } = book;
								set(
									value === NO_LEVEL_LIMIT
										? withoutDownTo
										: { ...withoutDownTo, downToLevelUuid: asUuid(value) },
								);
							}}
						>
							<SelectTrigger id={downToId} wrapValue className="w-full">
								<SelectValue>
									{book.downToLevelUuid === undefined
										? "No limit"
										: (peers.find(
												(candidate) => candidate.uuid === book.downToLevelUuid,
											)?.name ?? "A level that no longer exists")}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<IssueSelectItem
									value={NO_LEVEL_LIMIT}
									issue={issueFor({
										addressBook: bookWithoutDownTo as LevelAddressBook,
									})}
								>
									No limit
								</IssueSelectItem>
								{downToOptions.map((candidate) => (
									<IssueSelectItem
										key={candidate.uuid}
										value={candidate.uuid}
										issue={issueFor({
											addressBook: {
												...book,
												downToLevelUuid: candidate.uuid,
											},
										})}
									>
										{candidate.name}
									</IssueSelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}
				{(book.reach === "own-branch" ||
					book.reach === "own-branch-limited") && (
					<div className="flex flex-col gap-1.5 pl-6">
						<Label
							htmlFor={topSliceId}
							className="text-[12px] font-medium text-nova-text-secondary"
						>
							Also carry the top of the organization down to
						</Label>
						<Select
							value={book.alsoIncludeTopDownToLevelUuid ?? NO_LEVEL_LIMIT}
							disabled={!canEdit}
							onValueChange={(value) => {
								if (typeof value !== "string") return;
								const {
									alsoIncludeTopDownToLevelUuid: _topSlice,
									...withoutTopSlice
								} = book;
								set(
									value === NO_LEVEL_LIMIT
										? withoutTopSlice
										: {
												...withoutTopSlice,
												alsoIncludeTopDownToLevelUuid: asUuid(value),
											},
								);
							}}
						>
							<SelectTrigger id={topSliceId} wrapValue className="w-full">
								<SelectValue>
									{book.alsoIncludeTopDownToLevelUuid === undefined
										? "Do not add a top slice"
										: (peers.find(
												(candidate) =>
													candidate.uuid === book.alsoIncludeTopDownToLevelUuid,
											)?.name ?? "A level that no longer exists")}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<IssueSelectItem
									value={NO_LEVEL_LIMIT}
									issue={issueFor({
										addressBook: bookWithoutTopSlice as LevelAddressBook,
									})}
								>
									Do not add a top slice
								</IssueSelectItem>
								{peers.map((candidate) => (
									<IssueSelectItem
										key={candidate.uuid}
										value={candidate.uuid}
										issue={issueFor({
											addressBook: {
												...book,
												alsoIncludeTopDownToLevelUuid: candidate.uuid,
											},
										})}
									>
										{candidate.name}
									</IssueSelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}
			</div>
		</fieldset>
	);
}

function Choice({
	label,
	hint,
	issue,
	checked,
	disabled,
	onChange,
}: {
	label: string;
	hint: string;
	issue?: string;
	checked: boolean;
	disabled: boolean;
	onChange: (checked: boolean) => void;
}) {
	const id = useId();
	const hintId = `${id}-hint`;
	const issueId = `${id}-issue`;
	return (
		<div className="flex items-start gap-2.5">
			<Checkbox
				id={id}
				checked={checked}
				disabled={disabled}
				aria-describedby={`${hintId}${issue === undefined ? "" : ` ${issueId}`}`}
				onCheckedChange={(next) => onChange(next === true)}
				className="mt-1"
			/>
			<div className="min-w-0">
				<Label htmlFor={id} className="text-[13px] text-nova-text">
					{label}
				</Label>
				<p
					id={hintId}
					className="text-[12px] leading-relaxed text-nova-text-muted"
				>
					{hint}
				</p>
				{issue !== undefined && (
					<p id={issueId} className="text-[12px] leading-relaxed text-nova-red">
						{issue}
					</p>
				)}
			</div>
		</div>
	);
}

function IssueSelectItem({
	value,
	issue,
	disabled = false,
	children,
}: {
	value: string;
	issue?: string;
	disabled?: boolean;
	children: ReactNode;
}) {
	return (
		<SelectItem wrap value={value} disabled={disabled || issue !== undefined}>
			<span className="flex min-w-0 flex-col gap-0.5">
				<span>{children}</span>
				{issue !== undefined && (
					<span className="whitespace-normal text-[11px] leading-snug text-nova-red">
						{issue}
					</span>
				)}
			</span>
		</SelectItem>
	);
}

/**
 * Removing a level, confirmed in place.
 *
 * The refusal is stated before the confirmation opens where it can be —
 * a level that still holds places, or that another level sits under, is
 * never worth asking about.
 */
function RemoveLevel({
	level,
	occupied,
	onRemove,
}: {
	level: OrganizationLevel;
	occupied: boolean;
	onRemove: () => void;
}) {
	const mutations = useBlueprintMutations();
	const doc = useBlueprintDoc((state) => state);
	const [confirming, setConfirming] = useState(false);
	const [refusal, setRefusal] = useState<string | undefined>(undefined);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirming);
	const plan = removeOrganizationLevelPlan(
		doc,
		level.uuid,
		occupied ? new Set([level.uuid]) : undefined,
	);

	if (!confirming) {
		return (
			<div className="flex flex-col gap-1.5">
				<Button
					ref={triggerRef}
					type="button"
					variant="ghost-destructive"
					className="self-start"
					onClick={() => {
						setRefusal(undefined);
						if (!plan.ok) {
							setRefusal(plan.userMessage);
							return;
						}
						setConfirming(true);
					}}
				>
					Remove level
				</Button>
				{refusal !== undefined && (
					<p
						role="alert"
						className="max-w-prose text-[12px] leading-relaxed text-nova-red"
					>
						{refusal}
					</p>
				)}
			</div>
		);
	}

	return (
		<div
			ref={panelRef}
			tabIndex={-1}
			className="flex flex-col gap-2.5 rounded-lg border border-nova-red/40 bg-nova-red/[0.06] p-3 outline-none"
		>
			<p className="text-[13px] leading-relaxed text-nova-text">
				Remove “{level.name}”? The level and any settings that name it will be
				removed together.
			</p>
			<div className="flex gap-2">
				<Button
					type="button"
					variant="destructive"
					onClick={() => {
						onRemove();
						const result = mutations.removeOrganizationLevel(
							level.uuid,
							occupied ? new Set([level.uuid]) : undefined,
						);
						setConfirming(false);
						if (!result.ok) setRefusal(result.messages.join(" "));
					}}
				>
					Remove
				</Button>
				<Button
					type="button"
					variant="ghost"
					onClick={() => setConfirming(false)}
				>
					Keep it
				</Button>
			</div>
		</div>
	);
}
