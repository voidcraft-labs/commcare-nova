"use client";

import { useState } from "react";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { Button } from "@/components/shadcn/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { useFormBehaviorTextChoices } from "@/lib/doc/hooks/useFormBehaviorTextChoices";
import {
	type BehaviorText,
	behaviorTextUnits,
	type FormBehaviorRole,
	formBehaviorRoleNames,
	formBehaviorRoles,
} from "@/lib/domain";
import { itextUnitTranslationId } from "@/lib/domain/translationUnits";
import type { FormSettingsSectionProps } from "./types";

const descriptions: Record<FormBehaviorRole, string> = {
	automaticSubmissionText:
		"Web Apps sends the form as soon as it opens, once its answers are valid.",
	skipAutomaticSyncText:
		"Web Apps would skip a sync after this form is sent. Nova apps don't sync after each form, so workers see no change.",
	validateChangedAnswersText:
		"Web Apps checks new answers and blanks. A previously accepted answer can stay accepted after another answer changes.",
	activityKeyText:
		"Workers see a notice when another worker recently opened or submitted this form with the same key. Use a question text that evaluates to a stable record value.",

	activityTitleText:
		"This text names the record in the notice. If you leave it out, the notice says “the same record”.",

	activityWindowText:
		"This text supplies the number of seconds a notice lasts. Web Apps uses five minutes if the value is missing or cannot be read as an integer.",
};

/** The form's behaviors, each held by one of its own question or choice
 *  texts (`Form.<role>`), chosen by identity from the texts it writes. */
export function FormBehaviorSection({ formUuid }: FormSettingsSectionProps) {
	const form = useForm(formUuid);
	const options = useFormBehaviorTextChoices(formUuid);
	const { inline } = useBlueprintMutations();
	const [refusal, setRefusal] = useState<string | null>(null);
	const [adding, setAdding] = useState<FormBehaviorRole | null>(null);
	if (!form) return null;
	const available = formBehaviorRoles.filter(
		(role) =>
			!form[role] &&
			((role !== "activityTitleText" && role !== "activityWindowText") ||
				form.activityKeyText !== undefined),
	);
	const change = (role: FormBehaviorRole, next: BehaviorText | null) => {
		const outcome = inline.updateForm(
			formUuid,
			role === "activityKeyText" && next === null
				? {
						activityKeyText: null,
						activityTitleText: null,
						activityWindowText: null,
					}
				: { [role]: next },
		);
		setRefusal(outcome.ok ? null : outcome.messages.join(" "));
		if (outcome.ok) setAdding(null);
	};
	return (
		<section className="space-y-3 border-t border-white/[0.06] pt-3">
			<h3 className="text-sm font-medium text-nova-text-secondary">
				Form behavior
			</h3>
			{formBehaviorRoles.map((role) => {
				const setting = form[role];
				if (!setting && adding !== role) return null;
				const taken = new Set(
					formBehaviorRoles
						.filter((other) => other !== role)
						.flatMap((other) =>
							form[other]
								? behaviorTextUnits(form[other]).map(itextUnitTranslationId)
								: [],
						),
				);
				const choices = options.filter((option) => !taken.has(option.key));
				const chosen = new Set(
					setting ? behaviorTextUnits(setting).map(itextUnitTranslationId) : [],
				);
				const current = setting && itextUnitTranslationId(setting.carrier);
				const remaining = choices.filter((option) => !chosen.has(option.key));
				return (
					<div key={role} className="space-y-2">
						<h4 className="text-sm text-nova-text-secondary">
							{formBehaviorRoleNames[role]}
						</h4>
						<p className="text-xs text-nova-text-muted">{descriptions[role]}</p>
						<Select
							value={current ?? ""}
							onValueChange={(key) => {
								const option = choices.find((item) => item.key === key);
								if (!option) return;
								const aliases = setting?.alsoUsedBy?.filter(
									(other) => itextUnitTranslationId(other) !== key,
								);
								change(role, {
									carrier: option.unit,
									...(aliases?.length && { alsoUsedBy: aliases }),
								});
							}}
						>
							<SelectTrigger
								aria-label={`Text for ${formBehaviorRoleNames[role].toLowerCase()}`}
							>
								<SelectValue>
									{options.find((option) => option.key === current)?.label ??
										current ??
										"Choose a text"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{choices.map((option) => (
									<SelectItem key={option.key} value={option.key}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{!choices.length && (
							<p className="text-xs text-nova-text-muted">
								A question or choice with its own text can hold this setting.
							</p>
						)}
						{setting && (
							<details>
								<summary className="cursor-pointer text-xs text-nova-text-secondary">
									Shared texts
								</summary>
								{setting.alsoUsedBy?.map((unit) => {
									const key = itextUnitTranslationId(unit);
									const aliases =
										setting.alsoUsedBy?.filter(
											(other) => itextUnitTranslationId(other) !== key,
										) ?? [];
									return (
										<div
											key={key}
											className="flex items-center justify-between gap-2"
										>
											<span>
												{options.find((option) => option.key === key)?.label ??
													key}
											</span>
											<Button
												type="button"
												variant="ghost"
												onClick={() =>
													change(role, {
														carrier: setting.carrier,
														...(aliases.length && { alsoUsedBy: aliases }),
													})
												}
											>
												Stop sharing
											</Button>
										</div>
									);
								})}
								{remaining.length > 0 && (
									<Select
										value=""
										onValueChange={(key) => {
											const option = remaining.find((item) => item.key === key);
											if (option)
												change(role, {
													...setting,
													alsoUsedBy: [
														...(setting.alsoUsedBy ?? []),
														option.unit,
													],
												});
										}}
									>
										<SelectTrigger aria-label="Share with another text">
											<SelectValue>Share with another text</SelectValue>
										</SelectTrigger>
										<SelectContent>
											{remaining.map((option) => (
												<SelectItem key={option.key} value={option.key}>
													{option.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							</details>
						)}
						<Button
							type="button"
							variant="ghost"
							onClick={() => (setting ? change(role, null) : setAdding(null))}
						>
							{setting ? "Remove setting" : "Cancel"}
						</Button>
					</div>
				);
			})}
			{!adding && available.length > 0 && (
				<Select
					value=""
					onValueChange={(value) =>
						setAdding(available.find((role) => role === value) ?? null)
					}
				>
					<SelectTrigger aria-label="Add a form behavior">
						<SelectValue>Add a form behavior</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{available.map((role) => (
							<SelectItem key={role} value={role}>
								{formBehaviorRoleNames[role]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
			<RejectionInline message={refusal} />
		</section>
	);
}
