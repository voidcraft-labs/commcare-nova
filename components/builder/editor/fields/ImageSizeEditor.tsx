"use client";

import { useId } from "react";
import { DraftCommitInput } from "@/components/builder/app-setup/DraftCommitField";
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import { type ImageField, imageDimensionSchema } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";

export function ImageSizeEditor({
	value,
	label,
	onChange,
}: FieldEditorComponentProps<ImageField, "maxDimension">) {
	const id = useId();
	return (
		<div data-field-id="maxDimension" className="space-y-1.5">
			<label htmlFor={id} className={INSPECTOR_LABEL_CLS}>
				{label}
			</label>
			<DraftCommitInput
				id={id}
				disabled={false}
				value={value?.toString() ?? ""}
				ariaDescribedBy={`${id}-description`}
				onCommit={(draft) => onChange(draft === "" ? undefined : Number(draft))}
				validate={(draft) =>
					draft === "" ||
					(/^\d+$/.test(draft) &&
						imageDimensionSchema.safeParse(Number(draft)).success)
						? undefined
						: "Choose a whole number from 1 to 2147483647, or clear the size to keep the original."
				}
			/>
			<p id={`${id}-description`} className="text-xs text-nova-text-secondary">
				Android can send smaller photos. Leave blank to keep the original size.
			</p>
		</div>
	);
}
