"use client";

import { useId, useState } from "react";
import { ToggleRow } from "@/components/builder/inspector/inspectorChrome";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import { useQuestionChannels } from "@/lib/doc/hooks/useQuestionChannels";
import {
	type Field,
	type FieldDisplaySetting,
	fieldDisplayOptionsFor,
	fieldDisplaySettingsFor,
} from "@/lib/domain";

import type { CommitOutcome } from "@/lib/domain/kinds";
import { useSelectedFormUuid } from "@/lib/routing/hooks";
import { LayoutSelect } from "./ChoiceLayoutEditor";

interface Props {
	field: Field;
	keyName: string;
	label: string;
	value: unknown;
	onChange: (value: unknown) => CommitOutcome;
}

function ChannelEditor({
	setting,
	value,
	change,
}: {
	setting: FieldDisplaySetting;
	value: unknown;
	change: (value: unknown) => void;
}) {
	const formUuid = useSelectedFormUuid();
	const names = useQuestionChannels(formUuid);
	const list = useId(),
		channelId = useId(),
		fieldId = useId();
	const receiver =
		typeof value === "object" &&
		value !== null &&
		"channel" in value &&
		typeof value.channel === "string" &&
		"field" in value &&
		typeof value.field === "string"
			? { channel: value.channel, field: value.field }
			: undefined;
	const topics = Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: [];
	const [channel, setChannel] = useState(receiver?.channel ?? "");
	const [property, setProperty] = useState(receiver?.field ?? "");
	const sending = setting.input === "channels";
	const invalid = channel.includes(" ") || (!sending && /[ -]/.test(property));
	return (
		<div className="space-y-2">
			{sending &&
				topics.map((topic) => (
					<div className="flex items-center gap-1" key={topic}>
						<span className="min-w-0 flex-1 break-all">
							{topic || "Unnamed channel"}
						</span>
						<Button
							type="button"
							variant="ghost"
							onClick={() => {
								const next = topics.filter((t) => t !== topic);
								change(next.length ? next : null);
							}}
						>
							Remove
						</Button>
					</div>
				))}
			<label htmlFor={channelId} className="text-sm">
				{sending ? "Channel to update" : "Receive updates from"}
			</label>
			<Input
				id={channelId}
				list={list}
				value={channel}
				onChange={(e) => setChannel(e.target.value)}
			/>
			<datalist id={list}>
				{names.map((name) => (
					<option key={name} value={name} />
				))}
			</datalist>
			{!sending && (
				<>
					<label htmlFor={fieldId} className="text-sm">
						Returned field
					</label>
					<Input
						id={fieldId}
						value={property}
						placeholder="filename"
						onChange={(e) => setProperty(e.target.value)}
					/>
				</>
			)}
			{invalid && (
				<p className="text-xs text-nova-rose">
					A channel can contain any character except a space. A returned field
					can contain any character except a space or hyphen.
				</p>
			)}
			<Button
				type="button"
				variant="outline"
				disabled={invalid || (sending && topics.includes(channel))}
				onClick={() => {
					change(sending ? [...topics, channel] : { channel, field: property });
					if (sending) setChannel("");
				}}
			>
				{sending ? "Add channel" : "Use this field"}
			</Button>
			{!sending && receiver && (
				<Button type="button" variant="ghost" onClick={() => change(null)}>
					Disconnect
				</Button>
			)}
		</div>
	);
}

function CountEditor({
	label,
	value,
	change,
}: {
	label: string;
	value: unknown;
	change: (value: unknown) => void;
}) {
	const [draft, setDraft] = useState(typeof value === "string" ? value : "");
	const id = useId();
	const valid = /^[0-9]*$/.test(draft);
	return (
		<div className="space-y-1.5">
			<label htmlFor={id} className="text-sm">
				{label}
			</label>
			<Input
				id={id}
				inputMode="numeric"
				value={draft}
				placeholder="Automatic"
				aria-invalid={!valid}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => {
					if (valid)
						change(draft === "" ? null : draft.replace(/^0+(?=\d)/, ""));
				}}
			/>
			{!valid && (
				<p className="text-xs text-nova-rose">
					You can enter a whole number, or leave this blank for automatic
					layout.
				</p>
			)}
		</div>
	);
}

/** The registry supplies exactly the settings this question can carry. Every
 * change goes through the same per-field proposal as the rest of the inspector. */
export function QuestionDisplayEditor({
	field,
	keyName,
	label,
	value,
	onChange,
}: Props) {
	const setting = fieldDisplaySettingsFor(field.kind).find(
		(s) => s.key === keyName,
	);
	const [rejection, setRejection] = useState<string | null>(null);
	if (!setting) return null;
	function change(next: unknown) {
		const result = onChange(next);
		setRejection(result.ok ? null : (result.messages[0] ?? null));
	}
	const resetKey = JSON.stringify(value);
	const options = Object.fromEntries(
		Object.entries(fieldDisplayOptionsFor(field.kind, setting)).map(
			([key, row]) => [key, row.label],
		),
	);
	return (
		<div data-field-id={keyName} className="space-y-2">
			{setting.input === "enum" && (
				<LayoutSelect
					label={label}
					value={typeof value === "string" ? value : "ordinary"}
					options={{ ordinary: "Ordinary display", ...options }}
					onChange={(next) => change(next === "ordinary" ? null : next)}
				/>
			)}
			{setting.input === "flag" && (
				<ToggleRow
					label={label}
					checked={value === true}
					onChange={(next) => change(next ? true : null)}
				/>
			)}
			{setting.input === "count" && (
				<CountEditor
					key={resetKey}
					label={label}
					value={value}
					change={change}
				/>
			)}
			{(setting.input === "channels" || setting.input === "receiver") && (
				<ChannelEditor
					key={resetKey}
					setting={setting}
					value={value}
					change={change}
				/>
			)}
			<RejectionInline message={rejection} />
		</div>
	);
}
