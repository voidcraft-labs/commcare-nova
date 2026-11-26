"use client";

import { useId, useState } from "react";
import { v4 } from "uuid";
import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import {
	type CaseListDeviceLookup,
	type CommitOutcome,
	caseListDeviceLookupSchema,
	type Uuid,
} from "@/lib/domain";

function row(name = "", value = "") {
	return { id: v4(), name, value };
}

function edit(value?: CaseListDeviceLookup) {
	return {
		action: value?.action ?? "",
		label: value?.label ?? "",
		icon: value?.icon,
		automatic: value?.automatic,
		extras: value?.extras.map(({ name, value }) => row(name, value)) ?? [row()],
		responses: value?.responses.map((name) => row(name)) ?? [row()],
	};
}

interface Props {
	readonly moduleUuid: Uuid;
	readonly disabled: boolean;
	readonly value: CaseListDeviceLookup | undefined;
	readonly canEdit: boolean;
	readonly onChange: (lookup: CaseListDeviceLookup | null) => CommitOutcome;
}

export function CaseListDeviceLookupSetting({
	moduleUuid,
	disabled,
	value,
	canEdit,
	onChange,
}: Props) {
	const heading = useId();
	const [draft, setDraft] = useState<ReturnType<typeof edit>>();
	const [base, setBase] = useState<CaseListDeviceLookup | undefined>();
	const [error, setError] = useState<string>();

	const commit = (next: CaseListDeviceLookup | null) => {
		if (base !== value) {
			setError(
				"Someone changed the lookup. You can close these settings and open the latest version.",
			);
			return;
		}
		const saved = onChange(next);
		if (saved.ok) {
			setDraft(undefined);
			setError(undefined);
		} else {
			setError(saved.messages.join(" "));
		}
	};

	if (disabled && value === undefined && draft === undefined) return null;
	return (
		<section aria-labelledby={heading} className="max-w-xl space-y-3">
			<h2
				id={heading}
				className="font-display tracking-tighter text-[17px] font-semibold text-nova-text"
			>
				Case lookup with an Android app
			</h2>
			<p className="text-[13px] leading-relaxed text-nova-text-muted">
				Workers can use a companion app’s answer to search this list on Android.
			</p>
			{value && draft === undefined && (
				<p className="text-sm text-nova-text">{value.label}</p>
			)}
			{canEdit && draft === undefined && (
				<Button
					type="button"
					variant="outline"
					onClick={() => {
						setBase(value);
						setDraft(edit(value));
						setError(undefined);
					}}
				>
					{value ? "Edit lookup" : "Add lookup"}
				</Button>
			)}
			{draft !== undefined && canEdit && (
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						const parsed = caseListDeviceLookupSchema.safeParse({
							...draft,
							extras: draft.extras.map(({ name, value }) => ({ name, value })),
							responses: draft.responses.map(({ name }) => name),
						});
						if (!parsed.success) {
							setError(
								"Add an action and a lookup name. Give each sent value and each response its own name.",
							);
							return;
						}
						commit(parsed.data);
					}}
				>
					<LookupInput
						label="Android action"
						value={draft.action}
						onChange={(action) => setDraft({ ...draft, action })}
					/>
					<LookupInput
						label="Lookup name"
						value={draft.label}
						onChange={(label) => setDraft({ ...draft, label })}
					/>
					<div className="space-y-1">
						<p className="text-sm text-nova-text">Button icon</p>
						<SingleAssetSlot
							kind="image"
							value={draft.icon}
							onChange={(icon) =>
								setDraft((latest) => latest && { ...latest, icon })
							}
							slotKey={`case-list-lookup:${moduleUuid}`}
							ariaLabel="Case lookup button icon"
						/>
					</div>
					<label className="flex gap-2 text-sm text-nova-text">
						<input
							type="checkbox"
							checked={draft.automatic === true}
							onChange={(event) =>
								setDraft({
									...draft,
									automatic: event.currentTarget.checked ? true : undefined,
								})
							}
						/>
						Open the companion automatically
					</label>
					<LookupRows
						kind="extras"
						rows={draft.extras}
						onChange={(extras) => setDraft({ ...draft, extras })}
					/>
					<LookupRows
						kind="responses"
						rows={draft.responses}
						onChange={(responses) => setDraft({ ...draft, responses })}
					/>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<div className="flex flex-wrap gap-2">
						<Button type="submit">Save lookup</Button>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setDraft(undefined)}
						>
							Cancel
						</Button>
						{value && (
							<Button
								type="button"
								variant="ghost"
								onClick={() => commit(null)}
							>
								Remove lookup
							</Button>
						)}
					</div>
				</form>
			)}
		</section>
	);
}

function LookupRows({
	kind,
	rows,
	onChange,
}: {
	readonly kind: "extras" | "responses";
	readonly rows: ReturnType<typeof row>[];
	readonly onChange: (rows: ReturnType<typeof row>[]) => void;
}) {
	const sending = kind === "extras";
	const noun = sending ? "value" : "response";
	const update = (id: string, patch: { name?: string; value?: string }) =>
		onChange(rows.map((one) => (one.id === id ? { ...one, ...patch } : one)));
	return (
		<fieldset className="space-y-2">
			<legend className="text-sm font-medium text-nova-text">
				{sending ? "Values to send" : "Response names, in order"}
			</legend>
			{rows.map(({ id, name, value }) => (
				<div className="flex items-end gap-2" key={id}>
					<LookupInput
						label="Name"
						value={name}
						onChange={(name) => update(id, { name })}
					/>
					{sending && (
						<LookupInput
							label="Text"
							value={value}
							onChange={(value) => update(id, { value })}
						/>
					)}
					<Button
						type="button"
						variant="ghost"
						disabled={rows.length === 1}
						onClick={() => onChange(rows.filter((one) => one.id !== id))}
					>
						Remove {noun}
					</Button>
				</div>
			))}
			<Button
				type="button"
				variant="ghost"
				onClick={() => onChange([...rows, row()])}
			>
				Add {noun}
			</Button>
		</fieldset>
	);
}

function LookupInput({
	label,
	value,
	onChange,
}: {
	readonly label: string;
	readonly value: string;
	readonly onChange: (value: string) => void;
}) {
	const id = useId();
	return (
		<label
			htmlFor={id}
			className="block min-w-0 flex-1 space-y-1 text-sm text-nova-text"
		>
			<span>{label}</span>
			<Input
				id={id}
				value={value}
				onChange={(event) => onChange(event.currentTarget.value)}
			/>
		</label>
	);
}
