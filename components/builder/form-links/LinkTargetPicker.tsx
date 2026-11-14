// components/builder/form-links/LinkTargetPicker.tsx
//
// Where a link may go: "Start this form again" first, then every module's
// form list and every form in the app, each offered only when the target
// planner admits it (`formLinkTargetChoices`). A destination the planner
// refuses (one that is gone, a submenu CommCare HQ does not offer from this
// form's menu, or a form that cannot receive the complete case selection)
// stays visible with its reason rather than disappearing, so the author
// learns why the obvious choice is not on offer and where to point instead.
// A destination the planner admits but the commit gate would refuse,
// because the link can't open a case this form creates, says so the same
// way, in the gate's own sentence (`refusalOf`), before the link is added
// or saved. Links may form cycles: each destination runs once per
// submission, so nothing here disables a form for leading back.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import tablerRepeat from "@iconify-icons/tabler/repeat";
import tablerTable from "@iconify-icons/tabler/table";
import { useFormLinkTargetChoices } from "@/lib/doc/hooks/useFormLinkChoices";
import type { Uuid } from "@/lib/doc/types";
import type { FormLinkTarget } from "@/lib/domain";
import { POPOVER_ROW_CLS } from "@/lib/styles";
import { menuChoiceRefusal, targetRefusal } from "./refusalCopy";

export function sameTarget(
	left: FormLinkTarget | undefined,
	right: FormLinkTarget,
): boolean {
	if (left === undefined || left.type !== right.type) return false;
	switch (right.type) {
		case "this-form":
			return true;
		case "module":
			return left.type === "module" && left.moduleUuid === right.moduleUuid;
		case "form":
			return (
				left.type === "form" &&
				left.moduleUuid === right.moduleUuid &&
				left.formUuid === right.formUuid
			);
	}
}

export function LinkTargetPickerContent({
	formUuid,
	current,
	omitMenuUuid,
	refusalOf,
	onChoose,
}: {
	/** The form whose link is being aimed. */
	readonly formUuid: Uuid;
	/** The destination the link already has, if any: shown as chosen. */
	readonly current?: FormLinkTarget;
	/** A menu whose form-list row is left out, because the chooser offers
	 *  it already (the Otherwise's "This module"). Its forms stay listed. */
	readonly omitMenuUuid?: Uuid;
	/** Why the commit gate would refuse the link this choice makes, for a
	 *  destination the target planner admits; `undefined` when it wouldn't. */
	readonly refusalOf?: (target: FormLinkTarget) => string | undefined;
	readonly onChoose: (target: FormLinkTarget) => void;
}) {
	const { choices } = useFormLinkTargetChoices(formUuid);
	const menuNameOf = (uuid: Uuid) =>
		choices.menus.find((menu) => menu.uuid === uuid)?.name;
	/* One reason per destination, while the list is open: the planner's
	 * when it refuses, else the gate's. The current destination is already
	 * the link's, so nothing is asked of it. */
	const reasonOf = (
		target: FormLinkTarget,
		verdict: (typeof choices)["thisForm"]["verdict"],
	) =>
		verdict.ok
			? sameTarget(current, target)
				? undefined
				: refusalOf?.(target)
			: targetRefusal(verdict, menuNameOf);

	return (
		<div className="max-h-[22rem] space-y-3 overflow-y-auto p-1">
			<TargetRow
				icon={tablerRepeat}
				title="Start this form again"
				detail="Opens a fresh copy of this form"
				chosen={sameTarget(current, choices.thisForm.target)}
				reason={reasonOf(choices.thisForm.target, choices.thisForm.verdict)}
				onClick={() => onChoose(choices.thisForm.target)}
			/>
			{choices.menus.map((menu) => (
				<div key={menu.uuid} className="space-y-0.5">
					<p className="break-words px-2 pt-1 text-[13px] font-semibold text-nova-text-muted">
						{menu.name}
					</p>
					{menu.uuid !== omitMenuUuid && (
						<TargetRow
							icon={tablerTable}
							title={`Open the “${menu.name}” form list`}
							detail="The person picks what to do next there"
							chosen={sameTarget(current, menu.target)}
							reason={
								menu.offered
									? reasonOf(menu.target, menu.verdict)
									: menuChoiceRefusal(menu, menuNameOf)
							}
							onClick={() => onChoose(menu.target)}
						/>
					)}
					{menu.forms.map((form) => (
						<TargetRow
							key={form.uuid}
							icon={tablerArrowRight}
							title={`Go to “${form.name}”`}
							detail="Opens this form next"
							chosen={sameTarget(current, form.target)}
							reason={reasonOf(form.target, form.verdict)}
							onClick={() => onChoose(form.target)}
						/>
					))}
				</div>
			))}
		</div>
	);
}

function TargetRow({
	icon,
	title,
	detail,
	chosen,
	reason,
	onClick,
}: {
	readonly icon: Parameters<typeof Icon>[0]["icon"];
	readonly title: string;
	readonly detail: string;
	readonly chosen: boolean;
	/** Why this destination is not available; `undefined` when it is. */
	readonly reason: string | undefined;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={reason !== undefined && !chosen}
			aria-current={chosen ? "true" : undefined}
			onClick={() => {
				if (!chosen) onClick();
			}}
			className={`${POPOVER_ROW_CLS} ${chosen ? "bg-nova-violet/10 text-nova-violet-bright" : ""}`}
		>
			<Icon
				icon={icon}
				width="16"
				height="16"
				className={`mt-0.5 shrink-0 ${chosen ? "text-nova-violet-bright" : "text-nova-text-muted"}`}
			/>
			<span className="min-w-0 flex-1">
				<span className="block break-words text-sm font-medium">{title}</span>
				<span className="block break-words text-[13px] leading-snug text-nova-text-muted">
					{reason ?? detail}
				</span>
			</span>
		</button>
	);
}
