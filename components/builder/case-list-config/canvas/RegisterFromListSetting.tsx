"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import { useCallback, useId, useState } from "react";
import { InlineField } from "@/components/builder/detail/formSettings/InlineField";
import { SegmentedRow } from "@/components/builder/inspector/inspectorChrome";
import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { PlatformNoteRow } from "@/components/builder/shared/PlatformNoteRow";
import { Button } from "@/components/shadcn/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { alwaysOfferedRegistrationChoices } from "@/lib/doc/alwaysOfferedRegistration";
import { useOfferedBatchRefusals } from "@/lib/doc/hooks/useOfferedBatchRefusals";
import {
	useRegisterFromList,
	useSetAlwaysOfferedRegistration,
} from "@/lib/doc/hooks/useRegisterFromList";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import type {
	AlwaysOfferedRegistration,
	CaseListRegistrationReturn,
	Uuid,
} from "@/lib/domain";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import {
	afterEmptySearchNotice,
	afterRegisteringHelpers,
	REGISTER_FROM_LIST_COPY as COPY,
	ownAfterSubmitNote,
	registerChoiceLabel,
	registerFromListEmptyState,
	slotWith,
} from "./registerFromListModel";

/** The picker's value for "Don't offer one". */
const NONE = "none";

/**
 * Register from this list: a registration form of another menu the case
 * list always offers (`Module.caseListRegistrationForm`, the `always` arm),
 * its button text, icon and spoken label, and where the worker goes after
 * registering. Every change commits the whole slot through
 * `alwaysOfferedRegistrationMutations` on the `inline` flavor, and a refusal
 * shows beside the setting.
 *
 * Each form the picker lists is disabled with the gate's sentence where the
 * gate refuses offering it; a host the gate refuses altogether shows the
 * section disabled with that sentence, never hidden. While the host offers
 * its own form after an empty search the section says so and links to the
 * Search canvas.
 */
export function RegisterFromListSetting({
	moduleUuid,
}: {
	readonly moduleUuid: Uuid;
}) {
	const canEdit = useCanEdit();
	const navigate = useNavigate();
	const setSlot = useSetAlwaysOfferedRegistration(moduleUuid);
	const facts = useRegisterFromList(moduleUuid);
	const headingId = useId();
	const pickerId = useId();
	const [refusal, setRefusal] = useState<string | undefined>(undefined);

	const plan = useCallback(
		(doc: BlueprintDoc) => {
			const batches: Record<string, readonly Mutation[]> = {};
			for (const choice of alwaysOfferedRegistrationChoices(doc, moduleUuid))
				batches[choice.formUuid] = choice.mutations;
			return batches;
		},
		[moduleUuid],
	);
	const gate = useOfferedBatchRefusals<string>(
		plan,
		canEdit && facts.afterEmptySearchFormName === undefined,
	);

	if (facts.caseType === undefined) return null;
	const { stored, choices } = facts;
	const commit = (slot: AlwaysOfferedRegistration | null): void => {
		const outcome = setSlot(slot);
		setRefusal(outcome.ok ? undefined : outcome.messages[0]);
	};
	const change = (
		update: Partial<Omit<AlwaysOfferedRegistration, "kind" | "formUuid">>,
	): void => {
		if (stored === undefined) return;
		commit(slotWith(stored, stored.formUuid, update));
	};

	/* Every way of offering a form is refused, and nothing is offered now:
	 * the host itself can't offer one, which the first sentence says. */
	const hostRefusal =
		stored === undefined &&
		choices.length > 0 &&
		choices.every((choice) => gate[choice.formUuid] !== undefined)
			? gate[choices[0].formUuid]
			: undefined;
	const helpers = afterRegisteringHelpers(facts);
	const note = ownAfterSubmitNote(facts.ownAfterSubmit);
	const afterSubmit: CaseListRegistrationReturn =
		stored?.afterSubmit ?? "case-list";

	return (
		<section
			aria-labelledby={headingId}
			data-register-from-list-setting
			data-register-from-list={stored === undefined ? "none" : stored.formUuid}
		>
			<div className="mb-4">
				<h2
					id={headingId}
					className="font-display tracking-tighter text-[17px] font-semibold text-nova-text"
				>
					{COPY.heading}
				</h2>
				<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
					{COPY.lede}
				</p>
			</div>

			{refusal !== undefined && (
				<div
					role="alert"
					className="mb-3 flex max-w-xl gap-2 rounded-xl border border-nova-rose/25 bg-nova-rose/[0.06] px-3 py-2.5 text-[13px] leading-relaxed text-nova-text-secondary"
				>
					<Icon
						icon={tablerAlertCircle}
						width="16"
						height="16"
						className="mt-0.5 shrink-0 text-nova-rose"
					/>
					<span>{refusal}</span>
				</div>
			)}

			<div className="max-w-xl space-y-4 rounded-2xl border border-white/[0.08] bg-nova-surface/20 p-4">
				{facts.afterEmptySearchFormName !== undefined ? (
					<div className="space-y-3">
						<p className="text-[13px] leading-relaxed text-nova-text-secondary">
							{afterEmptySearchNotice(facts.afterEmptySearchFormName)}
						</p>
						<Button
							type="button"
							variant="ghost-action"
							onClick={() => navigate.openSearchConfig(moduleUuid)}
						>
							Open Search
							<Icon icon={tablerArrowRight} width="16" height="16" />
						</Button>
					</div>
				) : choices.length === 0 && stored === undefined ? (
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						{registerFromListEmptyState(facts.caseType)}
					</p>
				) : (
					<>
						<div>
							<label
								htmlFor={pickerId}
								className="mb-1 block text-xs text-nova-text-muted"
							>
								{COPY.pickerLabel}
							</label>
							<Select
								value={stored?.formUuid ?? NONE}
								disabled={!canEdit || hostRefusal !== undefined}
								onValueChange={(next) => {
									if (typeof next !== "string") return;
									if (next === NONE) {
										commit(null);
										return;
									}
									commit(slotWith(stored, next as Uuid, {}));
								}}
							>
								<SelectTrigger id={pickerId} wrapValue>
									<SelectValue>
										{stored === undefined
											? COPY.pickerNone
											: registerChoiceLabel(
													facts.storedFormName ?? "",
													choices.find(
														(choice) => choice.formUuid === stored.formUuid,
													)?.moduleName ?? "",
												)}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={NONE}>{COPY.pickerNone}</SelectItem>
									{choices.map((choice) => {
										const reason =
											choice.formUuid === stored?.formUuid
												? undefined
												: gate[choice.formUuid];
										return (
											<SelectItem
												wrap
												key={choice.formUuid}
												value={choice.formUuid}
												disabled={reason !== undefined}
											>
												<span className="flex min-w-0 flex-col gap-0.5">
													<span>
														{registerChoiceLabel(
															choice.formName,
															choice.moduleName,
														)}
													</span>
													{reason !== undefined && (
														<span className="whitespace-normal text-[11px] leading-snug text-nova-text-muted">
															{reason}
														</span>
													)}
												</span>
											</SelectItem>
										);
									})}
								</SelectContent>
							</Select>
							{hostRefusal !== undefined && (
								<p className="mt-2 text-[13px] leading-relaxed text-nova-text-muted">
									{hostRefusal}
								</p>
							)}
						</div>

						{stored !== undefined && (
							<>
								{canEdit ? (
									<InlineField
										label={COPY.buttonTextLabel}
										value={stored.label ?? ""}
										placeholder={facts.storedFormName ?? ""}
										onChange={(value) =>
											setSlot(
												slotWith(stored, stored.formUuid, {
													label: value.trim() === "" ? undefined : value,
												}),
											)
										}
									/>
								) : (
									<p className="text-[13px] text-nova-text-secondary">
										{COPY.buttonTextLabel}:{" "}
										{stored.label ?? facts.storedFormName}
									</p>
								)}
								<div className="flex flex-wrap gap-6">
									<div>
										<span className="mb-1 block text-xs text-nova-text-muted">
											{COPY.iconLabel}
										</span>
										<SingleAssetSlot
											value={stored.icon}
											kind="image"
											iconLibrary="form"
											slotKey={`register:${moduleUuid}:icon`}
											ariaLabel="Register button icon"
											onChange={(icon) => change({ icon })}
										/>
									</div>
									<div>
										<span className="mb-1 block text-xs text-nova-text-muted">
											{COPY.audioLabel}
										</span>
										<SingleAssetSlot
											value={stored.audioLabel}
											kind="audio"
											slotKey={`register:${moduleUuid}:audioLabel`}
											ariaLabel="Register button spoken label"
											onChange={(audioLabel) => change({ audioLabel })}
										/>
									</div>
								</div>
								{(stored.icon !== undefined ||
									stored.audioLabel !== undefined) && (
									<PlatformNoteRow
										features={["case-list-registration-media"]}
									/>
								)}
								<div data-register-after-submit={afterSubmit}>
									<span className="mb-1 block text-xs text-nova-text-muted">
										{COPY.choiceGroupLabel}
									</span>
									{canEdit ? (
										<SegmentedRow<CaseListRegistrationReturn>
											legend={COPY.choiceGroupLabel}
											options={[
												{ value: "case-list", label: COPY.choiceCaseList },
												{ value: "new-case", label: COPY.choiceNewCase },
											]}
											value={afterSubmit}
											onChange={(next) => {
												if (next !== afterSubmit) change({ afterSubmit: next });
											}}
										/>
									) : (
										<p className="text-[13px] text-nova-text-secondary">
											{afterSubmit === "case-list"
												? COPY.choiceCaseList
												: COPY.choiceNewCase}
										</p>
									)}
									<p className="mt-2 text-[13px] leading-relaxed text-nova-text-muted">
										{helpers[afterSubmit]}
									</p>
									{note !== undefined && facts.ownAfterSubmit !== undefined && (
										<div
											className="mt-3 space-y-2"
											data-register-own-after-submit
										>
											<p className="text-[13px] leading-relaxed text-nova-text-secondary">
												{note.text}
											</p>
											<Button
												type="button"
												variant="ghost-action"
												onClick={() => {
													const own = facts.ownAfterSubmit;
													if (own !== undefined)
														navigate.openFormLinks(
															own.formModuleUuid,
															own.formUuid,
														);
												}}
											>
												{note.buttonLabel}
												<Icon icon={tablerArrowRight} width="16" height="16" />
											</Button>
										</div>
									)}
								</div>
							</>
						)}
					</>
				)}
			</div>
		</section>
	);
}
