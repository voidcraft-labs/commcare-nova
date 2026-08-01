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
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import { Switch } from "@/components/shadcn/switch";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useUserProperties } from "@/lib/doc/hooks/useUserCollections";
import { userPropertySlugVerdict } from "@/lib/doc/identifierVerdicts";
import type { RemoveUserPropertyPlan } from "@/lib/doc/userMutations";
import { BUILT_IN_USER_PROPERTIES, type UserProperty } from "@/lib/domain";
import { useCanEdit } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import { DraftCommitInput, DraftLinesField } from "./DraftCommitField";
import { EntryRow, Subsection, SubsectionEmpty } from "./subsection";

export function WorkerInformationSubsection() {
	const properties = useUserProperties();
	const canEdit = useCanEdit();
	const sessionApi = useBuilderSessionApi();
	const mutations = useBlueprintMutations();
	const [openUuid, setOpenUuid] = useState<string | undefined>(undefined);
	const [focusUuid, setFocusUuid] = useState<string | undefined>(undefined);
	const addButtonRef = useRef<HTMLButtonElement>(null);

	const add = () => {
		if (!sessionApi.getState().canEdit) return;
		const result = mutations.addUserProperty({
			slug: uniqueSlug(properties),
			label: "New information",
		});
		if (result.ok) {
			setOpenUuid(result.uuid);
			setFocusUuid(result.uuid);
		}
	};

	return (
		<Subsection
			id="app-setup-worker-information"
			title="Worker information"
			description="What each worker carries with them, a role, a region, anything your app's conditions need to read. You give it a name to save under, and CommCare stores a value per worker."
			addLabel="Add worker information"
			onAdd={add}
			canEdit={canEdit}
			addButtonRef={addButtonRef}
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
						focusOnMount={focusUuid === property.uuid}
						onFocused={() => setFocusUuid(undefined)}
						returnFocusRef={addButtonRef}
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
	focusOnMount,
	onFocused,
	returnFocusRef,
}: {
	property: UserProperty;
	peers: readonly UserProperty[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	focusOnMount: boolean;
	onFocused: () => void;
	returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
	const canEdit = useCanEdit();
	const sessionApi = useBuilderSessionApi();
	const mutations = useBlueprintMutations();
	const labelId = useId();
	const slugId = useId();
	const requiredId = useId();
	const choicesId = useId();
	const labelRef = useRef<HTMLInputElement>(null);
	const [removalPlan, setRemovalPlan] = useState<RemoveUserPropertyPlan | null>(
		null,
	);
	const [removalError, setRemovalError] = useState<string | undefined>();
	const confirmingRemove = removalPlan !== null;
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirmingRemove);

	useEffect(() => {
		if (!focusOnMount) return;
		labelRef.current?.focus();
		onFocused();
	}, [focusOnMount, onFocused]);

	/* The peers a name must be unique against exclude this entry itself,
	 * so re-committing an unchanged name is never a duplicate. */
	const otherSlugs = new Set(
		peers.filter((p) => p.uuid !== property.uuid).map((p) => p.slug),
	);
	const write = (patch: Parameters<typeof mutations.updateUserProperty>[1]) => {
		if (!sessionApi.getState().canEdit) {
			return {
				ok: false as const,
				messages: ["You no longer have edit access."],
			};
		}
		return mutations.inline.updateUserProperty(property.uuid, patch);
	};

	const validateSlug = (slug: string) => {
		const verdict = userPropertySlugVerdict(slug, otherSlugs);
		return verdict.ok ? undefined : verdict.userMessage;
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
					<DraftCommitInput
						inputRef={labelRef}
						id={labelId}
						value={property.label}
						disabled={!canEdit}
						validate={(value) =>
							value === "" ? "Enter a name people can see." : undefined
						}
						onCommit={(label) => write({ label })}
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
					<DraftCommitInput
						id={slugId}
						value={property.slug}
						disabled={!canEdit}
						validate={validateSlug}
						validateAsYouType
						onCommit={(slug) => write({ slug })}
						className="min-h-11 font-mono text-[13px]"
					/>
					<span className="text-[12px] text-nova-text-muted">
						Conditions read this as{" "}
						<span className="font-mono">{property.slug}</span>.
					</span>
				</div>

				<label
					htmlFor={requiredId}
					className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg border border-white/[0.04] bg-nova-deep/30 px-3 py-2.5 transition-colors hover:border-white/[0.08]"
				>
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="text-[13px] text-nova-text">Required</span>
						<span className="text-[12px] leading-relaxed text-nova-text-secondary">
							CommCare asks for a value whenever a worker account is created.
						</span>
					</span>
					<Switch
						id={requiredId}
						checked={property.required === true}
						disabled={!canEdit}
						onCheckedChange={(checked) =>
							write({ required: checked ? true : null })
						}
						className="shrink-0"
					/>
				</label>

				<div className="flex flex-col gap-1.5">
					<label
						htmlFor={choicesId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						Accepted values
					</label>
					<DraftLinesField
						id={choicesId}
						value={property.choices ?? []}
						disabled={!canEdit}
						onCommit={(choices) =>
							write({ choices: choices === null ? null : [...choices] })
						}
					/>
					<span className="text-[12px] text-nova-text-muted">
						CommCare rejects a worker whose value is not on this list.
					</span>
				</div>

				{canEdit &&
					(removalPlan !== null ? (
						<div
							ref={panelRef}
							tabIndex={-1}
							className="flex flex-col gap-2 rounded-lg border border-nova-rose/40 bg-nova-rose/[0.06] p-3 outline-none"
						>
							{removalPlan.ok ? (
								<p className="text-[13px] leading-relaxed text-nova-text">
									Remove {property.label}? Every value roles and personas
									recorded for it is removed with it.
								</p>
							) : (
								<div className="space-y-2">
									<p className="text-[13px] font-medium text-nova-text">
										Can’t remove {property.label} yet
									</p>
									<p className="text-[13px] leading-relaxed text-nova-text-secondary">
										{removalPlan.referenceCount} saved{" "}
										{removalPlan.referenceCount === 1
											? "setting uses"
											: "settings use"}{" "}
										this worker information:
									</p>
									<ul className="list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-nova-text-secondary">
										{removalPlan.references.map((reference) => (
											<li key={reference}>{reference}</li>
										))}
									</ul>
									<p className="text-[13px] leading-relaxed text-nova-text-secondary">
										Update or remove those references first.
									</p>
								</div>
							)}
							{removalError !== undefined ? (
								<p className="text-[13px] leading-relaxed text-nova-rose">
									{removalError}
								</p>
							) : null}
							<div className="flex items-center gap-2">
								{removalPlan.ok ? (
									<Button
										type="button"
										variant="destructive"
										className=""
										onClick={() => {
											if (!sessionApi.getState().canEdit) return;
											const outcome = mutations.inline.removeUserProperty(
												property.uuid,
											);
											if (!outcome.ok) {
												setRemovalPlan(
													mutations.inspectUserPropertyRemoval(property.uuid),
												);
												setRemovalError(outcome.messages.join(" "));
												return;
											}
											returnFocusRef.current?.focus();
										}}
									>
										Remove
									</Button>
								) : null}
								<Button
									type="button"
									variant="ghost"
									className=""
									onClick={() => {
										setRemovalPlan(null);
										setRemovalError(undefined);
									}}
								>
									{removalPlan.ok ? "Cancel" : "Close"}
								</Button>
							</div>
						</div>
					) : (
						<Button
							ref={triggerRef}
							type="button"
							variant="ghost"
							onClick={() => {
								setRemovalError(undefined);
								setRemovalPlan(
									mutations.inspectUserPropertyRemoval(property.uuid),
								);
							}}
							className="self-start px-2.5 text-[13px] text-nova-rose hover:bg-nova-rose/[0.1] hover:text-nova-rose"
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
				className="nova-focusable-inset flex min-h-11 w-full items-center px-3 py-2 text-left text-[13px] text-nova-text-secondary hover:text-nova-text"
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
										<SimpleTooltip content="CommCare itself reads this one, its value changes how the app behaves, not just what conditions see.">
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
