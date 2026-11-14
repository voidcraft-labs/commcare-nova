// components/builder/detail/formSettings/FormEntrySection.tsx
//
// How a registration form is reached: from the module menu, or from
// Results after a search finds nothing (the menu's case list registration
// form, `Module.caseListRegistrationForm`). On that form this row also says
// what the missing display-condition row would have said: it is never on a
// menu. Its restricted after-submit destination is also named here. The
// action's label and the carried answers are edited here, next to the form
// they belong to.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import { Fragment, useCallback, useState } from "react";
import { alsoOfferedOnLine } from "@/components/builder/case-list-config/canvas/registerFromListModel";
import {
	CaseListRegistrationReviewDialog,
	planCaseListRegistrationChoice,
	useCaseListRegistration,
} from "@/components/builder/case-list-config/caseListRegistrationReview";
import { Button } from "@/components/shadcn/button";
import {
	carrySearchAnswersMutations,
	caseListRegistrationMutations,
} from "@/lib/doc/caseListRegistrationForm";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useDeclaredPlatforms } from "@/lib/doc/hooks/useDeclaredPlatforms";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import { useOrderedForms } from "@/lib/doc/hooks/useModuleIds";
import { useOfferedBatchRefusals } from "@/lib/doc/hooks/useOfferedBatchRefusals";
import { useCaseListsOffering } from "@/lib/doc/hooks/useRegisterFromList";
import type { BlueprintDoc } from "@/lib/doc/types";
import {
	caseSelectionCardinality,
	effectiveCaseSearchConfig,
	menuFormUuidsOf,
} from "@/lib/domain";
import { platformPickerLine, platformRefusal } from "@/lib/domain/platforms";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { InlineField } from "./InlineField";
import { noMatchesAfterSubmitModel } from "./noMatchesAfterSubmit";
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
	const entry = useCaseListRegistration(moduleUuid);
	const navigate = useNavigate();
	/* The case lists that always offer this form, from their Register
	 * button; the form stays on its own menu. */
	const offeredBy = useCaseListsOffering(formUuid);
	/* Opening a form from an empty search turns on Forms read the search,
	 * which a platform the app runs on may not run: the offer is disabled
	 * with that platform's line, else with the gate's sentence for this
	 * form's batch. */
	const platformLine = platformRefusal(
		"forms-read-search",
		useDeclaredPlatforms(),
	);
	const registration = mod?.caseListRegistrationForm;
	const slot =
		registration?.kind === "after-empty-search" ? registration : undefined;
	const plan = useCallback(
		(doc: BlueprintDoc) => {
			const planned = planCaseListRegistrationChoice(doc, moduleUuid, {
				kind: "existing",
				formUuid,
			});
			return planned === null ? {} : { offer: planned.mutations };
		},
		[formUuid, moduleUuid],
	);
	const gate = useOfferedBatchRefusals<"offer">(
		plan,
		canEdit &&
			form?.type === "registration" &&
			slot === undefined &&
			platformLine === undefined,
	);
	const offerRefusal =
		platformLine !== undefined ? platformPickerLine(platformLine) : gate.offer;
	const [carried, setCarried] = useState("");
	const [carryRefusal, setCarryRefusal] = useState<string | undefined>(
		undefined,
	);

	if (form === undefined || mod === undefined || form.type !== "registration")
		return null;
	const noMatches = slot?.formUuid === formUuid;
	const searchAction =
		mod.caseType !== undefined &&
		effectiveCaseSearchConfig({
			caseListConfig: mod.caseListConfig,
			caseSearchConfig: mod.caseSearchConfig,
		}) !== undefined;
	// A menu registration form with nothing to offer it from, and that no
	// case list offers, stays silent: the row exists to explain an entry or
	// to offer one.
	if (!noMatches && !searchAction && offeredBy.length === 0) return null;
	const other = forms.find(
		(candidate) =>
			candidate.uuid !== formUuid && candidate.uuid === slot?.formUuid,
	);
	const hostKeepsMenuForms =
		menuFormUuidsOf(docApi.getState(), moduleUuid).length > 0;

	const setLabel = (value: string) =>
		inline.commitMany(
			caseListRegistrationMutations(
				docApi.getState(),
				moduleUuid,
				formUuid,
				value.trim().length > 0 ? { label: value.trim() } : {},
			),
		);
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
						? `From Results, after a search finds no matches. It opens with the search's answers, it is not on the menu, and after submit it opens ${
								noMatchesAfterSubmitModel({
									firstMenu: form.postSubmit === "firstMenu",
									multiple: caseSelectionCardinality(mod) === "multiple",
									hasMenuForms: hostKeepsMenuForms,
								}).destination
							}.`
						: other !== undefined
							? `From the module menu. “${other.name}” is the form Results offers after a search finds no matches.`
							: "From the module menu."}
				</p>
			</div>

			{offeredBy.length > 0 && (
				<p
					className="text-[13px] leading-relaxed text-nova-text-secondary"
					data-form-offered-on
				>
					{alsoOfferedOnLine(offeredBy.map((host) => host.hostName))}.{" "}
					{offeredBy.map((host, index) => (
						<Fragment key={host.hostModuleUuid}>
							{index > 0 && " "}
							<Button
								type="button"
								variant="link"
								onClick={() => navigate.openCaseList(host.hostModuleUuid)}
							>
								Open {host.hostName}&apos;s case list
							</Button>
						</Fragment>
					))}
				</p>
			)}

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
							value={slot?.label ?? ""}
							placeholder={form.name}
							onChange={setLabel}
						/>
					) : (
						<p className="text-[13px] text-nova-text-secondary">
							Results action: {slot?.label ?? form.name}
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
					<div className="space-y-1.5">
						<Button
							type="button"
							variant="outline"
							disabled={offerRefusal !== undefined}
							onClick={(event) =>
								entry.request(
									{ kind: "existing", formUuid },
									event.currentTarget,
								)
							}
							className="w-full justify-start border-white/[0.08] bg-transparent text-[14px] text-nova-text-secondary not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-nova-violet/[0.05] not-disabled:hover:text-nova-violet-bright dark:bg-transparent dark:not-disabled:hover:bg-nova-violet/[0.05]"
						>
							Open after a search finds no matches
						</Button>
						{offerRefusal !== undefined && (
							<p className="text-[13px] leading-relaxed text-nova-text-muted">
								{offerRefusal}
							</p>
						)}
					</div>
				)
			)}

			{entry.review !== null && (
				<CaseListRegistrationReviewDialog
					review={entry.review}
					finalFocus={entry.finalFocus}
					onCancel={entry.cancel}
					onConfirm={entry.confirm}
				/>
			)}
		</section>
	);
}
