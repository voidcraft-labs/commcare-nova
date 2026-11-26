"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowDown from "@iconify-icons/tabler/arrow-down";
import tablerArrowUp from "@iconify-icons/tabler/arrow-up";
import tablerX from "@iconify-icons/tabler/x";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { Button } from "@/components/shadcn/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type { SearchInputDef, Uuid } from "@/lib/domain";

export function SearchGroupHeading({
	label,
	canEdit,
	onRename,
	onMoveUp,
	onMoveDown,
	onRemove,
	availableFields,
	onMoveField,
}: {
	readonly label: string;
	readonly canEdit: boolean;
	readonly onRename: (label: string) => void;
	readonly onMoveUp?: () => void;
	readonly onMoveDown?: () => void;
	readonly onRemove: () => void;
	readonly availableFields: readonly SearchInputDef[];
	readonly onMoveField: (uuid: Uuid) => void;
}) {
	if (!canEdit)
		return <h4 className="font-semibold text-nova-text">{label}</h4>;
	const choices = availableFields.map((field) => ({
		value: field.uuid,
		label: field.label || field.name,
	}));
	return (
		<div className="rounded-lg border border-nova-border p-3">
			<div className="flex flex-wrap items-center gap-2">
				<div className="min-w-40 flex-1">
					<BlurCommitTextInput
						value={label}
						ariaLabel="Search heading"
						onCommit={onRename}
					/>
				</div>
				<Button
					variant="ghost-action"
					size="icon"
					type="button"
					aria-label={`Move ${label} heading up`}
					disabled={!onMoveUp}
					onClick={onMoveUp}
				>
					<Icon icon={tablerArrowUp} />
				</Button>
				<Button
					variant="ghost-action"
					size="icon"
					type="button"
					aria-label={`Move ${label} heading down`}
					disabled={!onMoveDown}
					onClick={onMoveDown}
				>
					<Icon icon={tablerArrowDown} />
				</Button>
				<Button
					variant="ghost-action"
					size="icon"
					type="button"
					aria-label={`Remove ${label} heading`}
					onClick={onRemove}
				>
					<Icon icon={tablerX} />
				</Button>
			</div>
			{choices.length > 0 && (
				<Select
					value={null}
					items={choices}
					onValueChange={(uuid) => {
						if (uuid !== null) onMoveField(uuid);
					}}
				>
					<SelectTrigger
						className="mt-2"
						aria-label={`Move a field to ${label}`}
					>
						<SelectValue placeholder="Move a field here" />
					</SelectTrigger>
					<SelectContent>
						{choices.map((choice) => (
							<SelectItem key={choice.value} value={choice.value}>
								{choice.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
		</div>
	);
}
