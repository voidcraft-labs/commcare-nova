"use client";

import { useId } from "react";
import { v4 as uuidv4 } from "uuid";
import { Button } from "@/components/shadcn/button";
import { Checkbox } from "@/components/shadcn/checkbox";
import { Input } from "@/components/shadcn/input";
import type {
	LookupDataType,
	LookupMember,
	LookupMemberDraft,
} from "@/lib/lookup/types";
import { suggestWireName } from "./projectDataModel";

export interface EditingMember {
	key: string;
	id?: LookupMember["id"];
	label: string;
	wireName?: string;
}

export function editingMembers(
	members: readonly LookupMember[] = [],
): EditingMember[] {
	return members.map((member) => ({ ...member, key: member.id }));
}

export function memberInputs(members: readonly EditingMember[]) {
	return members.map((member) => ({
		...(member.id && { id: member.id }),
		label: member.label,
		wireName: member.wireName ?? suggestWireName(member.label),
	}));
}

export function MemberFields({
	members,
	onChange,
	title,
	disabled,
	canRemoveExisting = true,
}: {
	members: readonly EditingMember[];
	onChange: (members: EditingMember[]) => void;
	title: "Row details" | "Value details";
	disabled: boolean;
	canRemoveExisting?: boolean;
}) {
	const base = useId();
	const label = title === "Row details" ? "row detail" : "value detail";
	return (
		<fieldset disabled={disabled} className="space-y-3">
			<legend className="text-sm font-medium">{title}</legend>
			{members.map((member, index) => {
				const change = (part: Partial<LookupMemberDraft>) =>
					onChange(
						members.map((item) =>
							item.key === member.key ? { ...item, ...part } : item,
						),
					);
				return (
					<div
						key={member.key}
						className="space-y-2 rounded-lg border border-nova-border p-3"
					>
						<label
							htmlFor={`${base}-${member.key}-name`}
							className="block text-xs"
						>
							Name for {label} {index + 1}
							<Input
								id={`${base}-${member.key}-name`}
								className="mt-1 h-11"
								value={member.label}
								onChange={(event) => change({ label: event.target.value })}
							/>
						</label>
						<label
							htmlFor={`${base}-${member.key}-export`}
							className="block text-xs"
						>
							Name in exports
							<Input
								id={`${base}-${member.key}-export`}
								className="mt-1 h-11"
								disabled={!!member.id && !canRemoveExisting}
								value={member.wireName ?? suggestWireName(member.label)}
								onChange={(event) => change({ wireName: event.target.value })}
							/>
						</label>
						<div className="flex flex-wrap gap-1">
							{index > 0 && (
								<Button
									type="button"
									variant="ghost"
									onClick={() => {
										const next = [...members];
										next.splice(index - 1, 0, ...next.splice(index, 1));
										onChange(next);
									}}
								>
									Move up
								</Button>
							)}
							<Button
								type="button"
								variant="ghost"
								disabled={!!member.id && !canRemoveExisting}
								onClick={() =>
									onChange(members.filter((item) => item.key !== member.key))
								}
							>
								Remove {member.label || label}
							</Button>
						</div>
					</div>
				);
			})}
			<Button
				type="button"
				variant="outline"
				onClick={() => onChange([...members, { key: uuidv4(), label: "" }])}
			>
				Add {label}
			</Button>
		</fieldset>
	);
}

export interface ColumnOptions {
	repeated: boolean;
	indexed: boolean;
	properties: EditingMember[];
}
export function columnOptionInputs(options: ColumnOptions) {
	return {
		...(options.repeated && {
			repeated: true as const,
			properties: memberInputs(options.properties),
		}),
		...(options.indexed && { indexed: true }),
	};
}
export function ColumnOptionFields({
	options,
	dataType,
	onChange,
	disabled,
	canChangeShape = true,
}: {
	options: ColumnOptions;
	dataType: LookupDataType;
	onChange: (next: ColumnOptions) => void;
	disabled: boolean;
	canChangeShape?: boolean;
}) {
	const base = useId();
	return (
		<div className="space-y-3">
			{dataType === "text" && (
				<label
					htmlFor={`${base}-repeat`}
					className="flex min-h-11 items-center gap-2 text-sm"
				>
					<Checkbox
						id={`${base}-repeat`}
						disabled={disabled || !canChangeShape}
						checked={options.repeated}
						onCheckedChange={(repeated) => onChange({ ...options, repeated })}
					/>
					Allow several values per row
				</label>
			)}
			{options.repeated && (
				<MemberFields
					title="Value details"
					canRemoveExisting={canChangeShape}
					members={options.properties}
					onChange={(properties) => onChange({ ...options, properties })}
					disabled={disabled}
				/>
			)}
			<label
				htmlFor={`${base}-index`}
				className="flex min-h-11 items-center gap-2 text-sm"
			>
				<Checkbox
					id={`${base}-index`}
					disabled={disabled}
					checked={options.indexed}
					onCheckedChange={(indexed) => onChange({ ...options, indexed })}
				/>
				Index this column for lookup
			</label>
		</div>
	);
}
