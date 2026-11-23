"use client";
import { useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Textarea } from "@/components/shadcn/textarea";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useControlWordingIds } from "@/lib/doc/hooks/useLocalization";
import type { TranslationUnitId } from "@/lib/domain";
import { generatedWordingRoles } from "@/lib/domain/generatedWording";
import { useCanEdit } from "@/lib/session/hooks";
import {
	useBuilderLanguage,
	useTranslationUnitEditor,
} from "./BuilderLocalizationProvider";

/** Wording lives on its control and in Languages, edited through the same
 * translation mutation in both places. A control with no outputs has no row. */
export function ControlWording({ owner }: { readonly owner: string }) {
	const ids = useControlWordingIds(owner);
	const [open, setOpen] = useState(false);
	if (!ids.length) return null;
	return (
		<details
			className="space-y-3"
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary className="cursor-pointer text-sm font-medium text-nova-text">
				Worker wording
			</summary>
			{open && ids.map((id) => <WordingField key={id} id={id} />)}
		</details>
	);
}

function WordingField({ id }: { readonly id: TranslationUnitId }) {
	const { unit, saveTarget } = useTranslationUnitEditor(id);
	const { language, direction } = useBuilderLanguage();
	const { inline } = useBlueprintMutations();
	const [message, setMessage] = useState("");
	const inputId = useId();
	const canEdit = useCanEdit();
	if (!unit?.generated || typeof unit.effective !== "string") return null;
	if (
		unit.generated.role === "promptValidation" &&
		!unit.defaultText &&
		!unit.explicit
	)
		return null;
	const value =
		typeof unit.explicit?.value === "string"
			? unit.explicit.value
			: unit.effective;
	const label =
		unit.owner.kind === "case-list-column"
			? unit.breadcrumb.slice(-2).join(" · ")
			: generatedWordingRoles[unit.generated.role];
	return (
		<div className="space-y-1.5">
			<label
				htmlFor={inputId}
				className="block text-xs text-nova-text-secondary"
			>
				{label}
				<Textarea
					id={inputId}
					key={JSON.stringify([language, value])}
					readOnly={!canEdit}
					defaultValue={value}
					dir={direction}
					onBlur={(event) => {
						const next = event.currentTarget.value;
						if (next === value) return;
						const result = saveTarget(next);
						setMessage(result.ok ? "" : result.messages.join(" "));
					}}
				/>
			</label>
			{canEdit && unit.explicit && (
				<Button
					type="button"
					variant="ghost"
					onClick={() => {
						const result = inline.commitMany([
							{ kind: "setTranslation", language, unitId: id, entry: null },
						]);
						setMessage(result.ok ? "" : result.messages.join(" "));
					}}
				>
					Use default wording
				</Button>
			)}
			{message && (
				<p role="alert" className="text-xs text-nova-error">
					{message}
				</p>
			)}
		</div>
	);
}
