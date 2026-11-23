"use client";

import { useState } from "react";
import { useTranslationUnitEditor } from "@/components/builder/localization/BuilderLocalizationProvider";
import { ExpressionSlotEditor } from "@/components/builder/shared/ExpressionSlotEditors";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { Button } from "@/components/shadcn/button";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import { useUserProperties } from "@/lib/doc/hooks/useUserCollections";
import { makeTranslationUnitId, type Uuid } from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression/builders";
import type { MenuBadge } from "@/lib/domain/menuBadge";

export function MenuBadgeSection({
	moduleUuid,
	formUuid,
}: {
	moduleUuid: Uuid;
	formUuid?: Uuid;
}) {
	const mod = useModule(moduleUuid);
	const form = useForm(formUuid);
	const owner = formUuid === undefined ? mod : form;
	const editor = useTranslationUnitEditor(
		makeTranslationUnitId(
			formUuid === undefined ? "module" : "form",
			formUuid ?? moduleUuid,
			"badge",
		),
	);
	const { inline } = useBlueprintMutations();
	const caseTypes = useEffectiveCaseTypes();
	const properties = useUserProperties();
	const [error, setError] = useState("");
	if (!owner || (!editor.isSource && owner.badge?.kind !== "text")) return null;
	const badge = owner.badge;
	const save = (next: MenuBadge | null) => {
		const result =
			formUuid === undefined
				? // The module planner commits an absent value as the clear.
					inline.updateModule(moduleUuid, { badge: next ?? undefined })
				: inline.updateForm(formUuid, { badge: next });
		setError(result.ok ? "" : result.messages.join(" "));
	};
	const changeText = (text: string) => {
		if (editor.isSource) save(text ? { kind: "text", text } : null);
		else {
			const result = editor.saveTarget(text);
			setError(result.ok ? "" : result.messages.join(" "));
		}
	};
	return (
		<section className="space-y-2" aria-label="Menu badge">
			<h3 className="text-sm font-medium text-nova-text-secondary">
				Menu badge
			</h3>
			<p className="text-[13px] text-nova-text-muted">
				Show a short label or a value beside {owner.name} on the worker's menu.
			</p>
			{badge?.kind === "calculation" ? (
				<ExpressionSlotEditor
					slot={
						formUuid === undefined
							? { entity: "module", uuid: moduleUuid, slot: "module_badge" }
							: { entity: "form", uuid: formUuid, slot: "form_badge" }
					}
					value={badge.expression}
					onChange={(expression) => save({ kind: "calculation", expression })}
					caseTypes={caseTypes}
					currentCaseType={formUuid ? (mod?.caseType ?? "") : ""}
					userProperties={properties}
				/>
			) : (
				<BlurCommitTextInput
					ariaLabel="Badge text"
					value={
						typeof editor.unit?.effective === "string"
							? editor.unit.effective
							: (badge?.text ?? "")
					}
					onCommit={changeText}
					placeholder="Badge text"
				/>
			)}
			{editor.isSource && (
				<div className="flex gap-2">
					{badge?.kind !== "calculation" && (
						<Button
							type="button"
							variant="ghost"
							onClick={() =>
								save({
									kind: "calculation",
									expression: term(literal(badge?.text ?? 1)),
								})
							}
						>
							Use a calculation
						</Button>
					)}
					{badge && (
						<Button type="button" variant="ghost" onClick={() => save(null)}>
							Remove badge
						</Button>
					)}
				</div>
			)}
			{error && (
				<p role="alert" className="text-sm text-nova-text">
					{error}
				</p>
			)}
		</section>
	);
}
