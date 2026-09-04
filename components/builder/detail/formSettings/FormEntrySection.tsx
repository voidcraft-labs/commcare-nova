// components/builder/detail/formSettings/FormEntrySection.tsx
//
// How a registration form is reached: from the module menu, or from
// Results after a search finds nothing (the module's no-matches form,
// `Form.entry`). On a no-matches form this row also says what the missing
// After submit and display-condition rows would have said, because both
// are decided by the entry: the form returns to the search, and it is
// never on a menu. The action's label and the carried answers are edited
// here, next to the form they belong to.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import { useState } from "react";
import {
	NoMatchesFormReviewDialog,
	useNoMatchesFormEntry,
} from "@/components/builder/case-list-config/noMatchesFormReview";
import { Button } from "@/components/shadcn/button";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import { useOrderedForms } from "@/lib/doc/hooks/useModuleIds";
import { carrySearchAnswersMutations } from "@/lib/doc/searchNoMatchesForm";
import {
	effectiveCaseSearchConfig,
	isNoMatchesForm,
	menuFormUuidsOf,
} from "@/lib/domain";
import { useCanEdit } from "@/lib/session/hooks";
import { InlineField } from "./InlineField";
import type { FormSettingsSectionProps } from "./types";

export function FormEntrySection({
	moduleUuid,
	formUuid,
}: FormSettingsSectionProps) {
	const canEdit = useCanEdit();
	const form = useForm(formUuid);
	const mod = useModule(moduleUuid);
	const forms = useOrderedForms(moduleUuid);
	const docApi = useBlueprintDocApi();
	const { inline } = useBlueprintMutations();
	const entry = useNoMatchesFormEntry(moduleUuid);
	const [carried, setCarried] = useState("");
	const [carryRefusal, setCarryRefusal] = useState<string | undefined>(
		undefined,
	);

	if (form === undefined || mod === undefined || form.type !== "registration")
		return null;
	const noMatches = isNoMatchesForm(form);
	const searchAction =
		mod.caseType !== undefined &&
		effectiveCaseSearchConfig({
			caseListConfig: mod.caseListConfig,
			caseSearchConfig: mod.caseSearchConfig,
		}) !== undefined;
	// A menu registration form with nothing to offer it from stays silent:
	// the row exists to explain an entry or to offer one.
	if (!noMatches && !searchAction) return null;
	const other = forms.find(
		(candidate) => candidate.uuid !== formUuid && isNoMatchesForm(candidate),
	);
	const hostKeepsMenuForms =
		menuFormUuidsOf(docApi.getState(), moduleUuid).length > 0;

	const setLabel = (value: string) =>
		inline.updateForm(formUuid, {
			entry: {
				kind: "search-no-matches",
				...(value.trim().length > 0 ? { label: value.trim() } : {}),
			},
		});
	const carryAnswers = () => {
		setCarryRefusal(undefined);
		const mutations = carrySearchAnswersMutations(
			docApi.getState(),
			moduleUuid,
			formUuid,
		);
		const added = mutations.filter((mutation) => mutation.kind === "addField");
		if (added.length === 0) {
			setCarried("Every search field already has a field here.");
			return;
		}
		const outcome = inline.commitMany(mutations);
		if (outcome.ok) {
			setCarried(
				`${added.length} ${added.length === 1 ? "field" : "fields"} added, filled in from the search.`,
			);
		} else {
			setCarryRefusal(outcome.messages.join(" "));
		}
	};

	const refusal = entry.refusal ?? carryRefusal;
	return (
		<section className="space-y-3" data-form-entry-section>
			<div>
				<h3 className="text-[13px] font-medium leading-5 text-nova-text-secondary">
					How this form opens
				</h3>
				<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
					{noMatches
						? `From Results, after a search finds no matches. It opens with the search's answers, it is not on the menu, and after submit it returns to ${
								hostKeepsMenuForms
									? "Results showing the case it registered"
									: "Search"
							}.`
						: other !== undefined
							? `From the module menu. “${other.name}” is the form Results offers after a search finds no matches.`
							: "From the module menu."}
				</p>
			</div>

			<p
				role="status"
				aria-live="polite"
				aria-atomic="true"
				className="sr-only"
			>
				{[entry.announcement, carried].filter(Boolean).join(" ")}
			</p>
			{refusal !== undefined && (
				<div
					role="alert"
					className="flex gap-2 rounded-xl border border-nova-rose/25 bg-nova-rose/[0.06] px-3 py-2.5 text-[13px] leading-relaxed text-nova-text-secondary"
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

			{noMatches ? (
				<>
					{canEdit ? (
						<InlineField
							label="Results action label"
							value={form.entry?.label ?? ""}
							placeholder={form.name}
							onChange={setLabel}
						/>
					) : (
						<p className="text-[13px] text-nova-text-secondary">
							Results action: {form.entry?.label ?? form.name}
						</p>
					)}
					{canEdit && (
						<>
							<Button
								type="button"
								variant="outline"
								onClick={carryAnswers}
								className="w-full justify-start border-white/[0.08] bg-transparent text-[14px] text-nova-text-secondary not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-nova-violet/[0.05] not-disabled:hover:text-nova-violet-bright dark:bg-transparent dark:not-disabled:hover:bg-nova-violet/[0.05]"
							>
								Add fields for the search answers
							</Button>
							{carried !== "" && (
								<p className="text-[13px] leading-relaxed text-nova-text-muted">
									{carried}
								</p>
							)}
							<Button
								type="button"
								variant="ghost"
								onClick={(event) =>
									entry.request({ kind: "clear" }, event.currentTarget)
								}
								className="w-full justify-start text-[14px] text-nova-text-secondary"
							>
								Make it a menu form again
							</Button>
						</>
					)}
				</>
			) : (
				canEdit &&
				other === undefined && (
					<Button
						type="button"
						variant="outline"
						onClick={(event) =>
							entry.request({ kind: "existing", formUuid }, event.currentTarget)
						}
						className="w-full justify-start border-white/[0.08] bg-transparent text-[14px] text-nova-text-secondary not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-nova-violet/[0.05] not-disabled:hover:text-nova-violet-bright dark:bg-transparent dark:not-disabled:hover:bg-nova-violet/[0.05]"
					>
						Open after a search finds no matches
					</Button>
				)
			)}

			{entry.review !== null && (
				<NoMatchesFormReviewDialog
					review={entry.review}
					finalFocus={entry.finalFocus}
					onCancel={entry.cancel}
					onConfirm={entry.confirm}
				/>
			)}
		</section>
	);
}
