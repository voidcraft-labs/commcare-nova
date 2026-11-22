"use client";

import { useId, useState } from "react";
import { ToggleRow } from "@/components/builder/inspector/inspectorChrome";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	CHOICE_LAYOUT_LABELS,
	type ChoiceLayout,
	type MultiSelectField,
	multiChoiceLayoutSchema,
	type SingleSelectField,
	singleChoiceLayoutSchema,
} from "@/lib/domain";

const matchLabels = {
	standard: "Start of the choice",
	multiword: "Several words",
	fuzzy: "Similar spellings",
	"android-multiword": "Several words on Android",
	"android-fuzzy": "Similar spellings on Android",
} as const;

export function LayoutSelect({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: Record<string, string>;
	onChange: (value: string) => void;
}) {
	const id = useId();
	return (
		<div className="space-y-1.5">
			<label htmlFor={id} className="text-sm font-medium">
				{label}
			</label>
			<Select
				items={options}
				value={value}
				onValueChange={(next) => {
					if (next !== null) onChange(next);
				}}
			>
				<SelectTrigger id={id} className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{Object.entries(options).map(([key, text]) => (
						<SelectItem key={key} value={key}>
							{text}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

function GridColumns({
	columns,
	commit,
}: {
	columns: number | undefined;
	commit: (columns: number | undefined) => void;
}) {
	const [draft, setDraft] = useState(columns?.toString() ?? "");
	const id = useId();
	const value = Number(draft);
	const valid =
		draft === "" ||
		(/^\d+$/.test(draft) && value > 0 && value <= 2_147_483_647);
	return (
		<div className="space-y-1.5">
			<label htmlFor={id} className="text-sm">
				Columns
			</label>
			<Input
				id={id}
				inputMode="numeric"
				placeholder="Automatic"
				value={draft}
				aria-invalid={!valid}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => {
					if (valid && draft !== (columns?.toString() ?? ""))
						commit(draft === "" ? undefined : value);
				}}
			/>
			{!valid && (
				<p className="text-xs text-nova-rose">
					You can use a whole number from 1 to 2147483647, or leave it blank for
					automatic columns.
				</p>
			)}
		</div>
	);
}

export function ChoiceLayoutEditor({
	field,
	label,
}: {
	field: SingleSelectField | MultiSelectField;
	label: string;
}) {
	const {
		inline: { updateField },
	} = useBlueprintMutations();
	const [rejection, setRejection] = useState<string | null>(null);
	const single = field.kind === "single_select";
	const layout = field.choiceLayout;
	const options: Record<string, string> = { ordinary: "Ordinary choices" };
	for (const [kind, name] of Object.entries(CHOICE_LAYOUT_LABELS)) {
		if (kind === "platforms") continue;
		if (!single && !multiChoiceLayoutSchema.safeParse({ kind }).success)
			continue;
		options[kind] = name;
	}
	if (layout?.kind === "platforms")
		options.platforms = `Web Apps: ${layout.web.kind}. Android: ${layout.android.kind}.`;
	function commit(next: ChoiceLayout | null) {
		const result =
			field.kind === "single_select"
				? updateField(field.uuid, field.kind, { choiceLayout: next })
				: updateField(field.uuid, field.kind, {
						choiceLayout: next && multiChoiceLayoutSchema.parse(next),
					});
		setRejection(result.ok ? null : (result.messages[0] ?? null));
	}
	return (
		<div className="space-y-3" data-field-id="choiceLayout">
			<LayoutSelect
				label={label}
				value={layout?.kind ?? "ordinary"}
				options={options}
				onChange={(kind) =>
					kind !== "platforms" &&
					commit(
						kind === "ordinary"
							? null
							: singleChoiceLayoutSchema.parse({ kind }),
					)
				}
			/>
			{layout?.kind === "grid" && (
				<>
					<GridColumns
						key={`${field.uuid}:${layout.columns}`}
						columns={layout.columns}
						commit={(columns) => {
							const { columns: _previous, ...rest } = layout;
							commit(columns === undefined ? rest : { ...rest, columns });
						}}
					/>
					{single && (
						<ToggleRow
							label="Advance after a choice"
							checked={
								"advanceOnChoice" in layout && layout.advanceOnChoice === true
							}
							onChange={(value) =>
								commit({
									kind: "grid",
									...(layout.columns !== undefined && {
										columns: layout.columns,
									}),
									...(value && { advanceOnChoice: true }),
								})
							}
						/>
					)}
				</>
			)}
			{layout?.kind === "search" && (
				<LayoutSelect
					label="Search matches"
					options={matchLabels}
					value={layout.matchWords ?? "standard"}
					onChange={(mode) =>
						commit(
							singleChoiceLayoutSchema.parse(
								mode === "standard"
									? { kind: "search" }
									: { kind: "search", matchWords: mode },
							),
						)
					}
				/>
			)}
			<RejectionInline message={rejection} />
		</div>
	);
}
