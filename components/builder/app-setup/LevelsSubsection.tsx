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

import { useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Checkbox } from "@/components/shadcn/checkbox";
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
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	useLocationProperties,
	useOrganizationLevels,
} from "@/lib/doc/hooks/useOrganizationCollections";
import type { Uuid } from "@/lib/doc/types";
import {
	ancestorLevels,
	type DescendantCaseScope,
	type LevelAddressBook,
	type LevelCaseFlow,
	type OrganizationLevel,
} from "@/lib/domain";
import { useCanEdit } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import { EntryRow, Subsection, SubsectionEmpty } from "./subsection";

/** Sentinel for "no parent": a Select item cannot carry an empty value. */
const TOP_LEVEL = "__top__";

export function LevelsSubsection({
	occupiedLevelUuids,
}: {
	/** Levels that currently hold at least one place, so a removal can say
	 *  so immediately rather than after a round trip. */
	occupiedLevelUuids: ReadonlySet<string>;
}) {
	const levels = useOrganizationLevels();
	const canEdit = useCanEdit();
	const sessionApi = useBuilderSessionApi();
	const mutations = useBlueprintMutations();
	const [openUuid, setOpenUuid] = useState<string | undefined>(undefined);

	const add = () => {
		if (!sessionApi.getState().canEdit) return;
		const name = uniqueName(levels);
		const result = mutations.addOrganizationLevel({
			name,
			code: uniqueCode(name, levels),
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
		if (result.ok) setOpenUuid(result.uuid);
	};

	return (
		<Subsection
			id="app-setup-levels"
			title="Levels"
			description="The rungs of your organization — a district, a facility, a ward. Each one says whether people work there, whether it owns cases, and how much of the organization its workers can see."
			addLabel="Add level"
			onAdd={add}
			canEdit={canEdit}
		>
			{levels.length === 0 ? (
				<SubsectionEmpty>
					No levels yet. Add the top rung first — the widest one, like a region
					or a state — then work downward.
				</SubsectionEmpty>
			) : (
				levels.map((level) => (
					<LevelRow
						key={level.uuid}
						level={level}
						peers={levels}
						occupied={occupiedLevelUuids.has(level.uuid)}
						open={openUuid === level.uuid}
						onOpenChange={(next) => setOpenUuid(next ? level.uuid : undefined)}
					/>
				))
			)}
		</Subsection>
	);
}

function uniqueName(peers: readonly OrganizationLevel[]): string {
	const taken = new Set(peers.map((p) => p.name.trim().toLowerCase()));
	if (!taken.has("new level")) return "New level";
	for (let n = 2; ; n++) {
		const candidate = `New level ${n}`;
		if (!taken.has(candidate.toLowerCase())) return candidate;
	}
}

function uniqueCode(name: string, peers: readonly OrganizationLevel[]): string {
	const taken = new Set(peers.map((p) => p.code));
	const base =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "") || "level";
	// A code must start with a letter or underscore — it becomes an XML
	// attribute name in the fixture, and `2_id` is unaddressable.
	const safe = /^[a-z_]/.test(base) ? base : `l_${base}`;
	if (!taken.has(safe)) return safe;
	for (let n = 2; ; n++) {
		const candidate = `${safe}_${n}`;
		if (!taken.has(candidate)) return candidate;
	}
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
	open,
	onOpenChange,
}: {
	level: OrganizationLevel;
	peers: readonly OrganizationLevel[];
	occupied: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const canEdit = useCanEdit();
	const mutations = useBlueprintMutations();
	const properties = useLocationProperties();
	const nameId = useId();
	const parentId = useId();
	const descriptionId = useId();

	const levelRecord = Object.fromEntries(peers.map((p) => [p.uuid, p]));
	const above = ancestorLevels(level, levelRecord);
	// A level may sit under any level ABOVE it, so the offer is every level
	// that is not this one and not below it — the same predicate the store
	// enforces, so nothing offered here can be refused there.
	const parentOptions = peers.filter(
		(candidate) =>
			candidate.uuid !== level.uuid &&
			!ancestorLevels(candidate, levelRecord).some(
				(a) => a.uuid === level.uuid,
			),
	);

	return (
		<EntryRow
			summary={level.name}
			detail={summarize(level)}
			open={open}
			onOpenChange={onOpenChange}
		>
			<div className="flex flex-col gap-4">
				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={nameId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						Name
					</Label>
					<Input
						id={nameId}
						value={level.name}
						autoComplete="off"
						data-1p-ignore
						disabled={!canEdit}
						onChange={(e) =>
							mutations.updateOrganizationLevel(level.uuid as Uuid, {
								name: e.target.value,
							})
						}
					/>
					<p className="text-[12px] text-nova-text-muted">
						Saves as{" "}
						<code className="text-nova-text-secondary">{level.code}</code>. That
						code goes to CommCare and to every expression that names this level,
						so it stays fixed even when the name changes.
					</p>
				</div>

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
							mutations.updateOrganizationLevel(level.uuid as Uuid, {
								parentLevelUuid: value === TOP_LEVEL ? null : (value as Uuid),
							});
						}}
					>
						<SelectTrigger id={parentId} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={TOP_LEVEL}>
								Nothing — this is a top level
							</SelectItem>
							{parentOptions.map((candidate) => (
								<SelectItem key={candidate.uuid} value={candidate.uuid}>
									{candidate.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<CaseFlowGroup level={level} peers={above} />
				<AddressBookGroup level={level} above={above} peers={peers} />

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
							mutations.updateOrganizationLevel(level.uuid as Uuid, {
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

				{canEdit && <RemoveLevel level={level} occupied={occupied} />}
			</div>
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
}: {
	level: OrganizationLevel;
	peers: readonly OrganizationLevel[];
}) {
	const canEdit = useCanEdit();
	const mutations = useBlueprintMutations();
	const descendantId = useId();
	const flow = level.caseFlow;

	const set = (next: LevelCaseFlow) =>
		mutations.updateOrganizationLevel(level.uuid as Uuid, { caseFlow: next });

	return (
		<fieldset className="rounded-lg border border-nova-border p-3">
			<legend className="px-1 text-[12px] font-medium text-nova-text-secondary">
				Cases
			</legend>
			<div className="flex flex-col gap-2.5">
				<Choice
					label="People work here"
					checked={flow.workers === "assigned"}
					disabled={!canEdit}
					onChange={(checked) =>
						set(
							checked
								? {
										workers: "assigned",
										ownsCases: flow.ownsCases,
										descendantCases: { kind: "none" },
									}
								: { workers: "none", ownsCases: flow.ownsCases },
						)
					}
					hint="Personas and deployed workers can be assigned to places at this level."
				/>
				<Choice
					label="Places here own cases"
					checked={flow.ownsCases}
					disabled={!canEdit}
					onChange={(checked) =>
						set(
							flow.workers === "assigned"
								? { ...flow, ownsCases: checked }
								: { workers: "none", ownsCases: checked },
						)
					}
					hint={
						flow.workers === "none"
							? "Cases can be assigned here and reach nobody's device by assignment — a queue that stays searchable."
							: "Workers assigned here receive the cases their place owns."
					}
				/>
				{flow.workers === "assigned" && (
					<div className="flex flex-col gap-1.5 pl-6">
						<Label
							htmlFor={descendantId}
							className="text-[12px] font-medium text-nova-text-secondary"
						>
							Workers also receive cases from places below
						</Label>
						<Select
							value={scopeValue(flow.descendantCases)}
							disabled={!canEdit}
							onValueChange={(value) => {
								if (typeof value !== "string") return;
								set({ ...flow, descendantCases: scopeFromValue(value) });
							}}
						>
							<SelectTrigger id={descendantId} className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="none">No — only their own place</SelectItem>
								<SelectItem value="all">Yes — everything below</SelectItem>
								{peers.map((ancestor) => (
									<SelectItem
										key={ancestor.uuid}
										value={`down-to:${ancestor.uuid}`}
									>
										Down to {ancestor.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{flow.descendantCases.kind === "down-to" && (
							<p className="text-[12px] leading-relaxed text-nova-amber">
								Stopping at a level needs a setting enabled on the CommCare
								project you deploy to. Without it, workers receive everything
								below instead. Deployment lists it as a prerequisite.
							</p>
						)}
					</div>
				)}
			</div>
		</fieldset>
	);
}

function scopeValue(scope: DescendantCaseScope): string {
	return scope.kind === "down-to" ? `down-to:${scope.levelUuid}` : scope.kind;
}

function scopeFromValue(value: string): DescendantCaseScope {
	if (value === "all") return { kind: "all" };
	if (value.startsWith("down-to:")) {
		return {
			kind: "down-to",
			levelUuid: value.slice("down-to:".length) as Uuid,
		};
	}
	return { kind: "none" };
}

/**
 * Which places a worker at this level can see and name — the other axis.
 *
 * Four choices, not five dials. CommCare's five fixture flags have
 * combinations its own query calls undefined outcomes, so Nova admits the
 * four coherent configurations and makes the rest unexpressible.
 */
function AddressBookGroup({
	level,
	above,
	peers,
}: {
	level: OrganizationLevel;
	above: readonly OrganizationLevel[];
	peers: readonly OrganizationLevel[];
}) {
	const canEdit = useCanEdit();
	const mutations = useBlueprintMutations();
	const reachId = useId();
	const fromId = useId();
	const book = level.addressBook;
	const isDefault =
		book.reach === "own-branch" &&
		book.downToLevelUuid === undefined &&
		book.alsoIncludeTopDownToLevelUuid === undefined;
	const [expanded, setExpanded] = useState(!isDefault);

	const set = (next: LevelAddressBook) =>
		mutations.updateOrganizationLevel(level.uuid as Uuid, {
			addressBook: next,
		});

	if (!expanded) {
		return (
			<div className="flex items-center justify-between gap-3 rounded-lg border border-nova-border px-3 py-2.5">
				<p className="text-[12px] text-nova-text-secondary">
					Workers here can see their own part of the organization.
				</p>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-9 shrink-0 px-2.5 text-[12px] text-nova-violet-bright hover:bg-nova-violet/[0.12] hover:text-nova-violet-bright"
					onClick={() => setExpanded(true)}
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
				Seeing a place is separate from receiving its cases. Widening this lets
				expressions name more places without moving a single case.
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
								levelUuids: [peers[0]?.uuid ?? (level.uuid as Uuid)],
							});
						}
						if (above[0] !== undefined) {
							set({ reach: "shared-branch", fromLevelUuid: above[0].uuid });
						}
					}}
				>
					<SelectTrigger id={reachId} className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="own-branch">
							Their own place, everything under it, and the chain above
						</SelectItem>
						<SelectItem
							value="own-branch-limited"
							disabled={peers.length === 0}
						>
							Their own place, but only certain levels
						</SelectItem>
						<SelectItem value="shared-branch" disabled={above.length === 0}>
							Everything under a level further up
						</SelectItem>
						<SelectItem value="whole-organization">
							The whole organization
						</SelectItem>
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
								set({ ...book, fromLevelUuid: value as Uuid });
							}}
						>
							<SelectTrigger id={fromId} className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{above.map((ancestor) => (
									<SelectItem key={ancestor.uuid} value={ancestor.uuid}>
										{ancestor.name}
									</SelectItem>
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
	checked,
	disabled,
	onChange,
}: {
	label: string;
	hint: string;
	checked: boolean;
	disabled: boolean;
	onChange: (checked: boolean) => void;
}) {
	const id = useId();
	return (
		<div className="flex items-start gap-2.5">
			<Checkbox
				id={id}
				checked={checked}
				disabled={disabled}
				onCheckedChange={(next) => onChange(next === true)}
				className="mt-1"
			/>
			<div className="min-w-0">
				<Label htmlFor={id} className="text-[13px] text-nova-text">
					{label}
				</Label>
				<p className="text-[12px] leading-relaxed text-nova-text-muted">
					{hint}
				</p>
			</div>
		</div>
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
}: {
	level: OrganizationLevel;
	occupied: boolean;
}) {
	const mutations = useBlueprintMutations();
	const [confirming, setConfirming] = useState(false);
	const [refusal, setRefusal] = useState<string | undefined>(undefined);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirming);

	if (!confirming) {
		return (
			<div className="flex flex-col gap-1.5">
				<Button
					ref={triggerRef}
					type="button"
					variant="ghost"
					size="sm"
					className="h-9 self-start px-2.5 text-[12px] text-nova-red hover:bg-nova-red/[0.12] hover:text-nova-red"
					onClick={() => {
						setRefusal(undefined);
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
				Remove “{level.name}”?
				{occupied
					? " Places still stand at this level, so it can't be removed yet."
					: " Any place information that applied only to this level will apply everywhere instead."}
			</p>
			<div className="flex gap-2">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-9 px-2.5 text-[12px] text-nova-red hover:bg-nova-red/[0.12] hover:text-nova-red"
					onClick={() => {
						const result = mutations.removeOrganizationLevel(
							level.uuid as Uuid,
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
					size="sm"
					className="h-9 px-2.5 text-[12px]"
					onClick={() => setConfirming(false)}
				>
					Keep it
				</Button>
			</div>
		</div>
	);
}
