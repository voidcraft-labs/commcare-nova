/**
 * Place information — the custom fields every place can carry.
 *
 * One app-wide catalog, optionally narrowed to certain levels. It is the
 * same shape as the worker-information catalog on purpose: CommCare runs one
 * custom-data machinery for both and splits them only by field type, so a
 * second model here could only drift from that one.
 *
 * Values live on the places, keyed by each entry's UUID rather than its
 * name — so renaming one rewrites nothing, and removing one sheds its values
 * in the same transaction that removes the declaration.
 */
"use client";

import { useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Checkbox } from "@/components/shadcn/checkbox";
import { Input } from "@/components/shadcn/input";
import { Label } from "@/components/shadcn/label";
import {
	type UserEntityPatch,
	useBlueprintMutations,
} from "@/lib/doc/hooks/useBlueprintMutations";
import {
	useLocationProperties,
	useOrganizationLevels,
} from "@/lib/doc/hooks/useOrganizationCollections";
import { userPropertySlugVerdict } from "@/lib/doc/identifierVerdicts";
import type { Uuid } from "@/lib/doc/types";
import type { LocationProperty, OrganizationLevel } from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import { locationValueCatalogIssueForProperties } from "@/lib/organization/valueCatalog";
import { useCanEdit } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import { DraftLinesField } from "./DraftCommitField";
import { EntryRow, Subsection, SubsectionEmpty } from "./subsection";

export function PlaceInformationSubsection({
	locations,
}: {
	locations: readonly StoredLocation[];
}) {
	const properties = useLocationProperties();
	const levels = useOrganizationLevels();
	const canEdit = useCanEdit();
	const sessionApi = useBuilderSessionApi();
	const mutations = useBlueprintMutations();
	const [openUuid, setOpenUuid] = useState<string | undefined>(undefined);

	const add = () => {
		if (!sessionApi.getState().canEdit) return;
		const label = uniqueLabel(properties);
		const result = mutations.addLocationProperty({
			label,
			slug: uniqueSlug(label, properties),
		});
		if (result.ok) setOpenUuid(result.uuid);
	};

	return (
		<Subsection
			id="app-setup-place-information"
			title="Place information"
			description="Anything else a place carries — a phone number, a catchment population, an opening date. Expressions can read these, and they travel to CommCare with the place."
			addLabel="Add information"
			onAdd={add}
			canEdit={canEdit && levels.length > 0}
		>
			{levels.length === 0 ? (
				<SubsectionEmpty>
					Add a level first. Place information describes places, and there are
					no places to describe yet.
				</SubsectionEmpty>
			) : properties.length === 0 ? (
				<SubsectionEmpty>
					Nothing yet. A place already carries its name and its code — add
					information here only when workers or expressions need more.
				</SubsectionEmpty>
			) : (
				properties.map((property) => (
					<PropertyRow
						key={property.uuid}
						property={property}
						peers={properties}
						levels={levels}
						locations={locations}
						open={openUuid === property.uuid}
						onOpenChange={(next) =>
							setOpenUuid(next ? property.uuid : undefined)
						}
					/>
				))
			)}
		</Subsection>
	);
}

function uniqueLabel(peers: readonly LocationProperty[]): string {
	const taken = new Set(peers.map((p) => p.label.trim().toLowerCase()));
	if (!taken.has("new information")) return "New information";
	for (let n = 2; ; n++) {
		const candidate = `New information ${n}`;
		if (!taken.has(candidate.toLowerCase())) return candidate;
	}
}

function uniqueSlug(label: string, peers: readonly LocationProperty[]): string {
	const taken = new Set(peers.map((p) => p.slug));
	const base =
		label
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "") || "info";
	// CommCare refuses a `commcare`- or `xml`-prefixed name outright, so a
	// derived one that would collide gets the same treatment as a taken one.
	const safe = userPropertySlugVerdict(base, new Set()).ok ? base : `f_${base}`;
	if (!taken.has(safe)) return safe;
	for (let n = 2; ; n++) {
		const candidate = `${safe}_${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

function PropertyRow({
	property,
	peers,
	levels,
	locations,
	open,
	onOpenChange,
}: {
	property: LocationProperty;
	peers: readonly LocationProperty[];
	levels: readonly OrganizationLevel[];
	locations: readonly StoredLocation[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const canEdit = useCanEdit();
	const mutations = useBlueprintMutations();
	const labelId = useId();
	const slugId = useId();
	const requiredId = useId();
	const choicesId = useId();
	const [draftSlug, setDraftSlug] = useState(property.slug);
	const [message, setMessage] = useState<string | undefined>(undefined);

	const claimed = new Set(
		peers.filter((p) => p.uuid !== property.uuid).map((p) => p.slug),
	);
	const verdict = userPropertySlugVerdict(draftSlug, claimed);
	const appliesEverywhere = property.levelUuids === undefined;
	const commit = (patch: UserEntityPatch<LocationProperty>) => {
		const candidate = { ...property } as LocationProperty;
		for (const [key, value] of Object.entries(patch)) {
			if (value === null) delete candidate[key as keyof LocationProperty];
			else Object.assign(candidate, { [key]: value });
		}
		const candidateProperties = peers.map((peer) =>
			peer.uuid === property.uuid ? candidate : peer,
		);
		for (const location of locations) {
			const issue = locationValueCatalogIssueForProperties(
				candidateProperties,
				location.levelUuid,
				location.values,
			);
			if (issue !== undefined) {
				const refusal = `“${location.name}” blocks this change. ${issue}`;
				setMessage(refusal);
				return { ok: false as const, messages: [refusal] };
			}
		}
		const outcome = mutations.updateLocationProperty(
			property.uuid as Uuid,
			patch,
		);
		setMessage(outcome.ok ? undefined : outcome.messages[0]);
		return outcome;
	};

	return (
		<EntryRow
			summary={property.label}
			detail={
				appliesEverywhere
					? "Every level"
					: `${property.levelUuids?.length ?? 0} ${
							(property.levelUuids?.length ?? 0) === 1 ? "level" : "levels"
						}`
			}
			open={open}
			onOpenChange={onOpenChange}
		>
			<div className="flex flex-col gap-4">
				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={labelId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						Name
					</Label>
					<Input
						id={labelId}
						value={property.label}
						autoComplete="off"
						data-1p-ignore
						disabled={!canEdit}
						onChange={(e) =>
							mutations.updateLocationProperty(property.uuid as Uuid, {
								label: e.target.value,
							})
						}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={slugId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						Saves as
					</Label>
					<Input
						id={slugId}
						value={draftSlug}
						autoComplete="off"
						data-1p-ignore
						aria-invalid={!verdict.ok}
						disabled={!canEdit}
						onChange={(e) => setDraftSlug(e.target.value)}
						onBlur={() => {
							// Committed on blur, and only when legal — a name CommCare
							// refuses would bounce off the commit gate mid-keystroke and
							// snap the field back under the person's cursor.
							if (!verdict.ok || draftSlug === property.slug) {
								setDraftSlug(property.slug);
								return;
							}
							mutations.updateLocationProperty(property.uuid as Uuid, {
								slug: draftSlug,
							});
						}}
					/>
					{verdict.ok ? (
						<p className="text-[12px] leading-relaxed text-nova-text-muted">
							The name CommCare stores this under, and the name expressions
							read.
						</p>
					) : (
						<p
							role="alert"
							className="text-[12px] leading-relaxed text-nova-red"
						>
							{verdict.userMessage}
						</p>
					)}
				</div>

				<div className="flex items-center gap-2.5">
					<Checkbox
						id={requiredId}
						checked={property.required === true}
						disabled={!canEdit}
						onCheckedChange={(next) =>
							commit({ required: next === true ? true : null })
						}
					/>
					<Label htmlFor={requiredId} className="text-[13px] text-nova-text">
						A value is required before a place can be saved
					</Label>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={choicesId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						Accepted values
					</Label>
					<DraftLinesField
						id={choicesId}
						value={property.choices ?? []}
						disabled={!canEdit}
						onCommit={(choices) =>
							commit({ choices: choices === null ? null : [...choices] })
						}
					/>
					<p className="text-[12px] leading-relaxed text-nova-text-muted">
						Leave empty for free text. A closed list becomes a choice when you
						edit a place.
					</p>
				</div>

				<fieldset className="rounded-lg border border-nova-border p-3">
					<legend className="px-1 text-[12px] font-medium text-nova-text-secondary">
						Applies to
					</legend>
					<div className="flex flex-col gap-2.5">
						<LevelToggle
							label="Every level"
							checked={appliesEverywhere}
							disabled={!canEdit}
							onChange={() =>
								commit({
									levelUuids: null,
								})
							}
						/>
						{levels.map((level) => (
							<LevelToggle
								key={level.uuid}
								label={level.name}
								checked={
									!appliesEverywhere &&
									(property.levelUuids?.some((u) => u === level.uuid) ?? false)
								}
								disabled={!canEdit}
								onChange={(checked) => {
									const current = appliesEverywhere
										? levels.map((l) => l.uuid)
										: (property.levelUuids ?? []);
									const next = checked
										? [...new Set([...current, level.uuid])]
										: current.filter((u) => u !== level.uuid);
									commit({
										// Every level selected, or none, both mean "everywhere" —
										// an empty list would be a second spelling of the same
										// state that no reader distinguishes.
										levelUuids:
											next.length === 0 || next.length === levels.length
												? null
												: next,
									});
								}}
							/>
						))}
					</div>
				</fieldset>

				{message !== undefined && (
					<p role="alert" className="text-[12px] leading-relaxed text-nova-red">
						{message}
					</p>
				)}

				{canEdit && <RemoveProperty property={property} />}
			</div>
		</EntryRow>
	);
}

function LevelToggle({
	label,
	checked,
	disabled,
	onChange,
}: {
	label: string;
	checked: boolean;
	disabled: boolean;
	onChange: (checked: boolean) => void;
}) {
	const id = useId();
	return (
		<div className="flex items-center gap-2.5">
			<Checkbox
				id={id}
				checked={checked}
				disabled={disabled}
				onCheckedChange={(next) => onChange(next === true)}
			/>
			<Label htmlFor={id} className="text-[13px] text-nova-text">
				{label}
			</Label>
		</div>
	);
}

function RemoveProperty({ property }: { property: LocationProperty }) {
	const mutations = useBlueprintMutations();
	const [confirming, setConfirming] = useState(false);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirming);

	if (!confirming) {
		return (
			<Button
				ref={triggerRef}
				type="button"
				variant="ghost"
				className="h-9 self-start px-2.5 text-[12px] text-nova-red hover:bg-nova-red/[0.12] hover:text-nova-red"
				onClick={() => setConfirming(true)}
			>
				Remove information
			</Button>
		);
	}

	return (
		<div
			ref={panelRef}
			tabIndex={-1}
			className="flex flex-col gap-2.5 rounded-lg border border-nova-red/40 bg-nova-red/[0.06] p-3 outline-none"
		>
			<p className="text-[13px] leading-relaxed text-nova-text">
				Remove “{property.label}”? Anything recorded against it on a place is
				removed with it — that cannot be undone.
			</p>
			<div className="flex gap-2">
				<Button
					type="button"
					variant="ghost"
					className="h-9 px-2.5 text-[12px] text-nova-red hover:bg-nova-red/[0.12] hover:text-nova-red"
					onClick={() => {
						setConfirming(false);
						mutations.removeLocationProperty(property.uuid as Uuid);
					}}
				>
					Remove
				</Button>
				<Button
					type="button"
					variant="ghost"
					className="h-9 px-2.5 text-[12px]"
					onClick={() => setConfirming(false)}
				>
					Keep it
				</Button>
			</div>
		</div>
	);
}
