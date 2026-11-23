"use client";
import { type ReactNode, useId, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { InlineField } from "@/components/builder/detail/formSettings/InlineField";
import { LabeledXPathField } from "@/components/builder/detail/formSettings/LabeledXPathField";
import { Button } from "@/components/shadcn/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type { FormEntryChange } from "@/lib/doc/formEntryMutations";
import { useFormEntryChoices } from "@/lib/doc/hooks/useFormEntryChoices";
import { useUserProperties } from "@/lib/doc/hooks/useUserCollections";
import {
	useExpressionEditorContext,
	useExpressionProjection,
	useParseFormExpression,
} from "@/lib/doc/hooks/useXPathSlots";
import { useLookupCommitState } from "@/lib/doc/lookupCommitContext";
import type { CommitOutcome, Uuid } from "@/lib/domain";
import { term } from "@/lib/domain/expression/builders";
import type {
	Expression,
	FormExpressionSlotRef,
} from "@/lib/domain/expression/types";
import type {
	FormCaseSelection,
	FormSelectionSource,
} from "@/lib/domain/formEntryCases";
import { uniqueSlug } from "@/lib/domain/idSlug";
import { USERCASE_CASE_TYPE } from "@/lib/domain/usercase";
import { asUuid } from "@/lib/domain/uuid";
import { useCanEdit } from "@/lib/session/hooks";

type Controls = ReturnType<typeof useFormEntryChoices>;
type Option = { value: string; label: string };
const sources: Record<FormSelectionSource["kind"], string> = {
	choose: "Worker chooses from a list",
	expression: "A formula finds the record",
	"worker-data": "ID in the worker’s information",
	table: "ID in a data table",
	index: "Connection on an earlier record",
	"worker-record": "Worker’s own record",
};

function Picker({
	label,
	options,
	value,
	onChange,
}: {
	label: string;
	options: readonly Option[];
	value: string;
	onChange(value: string): void;
}) {
	const id = useId();
	return (
		<div>
			<label htmlFor={id} className="mb-1 block text-xs text-nova-text-muted">
				{label}
			</label>
			<Select
				items={options}
				value={value}
				onValueChange={(next) => {
					if (next !== null) onChange(next);
				}}
			>
				<SelectTrigger id={id}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

function Formula({
	label,
	slot,
	value,
	save,
}: {
	label: string;
	slot: FormExpressionSlotRef;
	value: Expression;
	save(value: Expression): CommitOutcome;
}) {
	const projected = useExpressionProjection(value, slot);
	const parse = useParseFormExpression(slot);
	const context = useExpressionEditorContext(slot);
	return (
		<LabeledXPathField
			label={label}
			required
			value={projected.text}
			getEditorContext={context}
			onSave={(text) => save(parse(text))}
		/>
	);
}

function OrderActions({
	name,
	ids,
	index,
	move,
	remove,
}: {
	name: string;
	ids: readonly Uuid[];
	index: number;
	move(after: Uuid | null): void;
	remove(): void;
}) {
	return (
		<div className="flex flex-wrap gap-1">
			<Button
				type="button"
				variant="ghost"
				disabled={index === 0}
				aria-label={`Move ${name} earlier`}
				onClick={() => move(ids[index - 2] ?? null)}
			>
				Earlier
			</Button>
			<Button
				type="button"
				variant="ghost"
				disabled={index === ids.length - 1}
				aria-label={`Move ${name} later`}
				onClick={() => move(ids[index + 1])}
			>
				Later
			</Button>
			<Button
				type="button"
				variant="ghost"
				aria-label={`Remove ${name}`}
				onClick={remove}
			>
				Remove
			</Button>
		</div>
	);
}

function ChoiceEditor({
	controls,
	row,
	index,
	save,
}: {
	controls: Controls;
	row: FormCaseSelection;
	index: number;
	save: (change: FormEntryChange) => CommitOutcome;
}) {
	const { choices, types, menus } = controls;
	const src = row.source;
	const earlier = choices.slice(0, index);
	const workerProperties = useUserProperties();
	const { lookupContext } = useLookupCommitState();
	const tables =
		lookupContext.kind === "available" ? lookupContext.definitions : [];
	const columns = tables.flatMap((table) =>
		table.columns.map((column) => ({
			value: column.id,
			label: `${table.name} · ${column.label}`,
			source: { kind: "table" as const, table: table.id, column: column.id },
		})),
	);
	const edit = (patch: Partial<Omit<FormCaseSelection, "uuid" | "tag">>) =>
		save({ operation: "edit-choice", uuid: row.uuid, patch });
	const setSource = (source: FormSelectionSource, caseType = row.caseType) =>
		edit({ source, caseType });
	const firstMenu =
		menus.find((menu) => menu.caseType === row.caseType) ?? menus[0];
	const options = Object.entries(sources)
		.filter(
			([kind]) =>
				kind === src.kind ||
				((kind !== "choose" || menus.length > 0) &&
					(kind !== "index" || earlier.length > 0) &&
					(kind !== "table" || columns.length > 0)),
		)
		.map(([value, label]) => ({ value, label }));
	const chooseSource = (kind: string) => {
		if (kind === src.kind) return;
		switch (kind) {
			case "choose":
				if (firstMenu)
					setSource({ kind, module: firstMenu.uuid }, firstMenu.caseType);
				return;
			case "worker-record":
				setSource({ kind }, USERCASE_CASE_TYPE);
				return;
			case "worker-data":
				setSource({
					kind,
					property: workerProperties[0]
						? {
								kind: "session-user-property",
								userPropertyUuid: workerProperties[0].uuid,
							}
						: { kind: "session-user", field: "commcare_location_id" },
				});
				return;
			case "table":
				if (columns[0]) setSource(columns[0].source);
				return;
			case "index":
				if (earlier[0])
					setSource({ kind, selection: earlier[0].uuid, identifier: "parent" });
				return;
			case "expression":
				setSource({
					kind,
					value: earlier[0]
						? term({
								kind: "session-datum",
								datum: { kind: "form-selection", selection: earlier[0].uuid },
							})
						: term({ kind: "session-context", field: "userid" }),
				});
				return;
		}
	};
	const under = src.kind === "choose" ? src.under : undefined;
	const prior = earlier.map((item) => ({ value: item.uuid, label: item.name }));
	const earlierUuid = (value: string) =>
		earlier.find((item) => item.uuid === value)?.uuid;
	const workerValue =
		src.kind === "worker-data"
			? src.property.kind === "session-user"
				? src.property.field
				: src.property.userPropertyUuid
			: undefined;
	const workerOptions = workerProperties.map((row) => ({
		value: row.uuid as string,
		label: row.label,
	}));
	if (workerValue && !workerOptions.some((o) => o.value === workerValue))
		workerOptions.push({ value: workerValue, label: workerValue });
	const dependents = controls.dependents(row.uuid);
	return (
		<div className="grid gap-3">
			<InlineField
				label="Name"
				value={row.name}
				required
				onChange={(name) => edit({ name })}
			/>
			<Picker
				label="Where the record comes from"
				options={options}
				value={src.kind}
				onChange={chooseSource}
			/>
			{src.kind === "choose" ? (
				<>
					<Picker
						label="Case list"
						options={menus.map((menu) => ({
							value: menu.uuid,
							label: menu.name,
						}))}
						value={src.module}
						onChange={(id) => {
							const menu = menus.find((m) => m.uuid === id);
							if (menu) setSource({ ...src, module: menu.uuid }, menu.caseType);
						}}
					/>
					{prior.length > 0 && (
						<Picker
							label="Narrow by an earlier record"
							options={[
								{ value: "all", label: "Show all matching records" },
								...prior,
							]}
							value={src.under?.selection ?? "all"}
							onChange={(id) => {
								const selection = earlierUuid(id);
								setSource(
									selection
										? {
												...src,
												under: {
													selection,
													identifier: src.under?.identifier ?? "parent",
													...(src.under?.relationship && {
														relationship: src.under.relationship,
													}),
												},
											}
										: { kind: "choose", module: src.module },
								);
							}}
						/>
					)}
					{under && (
						<>
							<InlineField
								label="Connection name"
								value={under.identifier}
								onChange={(identifier) =>
									edit({
										source: {
											...src,
											under: { ...under, identifier },
										},
									})
								}
							/>
							<Picker
								label="Saved connection kind"
								value={
									typeof under.relationship === "object"
										? under.relationship.question
										: (under.relationship ?? "child")
								}
								options={[
									{ value: "child", label: "Child" },
									{ value: "extension", label: "Extension" },
									...controls.connectionQuestions.map((question) => ({
										...question,
										label: `Answer to ${question.label}`,
									})),
								]}
								onChange={(value) => {
									const question = controls.connectionQuestions.find(
										(field) => field.value === value,
									);
									setSource({
										...src,
										under: {
											selection: under.selection,
											identifier: under.identifier,
											...(question
												? { relationship: { question: question.value } }
												: value === "extension"
													? { relationship: "extension" as const }
													: {}),
										},
									});
								}}
							/>
						</>
					)}
				</>
			) : (
				src.kind !== "worker-record" && (
					<Picker
						label="Expected record type"
						value={row.caseType}
						options={[...new Set([row.caseType, ...types])].map((type) => ({
							value: type,
							label: type,
						}))}
						onChange={(caseType) => edit({ caseType })}
					/>
				)
			)}
			{src.kind === "expression" && (
				<Formula
					label="Record ID formula"
					slot={{
						entity: "form",
						uuid: controls.form.uuid,
						slot: "form_selection_source",
						member: { supplyUuid: row.uuid },
					}}
					value={src.value}
					save={(value) => edit({ source: { kind: "expression", value } })}
				/>
			)}
			{src.kind === "table" && (
				<Picker
					label="Data table column"
					options={columns}
					value={src.column}
					onChange={(id) => {
						const found = columns.find((col) => col.value === id);
						if (found) setSource(found.source);
					}}
				/>
			)}
			{src.kind === "worker-data" && (
				<>
					<Picker
						label="Worker property"
						options={workerOptions}
						value={workerValue ?? ""}
						onChange={(id) => {
							const found = workerProperties.find((p) => p.uuid === id);
							if (found)
								setSource({
									...src,
									property: {
										kind: "session-user-property",
										userPropertyUuid: found.uuid,
									},
								});
						}}
					/>
					<InlineField
						label="External worker property"
						value={
							src.property.kind === "session-user" ? src.property.field : ""
						}
						onChange={(field) =>
							edit({
								source: { ...src, property: { kind: "session-user", field } },
							})
						}
					/>
				</>
			)}
			{src.kind === "index" && (
				<>
					<Picker
						label="Earlier record"
						options={prior}
						value={src.selection}
						onChange={(id) => {
							const selection = earlierUuid(id);
							if (selection) setSource({ ...src, selection });
						}}
					/>
					<InlineField
						label="Connection name"
						value={src.identifier}
						onChange={(identifier) => edit({ source: { ...src, identifier } })}
					/>
				</>
			)}
			{dependents.length > 0 && (
				<p className="text-xs text-nova-text-muted">
					Used by {dependents.join(", ")}
				</p>
			)}
			<OrderActions
				name={row.name}
				ids={choices.map((c) => c.uuid)}
				index={index}
				move={(after) =>
					save({ operation: "move-choice", uuid: row.uuid, after })
				}
				remove={() => save({ operation: "remove-choice", uuid: row.uuid })}
			/>
		</div>
	);
}

function EntryRow({ title, children }: { title: string; children: ReactNode }) {
	return (
		<li className="border-b border-white/[0.07] py-2 last:border-0">
			<details>
				<summary className="cursor-pointer text-sm font-medium text-nova-text">
					{title}
				</summary>
				<div className="mt-3">{children}</div>
			</details>
		</li>
	);
}

export function OpeningCasesSection({ formUuid }: { formUuid: Uuid }) {
	const controls = useFormEntryChoices(formUuid);
	const canEdit = useCanEdit();
	const [refusal, setRefusal] = useState("");
	const { form, choices, menus } = controls;
	if (!form) return null;
	const report = (outcome: CommitOutcome) => {
		setRefusal(outcome.ok ? "" : outcome.messages.join(" "));
		return outcome;
	};
	const save = (change: FormEntryChange) => report(controls.commit(change));
	const values = form.computedDatums ?? [];
	const listOptions = [
		...menus.map((menu) => ({ value: menu.uuid as string, label: menu.name })),
		{ value: "worker", label: "Worker’s own record" },
	];
	return (
		<section
			aria-label="Form opening"
			className="mb-6 max-w-2xl rounded-xl border border-white/[0.08] px-4 py-3"
		>
			<details>
				<summary className="cursor-pointer font-medium text-nova-text">
					Cases this form uses{" "}
					<span className="text-nova-text-muted">({choices.length})</span>
				</summary>
				<p className="mt-2 text-sm text-nova-text-muted">
					{form.caseSelections === undefined
						? "This form follows its menu’s case choices."
						: "The form opens these records in order."}
				</p>
				<ol>
					{choices.map((row, index) => (
						<EntryRow key={row.uuid} title={row.name}>
							{canEdit ? (
								<ChoiceEditor
									controls={controls}
									row={row}
									index={index}
									save={save}
								/>
							) : (
								<p>
									{sources[row.source.kind]} · {row.caseType}
								</p>
							)}
						</EntryRow>
					))}
				</ol>
				{canEdit && (
					<div className="mt-3 flex flex-wrap items-end gap-2">
						<Picker
							label="Add a record"
							options={[
								{ value: "new", label: "Choose a source" },
								...listOptions,
							]}
							value="new"
							onChange={(id) => {
								const menu = menus.find((m) => m.uuid === id);
								if (menu || id === "worker") report(controls.add(menu));
							}}
						/>
						{form.caseSelections !== undefined && (
							<Button
								variant="ghost"
								onClick={() => save({ operation: "use-menu-choices" })}
							>
								Follow menu choices
							</Button>
						)}
					</div>
				)}
			</details>
			<details className="mt-3">
				<summary className="cursor-pointer font-medium text-nova-text">
					Values calculated when the form opens{" "}
					<span className="text-nova-text-muted">({values.length})</span>
				</summary>
				<ol>
					{values.map((row, index) => (
						<EntryRow key={row.uuid} title={row.key}>
							{canEdit ? (
								<div className="grid gap-2">
									<InlineField
										label="Value name"
										value={row.key}
										required
										onChange={(key) =>
											save({
												operation: "edit-value",
												uuid: row.uuid,
												patch: { key },
											})
										}
									/>
									<Formula
										label="Opening formula"
										value={row.value}
										slot={{
											entity: "form",
											uuid: formUuid,
											slot: "form_entry_value",
											member: { supplyUuid: row.uuid },
										}}
										save={(value) =>
											save({
												operation: "edit-value",
												uuid: row.uuid,
												patch: { value },
											})
										}
									/>
									<OrderActions
										name={row.key}
										ids={values.map((v) => v.uuid)}
										index={index}
										move={(after) =>
											save({ operation: "move-value", uuid: row.uuid, after })
										}
										remove={() =>
											save({ operation: "remove-value", uuid: row.uuid })
										}
									/>
								</div>
							) : (
								<p>Calculated when this form opens</p>
							)}
						</EntryRow>
					))}
				</ol>
				{canEdit && (
					<Button
						className="mt-2"
						variant="outline"
						onClick={() =>
							save({
								operation: "add-value",
								value: {
									uuid: asUuid(uuidv4()),
									key: uniqueSlug(
										"opening_date",
										"opening_date",
										new Set(values.map((row) => row.key)),
									),
									value: { kind: "today" },
								},
							})
						}
					>
						Add opening date
					</Button>
				)}
			</details>
			{refusal && (
				<p role="alert" className="mt-2 text-sm text-nova-rose">
					{refusal}
				</p>
			)}
		</section>
	);
}
