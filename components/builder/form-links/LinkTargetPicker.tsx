// components/builder/form-links/LinkTargetPicker.tsx
//
// Where a link may go: every module's form list and every form in the
// app, each offered only when the target planner admits it. A destination
// the planner refuses (this form itself, a form whose links lead back
// here, a destination that is gone) stays visible with its reason rather
// than disappearing, so the author learns why the obvious choice is not
// on offer instead of hunting for it.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import tablerTable from "@iconify-icons/tabler/table";
import { useMemo } from "react";
import type { FormLinkTargetVerdict } from "@/lib/doc/formLinkReview";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";
import type { FormLinkTarget } from "@/lib/domain";
import { POPOVER_ROW_CLS } from "@/lib/styles";
import { targetRefusal } from "./refusalCopy";

export function sameTarget(
	left: FormLinkTarget | undefined,
	right: FormLinkTarget,
): boolean {
	if (left === undefined || left.type !== right.type) return false;
	if (left.type === "module" || right.type === "module") {
		return left.moduleUuid === right.moduleUuid;
	}
	return (
		left.moduleUuid === right.moduleUuid && left.formUuid === right.formUuid
	);
}

export function LinkTargetPickerContent({
	verdict,
	current,
	onChoose,
}: {
	/** The target planner's answer for a candidate. */
	readonly verdict: (target: FormLinkTarget) => FormLinkTargetVerdict;
	/** The destination the link already has, if any: shown as chosen. */
	readonly current?: FormLinkTarget;
	readonly onChoose: (target: FormLinkTarget) => void;
}) {
	/* The whole app is on offer, so the whole doc is read. */
	const doc = useBlueprintDoc((state) => state);
	const groups = useMemo(
		() =>
			doc.moduleOrder.flatMap((moduleUuid) => {
				const mod = doc.modules[moduleUuid];
				if (mod === undefined) return [];
				return [
					{
						uuid: moduleUuid,
						name: mod.name,
						forms: (doc.formOrder[moduleUuid] ?? []).flatMap((formUuid) => {
							const form = doc.forms[formUuid];
							return form === undefined
								? []
								: [{ uuid: formUuid, name: form.name }];
						}),
					},
				];
			}),
		[doc],
	);
	const nameOf = (formUuid: Uuid) => doc.forms[formUuid]?.name;

	return (
		<div className="max-h-[22rem] space-y-3 overflow-y-auto p-1">
			{groups.map((group) => {
				const moduleTarget: FormLinkTarget = {
					type: "module",
					moduleUuid: group.uuid,
				};
				return (
					<div key={group.uuid} className="space-y-0.5">
						<p className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-nova-text-muted">
							{group.name}
						</p>
						<TargetRow
							icon={tablerTable}
							title={`Open the “${group.name}” form list`}
							detail="The person picks what to do next there"
							chosen={sameTarget(current, moduleTarget)}
							reason={targetRefusal(verdict(moduleTarget), nameOf)}
							onClick={() => onChoose(moduleTarget)}
						/>
						{group.forms.map((form) => {
							const target: FormLinkTarget = {
								type: "form",
								moduleUuid: group.uuid,
								formUuid: form.uuid,
							};
							return (
								<TargetRow
									key={form.uuid}
									icon={tablerArrowRight}
									title={`Go to “${form.name}”`}
									detail="Opens this form next"
									chosen={sameTarget(current, target)}
									reason={targetRefusal(verdict(target), nameOf)}
									onClick={() => onChoose(target)}
								/>
							);
						})}
					</div>
				);
			})}
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
