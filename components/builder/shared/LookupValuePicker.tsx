"use client";
import { useId, useState } from "react";
import { Label } from "@/components/shadcn/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { Switch } from "@/components/shadcn/switch";
import type { LookupMemberId } from "@/lib/domain/lookupIds";
import {
	type LookupRead,
	questionChoiceReadIssue,
	readColumnId,
} from "@/lib/domain/lookupRead";
import type { Platform } from "@/lib/domain/platforms";
import {
	type LookupPathNameIssue,
	lookupPathNameExplanation,
	lookupPathNameIssue,
} from "@/lib/lookup/pathNames";
import type { EditorLookupTableDecl } from "./lookupTablePresentation";
import { BlurCommitTextInput } from "./primitives/BlurCommitTextInput";

interface Props {
	table: EditorLookupTableDecl;
	id: string;
	label: string;
	value?: LookupRead;
	onChange: (read: LookupRead) => void;
	disabled?: boolean;
	questionChoice?: boolean;
	defaultChoice?: { label: string; select: () => void };
	/** The slot this read is printed into. A name a platform the app runs
	 * on cannot read there stays visible but cannot be chosen. */
	names?: {
		slot: "lookup_options_source" | "search_input_options";
		platforms: readonly Platform[];
	};
}
export function LookupValuePicker({
	table,
	id,
	label,
	value,
	onChange,
	disabled,
	defaultChoice,
	questionChoice,
	names,
}: Props) {
	const detailId = useId();
	const orderingId = useId();
	const [error, setError] = useState("");
	const options: {
		key: string;
		label: string;
		read: LookupRead;
		wireName: string;
		issue: LookupPathNameIssue | null;
	}[] = [];
	const issueOf = (...wireNames: string[]) => {
		if (names === undefined) return null;
		for (const wireName of wireNames) {
			const issue = lookupPathNameIssue(
				wireName,
				names.slot,
				"column",
				names.platforms,
			);
			if (issue !== null) return issue;
		}
		return null;
	};
	for (const column of table.columns) {
		options.push({
			key: column.id,
			label: column.label,
			read: column.repeated
				? { columnId: column.id, occurrence: 1 }
				: column.id,
			wireName: column.wireName,
			issue: issueOf(column.wireName),
		});
		for (const member of questionChoice ? [] : (column.properties ?? []))
			options.push({
				key: member.id,
				label: `${column.label} · ${member.label}`,
				read: { columnId: column.id, occurrence: 1, propertyId: member.id },
				wireName: member.wireName,
				issue: issueOf(column.wireName, member.wireName),
			});
	}
	for (const member of table.attributes ?? [])
		options.push({
			key: member.id,
			label: `Row · ${member.label}`,
			read: { attributeId: member.id },
			wireName: member.wireName,
			issue: issueOf(member.wireName),
		});
	const selected =
		value === undefined
			? undefined
			: typeof value === "string"
				? value
				: "attributeId" in value
					? value.attributeId
					: (value.propertyId ?? value.columnId);
	const column = table.columns.find(
		(one) => one.id === (value === undefined ? undefined : readColumnId(value)),
	);
	const detail =
		value && typeof value !== "string" && "columnId" in value
			? value
			: undefined;
	const setDetails = (next: {
		occurrence?: number;
		positionBeforeFilter?: true;
		where?: { propertyId: LookupMemberId; equals: string };
	}) => {
		if (!column) return;
		const part = { ...detail, ...next, columnId: column.id };
		if (!part.occurrence || !part.where) delete part.positionBeforeFilter;
		const issue = questionChoice && questionChoiceReadIssue(part);
		if (issue) {
			setError(issue);
			return;
		}
		setError("");
		onChange(
			part.occurrence === undefined &&
				!part.where &&
				part.propertyId === undefined
				? column.id
				: part,
		);
	};
	return (
		<fieldset className="space-y-2" disabled={disabled}>
			<Label htmlFor={id} className="text-[13px]">
				{label}
			</Label>
			<Select
				disabled={disabled}
				value={selected ?? (defaultChoice ? "default" : null)}
				onValueChange={(key) => {
					setError("");
					if (key === "default" && defaultChoice) return defaultChoice.select();
					const found = options.find((option) => option.key === key);
					if (found) onChange(found.read);
				}}
			>
				<SelectTrigger id={id} wrapValue className="mt-1 min-h-11 w-full">
					<SelectValue>
						{() =>
							options.find((option) => option.key === selected)?.label ??
							(value
								? "A value that is no longer available"
								: (defaultChoice?.label ?? "Choose a value"))
						}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{defaultChoice && (
						<SelectItem value="default">{defaultChoice.label}</SelectItem>
					)}
					{options.map((option) => (
						<SelectItem
							key={option.key}
							value={option.key}
							disabled={option.issue !== null}
							wrap
						>
							{option.issue === null ? (
								option.label
							) : (
								<span>
									{option.label}
									<span className="block text-[12px] text-nova-text-secondary">
										{option.wireName}. {lookupPathNameExplanation(option.issue)}
									</span>
								</span>
							)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{column?.repeated && (
				<details className="space-y-2 text-sm">
					<summary className="cursor-pointer">Which occurrence</summary>
					<Label>Position</Label>
					<BlurCommitTextInput
						value={String(detail?.occurrence ?? "")}
						ariaLabel={`${label} occurrence position`}
						placeholder="Any position"
						onCommit={(raw) => {
							const ordinal = raw === "" ? undefined : Number(raw);
							if (
								ordinal !== undefined &&
								(!Number.isSafeInteger(ordinal) || ordinal < 1)
							) {
								setError("A position starts at 1.");
								return;
							}
							setDetails({ occurrence: ordinal });
						}}
					/>
					{Boolean(column.properties?.length) && (
						<>
							<Label htmlFor={detailId}>Match a value detail</Label>
							<Select
								value={detail?.where?.propertyId ?? "any"}
								disabled={disabled}
								onValueChange={(key) => {
									const member = column.properties?.find(
										(one) => one.id === key,
									);
									setDetails({
										where: member
											? {
													propertyId: member.id,
													equals: detail?.where?.equals ?? "",
												}
											: undefined,
									});
								}}
							>
								<SelectTrigger id={detailId}>
									<SelectValue>
										{() =>
											column.properties?.find(
												(p) => p.id === detail?.where?.propertyId,
											)?.label ?? "Any detail"
										}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="any">Any detail</SelectItem>
									{column.properties?.map((member) => (
										<SelectItem key={member.id} value={member.id}>
											{member.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</>
					)}
					{detail?.where && (
						<>
							<Label>Matching text</Label>
							<BlurCommitTextInput
								ariaLabel={`${label} matching text`}
								value={detail.where.equals}
								onCommit={(equals) => {
									if (detail.where)
										setDetails({ where: { ...detail.where, equals } });
								}}
							/>
						</>
					)}
					{detail?.where && detail.occurrence !== undefined && (
						<div className="flex items-center gap-2">
							<Switch
								id={orderingId}
								checked={!!detail.positionBeforeFilter}
								onCheckedChange={(checked) =>
									setDetails({
										positionBeforeFilter: checked ? true : undefined,
									})
								}
								disabled={disabled}
							/>
							<Label htmlFor={orderingId}>
								Choose the position before matching the detail
							</Label>
						</div>
					)}
					{error && (
						<p role="alert" className="text-nova-rose">
							{error}
						</p>
					)}
				</details>
			)}
		</fieldset>
	);
}
