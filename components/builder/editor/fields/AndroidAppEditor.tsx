"use client";
import { useId, useState } from "react";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { XPathField } from "@/components/builder/XPathField";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import { LabeledSelect } from "@/components/shadcn/labeled-select";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useAndroidAppQuestionEntries } from "@/lib/doc/hooks/useFormFieldEntries";
import {
	useFormExpressionText,
	useParseFormExpression,
} from "@/lib/doc/hooks/useXPathSlots";
import type { Field, Uuid } from "@/lib/domain";
import {
	type AndroidAppAction,
	type AndroidAppAnswer,
	androidAppInputMember,
	BUILT_IN_ANDROID_APP_ACTIONS,
	isAndroidAppInputKind,
} from "@/lib/domain/fields/androidApp";
import { useFormLintContext } from "./useFormLintContext";

const CUSTOM_APP = "another-app";
function AppParameter({
	uuid,
	before,
	initial,
	commit,
	remove,
}: {
	before: AndroidAppAction["send"];
	uuid: Uuid;
	initial?: AndroidAppAction["send"][number];
	commit: (arg: AndroidAppAction["send"][number]) => boolean;
	remove?: () => void;
}) {
	const inputId = useId();
	const [name, setName] = useState(initial?.name ?? "");
	const slot = {
		entity: "field" as const,
		uuid,
		slot: "android_app_input" as const,
		member: androidAppInputMember([...before, { name }], before.length),
	};
	const printed = useFormExpressionText(initial?.value, slot);
	const getEditorContext = useFormLintContext(slot);
	// The editor compares its incoming projection with its active draft to
	// detect a peer edit. Only a validated, closed edit becomes the projection.
	const [source, setSource] = useState<string>();
	const [draft, setDraft] = useState<string>();
	const [error, setError] = useState<string | null>(null);
	const parse = useParseFormExpression(slot);
	const save = () => {
		try {
			const value = parse(draft ?? source ?? printed);
			if (commit({ name, value })) {
				setError(null);
				setSource(undefined);
				setDraft(undefined);
				if (!initial) setName("");
			}
		} catch (problem) {
			setError(
				problem instanceof Error
					? problem.message
					: "This expression could not be read.",
			);
		}
	};
	return (
		<div className="space-y-1">
			<label htmlFor={inputId}>
				Value name
				<Input
					id={inputId}
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
			</label>
			<fieldset>
				<legend>Value to send</legend>
				<XPathField
					value={source ?? printed}
					getEditorContext={getEditorContext}
					onDraftChange={setDraft}
					onEditingChange={(editing) => {
						if (!editing) setDraft(undefined);
					}}
					onSave={(text) => {
						setSource(text);
						return undefined;
					}}
				/>
			</fieldset>
			<Button
				type="button"
				variant="outline"
				onClick={save}
				disabled={!name || !(draft ?? source ?? printed)}
			>
				{" "}
				{initial ? "Save value" : "Add value"}{" "}
			</Button>
			{remove && (
				<Button type="button" variant="ghost" onClick={remove}>
					Remove value
				</Button>
			)}
			<RejectionInline message={error} />
		</div>
	);
}

interface AndroidAppEditorProps {
	readonly field: Field;
	readonly onDismissEmpty?: () => void;
}

export function AndroidAppEditor(props: AndroidAppEditorProps) {
	return <AppSettings key={props.field.uuid} {...props} />;
}

function AppSettings({ field, onDismissEmpty }: AndroidAppEditorProps) {
	const entries = useAndroidAppQuestionEntries(field.uuid);
	const inputId = useId();
	const {
		inline: { updateField },
	} = useBlueprintMutations();
	const [action, setAction] = useState<string>();
	const [custom, setCustom] = useState(false);
	const [newKey, setNewKey] = useState("");
	const [target, setTarget] = useState<Uuid>();
	const [error, setError] = useState<string | null>(null);

	const { kind } = field;
	if (!isAndroidAppInputKind(kind)) return null;
	const setting = "androidApp" in field ? field.androidApp : undefined;
	const current = setting?.kind === "open-app" ? setting : undefined;
	const indexed = new Map(entries.map((entry) => [entry.uuid, entry]));
	const rowsAgree = (question: Uuid, invoking: Uuid) => {
		const target = indexed.get(question);
		const source = indexed.get(invoking);
		return Boolean(
			target &&
				source &&
				target.repeatAncestors.every(
					(row, index) => source.repeatAncestors[index] === row,
				),
		);
	};
	const choices = entries.filter((entry) => {
		return (
			entry.kind === "text" &&
			entry.app?.kind === "open-app" &&
			entry.uuid !== field.uuid &&
			entry.app.receive.every((result) =>
				rowsAgree(result.question, field.uuid),
			)
		);
	});
	const close = !setting && onDismissEmpty && (
		<Button variant="ghost" type="button" onClick={onDismissEmpty}>
			Close Android app settings
		</Button>
	);
	if (field.kind !== "text" && choices.length === 0 && !setting)
		return (
			<div className="space-y-2">
				<p className="text-sm">
					A text question in this form can open an Android app. Once it does,
					this question can use the same app.
				</p>
				{close}
			</div>
		);
	const invoking = entries.filter((entry) => {
		return (
			entry.uuid === field.uuid ||
			(entry.app?.kind === "use-question" && entry.app.question === field.uuid)
		);
	});
	const destinations = entries.filter(
		(entry) =>
			!["group", "section", "repeat"].includes(entry.kind) &&
			invoking.every((source) => rowsAgree(entry.uuid, source.uuid)),
	);
	const commit = (next: AndroidAppAnswer | null) => {
		if (kind !== "text" && next?.kind === "open-app") return false;
		const outcome =
			kind === "text"
				? updateField(field.uuid, kind, { androidApp: next })
				: updateField(field.uuid, kind, {
						androidApp: next?.kind === "use-question" ? next : null,
					});
		setError(
			outcome.ok
				? null
				: (outcome.messages[0] ?? "This change could not be saved."),
		);
		return outcome.ok;
	};
	return (
		<div data-field-id="androidApp" className="space-y-3">
			{field.kind === "text" && (
				<>
					<LabeledSelect
						label="Android app"
						placeholder="Choose an app"
						value={
							custom ||
							(current && !BUILT_IN_ANDROID_APP_ACTIONS.has(current.action))
								? CUSTOM_APP
								: current?.action
						}
						choices={[
							...[...BUILT_IN_ANDROID_APP_ACTIONS].map(([value, label]) => ({
								value,
								label,
							})),
							{ value: CUSTOM_APP, label: "Another Android app" },
						]}
						select={(next) => {
							if (next === CUSTOM_APP) {
								setCustom(true);
								return;
							}
							if (
								commit({
									kind: "open-app",
									action: next,
									send: current?.send ?? [],
									receive: current?.receive ?? [],
								})
							) {
								setCustom(false);
								setAction(undefined);
							}
						}}
					/>
					{(custom ||
						(current && !BUILT_IN_ANDROID_APP_ACTIONS.has(current.action))) && (
						<div>
							<label htmlFor={`${inputId}-action`}>
								Action ID
								<Input
									id={`${inputId}-action`}
									value={
										action ??
										(current &&
										!BUILT_IN_ANDROID_APP_ACTIONS.has(current.action)
											? current.action
											: "")
									}
									onChange={(e) => setAction(e.target.value)}
								/>
							</label>
							<Button
								type="button"
								variant="outline"
								disabled={!action || action === current?.action}
								onClick={() => {
									if (
										action &&
										commit({
											kind: "open-app",
											action,
											send: current?.send ?? [],
											receive: current?.receive ?? [],
										})
									) {
										setAction(undefined);
										setCustom(false);
									}
								}}
							>
								Save action
							</Button>
						</div>
					)}
				</>
			)}
			{choices.length > 0 && (
				<LabeledSelect
					label="Use another question’s Android app"
					placeholder="Choose a question"
					value={
						setting?.kind === "use-question" ? setting.question : undefined
					}
					choices={choices.map((choice) => ({
						value: choice.uuid,
						label: choice.label,
					}))}
					select={(value) => {
						const choice = choices.find((item) => item.uuid === value);
						if (
							choice &&
							commit({ kind: "use-question", question: choice.uuid })
						) {
							setCustom(false);
							setAction(undefined);
						}
					}}
				/>
			)}
			{current && (
				<>
					<h4>Values sent to the app</h4>
					{new Set(current.send.map((input) => input.name)).size <
						current.send.length && (
						<p className="text-sm">
							When a name appears more than once, the app receives its last
							value.
						</p>
					)}
					{current.send.map((param, index) => (
						<AppParameter
							key={JSON.stringify(androidAppInputMember(current.send, index))}
							before={current.send.slice(0, index)}
							uuid={field.uuid}
							initial={param}
							commit={(arg) =>
								commit({
									...current,
									send: current.send.map((value, at) =>
										at === index ? arg : value,
									),
								})
							}
							remove={() =>
								commit({
									...current,
									send: current.send.filter((_, at) => at !== index),
								})
							}
						/>
					))}
					<AppParameter
						key={`new-${current.send.length}`}
						uuid={field.uuid}
						before={current.send}
						commit={(arg) =>
							commit({ ...current, send: [...current.send, arg] })
						}
					/>
					<h4>Answers returned to the form</h4>
					{current.receive.some((result, index) =>
						current.receive
							.slice(0, index)
							.some(
								(other) =>
									other.question === result.question &&
									other.name !== result.name,
							),
					) && (
						<p className="text-sm">
							Different results fill the same question. If the app returns both,
							different phones or form sessions can keep different answers.
						</p>
					)}
					{current.receive.map((mapping, index) => (
						<div
							className="flex items-center justify-between"
							key={JSON.stringify([mapping.name, mapping.question, index])}
						>
							<span>
								{mapping.name} →{" "}
								{entries.find((e) => e.uuid === mapping.question)?.label}
							</span>
							<Button
								type="button"
								variant="ghost"
								onClick={() =>
									commit({
										...current,
										receive: current.receive.filter((_, at) => at !== index),
									})
								}
							>
								Remove result
							</Button>
						</div>
					))}
					<label htmlFor={`${inputId}-result`}>
						Result name
						<Input
							id={`${inputId}-result`}
							value={newKey}
							onChange={(event) => setNewKey(event.target.value)}
						/>
					</label>
					<LabeledSelect
						label="Question to fill"
						placeholder="Choose a question"
						value={target}
						choices={destinations.map((item) => ({
							value: item.uuid,
							label: item.label,
						}))}
						select={(value) =>
							setTarget(destinations.find((item) => item.uuid === value)?.uuid)
						}
					/>
					<Button
						type="button"
						variant="outline"
						disabled={!newKey || !target}
						onClick={() => {
							if (
								target &&
								commit({
									...current,
									receive: [
										...current.receive,
										{ name: newKey, question: target },
									],
								})
							) {
								setTarget(undefined);
								setNewKey("");
							}
						}}
					>
						Add result
					</Button>
				</>
			)}
			{setting && (
				<Button
					type="button"
					variant="ghost"
					onClick={() => {
						if (commit(null)) {
							setAction(undefined);
							setCustom(false);
						}
					}}
				>
					Stop using the Android app
				</Button>
			)}
			{close}
			<RejectionInline message={error} />
		</div>
	);
}
