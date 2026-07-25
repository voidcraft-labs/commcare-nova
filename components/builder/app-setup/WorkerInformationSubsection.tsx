/**
 * Worker information — the app's half of CommCare's custom user-data
 * schema. Each entry is a slot every worker carries a value in, and the
 * name it saves under is what expressions read.
 *
 * The save-as name is guarded inline by the same verdict the commit gate
 * uses (`userPropertySlugVerdict`), so an illegal name is unreachable
 * rather than rejected after the fact. CommCare's own built-in properties
 * are listed beside the authored ones as read-only reference, each saying
 * plainly whether Preview can show its value.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerBolt from "@iconify-icons/tabler/bolt";
import { useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import { Input } from "@/components/shadcn/input";
import { Switch } from "@/components/shadcn/switch";
import { Textarea } from "@/components/shadcn/textarea";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useUserProperties } from "@/lib/doc/hooks/useUserCollections";
import { userPropertySlugVerdict } from "@/lib/doc/identifierVerdicts";
import type { Uuid } from "@/lib/doc/types";
import { BUILT_IN_USER_PROPERTIES, type UserProperty } from "@/lib/domain";
import { useCanEdit } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { EntryRow, Subsection, SubsectionEmpty } from "./subsection";

export function WorkerInformationSubsection() {
	const properties = useUserProperties();
	const canEdit = useCanEdit();
	const sessionApi = useBuilderSessionApi();
	const mutations = useBlueprintMutations();
	const [openUuid, setOpenUuid] = useState<string | undefined>(undefined);

	const add = () => {
		if (!sessionApi.getState().canEdit) return;
		const result = mutations.addUserProperty({
			slug: uniqueSlug(properties),
			label: "New information",
		});
		if (result.ok) setOpenUuid(result.uuid);
	};

	return (
		<Subsection
			id="app-setup-worker-information"
			title="Worker information"
			description="What each worker carries with them — a role, a region, anything your app's conditions need to read. You give it a name to save under, and CommCare stores a value per worker."
			addLabel="Add worker information"
			onAdd={add}
			canEdit={canEdit}
		>
			{properties.length === 0 ? (
				<SubsectionEmpty>
					No worker information yet. Add some when your app needs to know
					something about the person using it.
				</SubsectionEmpty>
			) : (
				properties.map((property) => (
					<PropertyRow
						key={property.uuid}
						property={property}
						peers={properties}
						open={openUuid === property.uuid}
						onOpenChange={(next) =>
							setOpenUuid(next ? property.uuid : undefined)
						}
					/>
				))
			)}
			<BuiltInReference />
		</Subsection>
	);
}

/** A save-as name that no existing entry already claims. */
function uniqueSlug(peers: readonly UserProperty[]): string {
	const taken = new Set(peers.map((p) => p.slug.toLowerCase()));
	if (!taken.has("new_information")) return "new_information";
	for (let n = 2; ; n++) {
		const candidate = `new_information_${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

function PropertyRow({
	property,
	peers,
	open,
	onOpenChange,
}: {
	property: UserProperty;
	peers: readonly UserProperty[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const canEdit = useCanEdit();
	const sessionApi = useBuilderSessionApi();
	const mutations = useBlueprintMutations();
	const labelId = useId();
	const slugId = useId();
	const requiredId = useId();
	const choicesId = useId();
	const [slugDraft, setSlugDraft] = useState(property.slug);
	const [confirmingRemove, setConfirmingRemove] = useState(false);

	/* The peers a name must be unique against exclude this entry itself,
	 * so re-committing an unchanged name is never a duplicate. */
	const otherSlugs = new Set(
		peers.filter((p) => p.uuid !== property.uuid).map((p) => p.slug),
	);
	const verdict = userPropertySlugVerdict(slugDraft, otherSlugs);

	const write = (patch: Parameters<typeof mutations.updateUserProperty>[1]) => {
		if (!sessionApi.getState().canEdit) return;
		mutations.updateUserProperty(property.uuid as Uuid, patch);
	};

	const commitSlug = () => {
		if (!verdict.ok) return;
		if (slugDraft === property.slug) return;
		write({ slug: slugDraft });
	};

	return (
		<EntryRow
			open={open}
			onOpenChange={onOpenChange}
			summary={
				<>
					<span className="text-[13px] font-medium text-nova-text">
						{property.label}
					</span>
					<span className="ml-2 font-mono text-[12px] text-nova-text-muted">
						{property.slug}
					</span>
				</>
			}
			detail={property.required === true ? "Required" : undefined}
		>
			<div className="flex flex-col gap-4">
				<div className="flex flex-col gap-1.5">
					<label
						htmlFor={labelId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						Name people see
					</label>
					<Input
						id={labelId}
						value={property.label}
						disabled={!canEdit}
						autoComplete="off"
						data-1p-ignore
						onChange={(e) => write({ label: e.target.value })}
						className="min-h-11"
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<label
						htmlFor={slugId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						Name it saves under
					</label>
					<Input
						id={slugId}
						value={slugDraft}
						disabled={!canEdit}
						autoComplete="off"
						data-1p-ignore
						spellCheck={false}
						aria-invalid={verdict.ok ? undefined : true}
						aria-describedby={
							verdict.ok ? undefined : `${property.uuid}-slug-problem`
						}
						onChange={(e) => setSlugDraft(e.target.value)}
						onBlur={commitSlug}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								commitSlug();
							}
							if (e.key === "Escape") setSlugDraft(property.slug);
						}}
						className="min-h-11 font-mono text-[13px]"
					/>
					{verdict.ok ? (
						<span className="text-[12px] text-nova-text-muted">
							Conditions read this as{" "}
							<span className="font-mono">{property.slug}</span>.
						</span>
					) : (
						<span
							id={`${property.uuid}-slug-problem`}
							className="text-[12px] text-nova-rose"
						>
							{verdict.userMessage}
						</span>
					)}
				</div>

				<div className="flex items-start gap-3">
					<Switch
						id={requiredId}
						checked={property.required === true}
						disabled={!canEdit}
						onCheckedChange={(checked) =>
							write({ required: checked ? true : null })
						}
						className="mt-0.5 shrink-0"
					/>
					<span className="flex flex-col gap-0.5">
						<label htmlFor={requiredId} className="text-[13px] text-nova-text">
							Required
						</label>
						<span className="text-[12px] leading-relaxed text-nova-text-secondary">
							CommCare asks for a value whenever a worker account is created.
						</span>
					</span>
				</div>

				<div className="flex flex-col gap-1.5">
					<label
						htmlFor={choicesId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						Accepted values
					</label>
					<Textarea
						id={choicesId}
						value={(property.choices ?? []).join("\n")}
						disabled={!canEdit}
						autoComplete="off"
						data-1p-ignore
						rows={3}
						placeholder="One per line. Leave empty to accept any text."
						onChange={(e) => {
							const lines = e.target.value
								.split("\n")
								.map((line) => line.trim())
								.filter(Boolean);
							write({ choices: lines.length > 0 ? lines : null });
						}}
						className="text-[13px]"
					/>
					<span className="text-[12px] text-nova-text-muted">
						CommCare rejects a worker whose value is not on this list.
					</span>
				</div>

				{canEdit &&
					(confirmingRemove ? (
						<div className="flex flex-col gap-2 rounded-lg border border-nova-rose/40 bg-nova-rose/[0.06] p-3">
							<p className="text-[13px] leading-relaxed text-nova-text">
								Remove {property.label}? Every value roles and personas recorded
								for it is removed with it.
							</p>
							<div className="flex items-center gap-2">
								<Button
									type="button"
									variant="destructive"
									size="lg"
									className="h-11"
									onClick={() => {
										if (!sessionApi.getState().canEdit) return;
										mutations.removeUserProperty(property.uuid as Uuid);
									}}
								>
									Remove
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="lg"
									className="h-11"
									onClick={() => setConfirmingRemove(false)}
								>
									Cancel
								</Button>
							</div>
						</div>
					) : (
						<Button
							type="button"
							variant="ghost"
							size="lg"
							onClick={() => setConfirmingRemove(true)}
							className="h-11 self-start px-2.5 text-[13px] text-nova-rose hover:bg-nova-rose/[0.1] hover:text-nova-rose"
						>
							Remove worker information
						</Button>
					))}
			</div>
		</EntryRow>
	);
}

/**
 * CommCare's own built-in properties. Read-only, because CommCare sets
 * them; listed because an author writing a condition needs to know they
 * exist, what they hold, and — for the ones Nova cannot know yet — that
 * Preview will read them as empty.
 */
function BuiltInReference() {
	const [open, setOpen] = useState(false);
	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className="mt-1 rounded-lg border border-nova-border/60"
		>
			<CollapsibleTrigger
				className="flex min-h-11 w-full items-center px-3 py-2 text-left text-[13px] text-nova-text-secondary hover:text-nova-text focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-nova-violet-bright"
				render={<button type="button" />}
			>
				{open ? "Hide" : "Show"} what CommCare provides on its own
			</CollapsibleTrigger>
			<CollapsibleContent className="border-t border-nova-border/60 px-3 py-3">
				<ul className="flex flex-col gap-3">
					{BUILT_IN_USER_PROPERTIES.map((property) => {
						const availableInPreview =
							property.availability === "derived" ||
							property.availability === "constant";
						return (
							<li key={property.slug} className="flex flex-col gap-1">
								<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
									<span className="text-[13px] text-nova-text">
										{property.label}
									</span>
									<span className="font-mono text-[12px] text-nova-text-muted [overflow-wrap:anywhere]">
										{property.slug}
									</span>
									{property.readByRuntime && (
										<SimpleTooltip content="CommCare itself reads this one — its value changes how the app behaves, not just what conditions see.">
											<span className="inline-flex items-center gap-1 rounded-full bg-nova-violet/[0.15] px-2 py-0.5 text-[11px] text-nova-violet-bright">
												<Icon
													icon={tablerBolt}
													width="12"
													height="12"
													aria-hidden="true"
												/>
												Changes behavior
											</span>
										</SimpleTooltip>
									)}
									{!availableInPreview && (
										<span className="rounded-full border border-nova-border px-2 py-0.5 text-[11px] text-nova-text-muted">
											Empty in Preview
										</span>
									)}
								</div>
								<p className="text-[12px] leading-relaxed text-nova-text-secondary">
									{property.description}
								</p>
							</li>
						);
					})}
				</ul>
			</CollapsibleContent>
		</Collapsible>
	);
}
