"use client";

import { InspectorSection } from "@/components/builder/inspector/inspectorChrome";
import { RadioGroup, RadioGroupItem } from "@/components/shadcn/radio-group";
import type { ColumnLoadBehavior } from "@/lib/domain";

type Choice = ColumnLoadBehavior | "ordinary";

const CHOICES: readonly {
	readonly value: Choice;
	readonly label: string;
	readonly description: string;
}[] = [
	{
		value: "ordinary",
		label: "As the list shows",
		description: "The phone works out this value with the rest of the row.",
	},
	{
		value: "cache",
		label: "Keep between visits",
		description: "The phone reuses the value it worked out last time.",
	},
	{
		value: "defer",
		label: "Work it out after the list shows",
		description: "The list opens first and this value fills in.",
	},
	{
		value: "cache-and-defer",
		label: "Both",
		description: "The list opens first and the value is kept between visits.",
	},
];

/**
 * How a phone loads a calculated or link value. Choosing one turns the case
 * list's faster loading on with it; Web Apps loads the whole list later and
 * keeps nothing, which the last line says.
 */
export function LoadBehaviorSection({
	value,
	canEdit,
	onChange,
}: {
	readonly value: ColumnLoadBehavior | undefined;
	readonly canEdit: boolean;
	readonly onChange: (next: ColumnLoadBehavior | undefined) => void;
}) {
	return (
		<InspectorSection label="Loading on phones">
			<RadioGroup<Choice>
				aria-label="Loading on phones"
				value={value ?? "ordinary"}
				onValueChange={(next) =>
					onChange(next === "ordinary" ? undefined : next)
				}
			>
				{CHOICES.map((choice) => (
					<RadioGroupItem<Choice>
						key={choice.value}
						value={choice.value}
						description={choice.description}
						readOnly={!canEdit}
					>
						{choice.label}
					</RadioGroupItem>
				))}
			</RadioGroup>
			<p className="mt-2 text-[12px] leading-relaxed text-nova-text-muted">
				Web Apps loads the whole list later instead and keeps nothing between
				visits. The project space needs CommCare HQ&apos;s case list
				optimizations setting.
			</p>
		</InspectorSection>
	);
}
