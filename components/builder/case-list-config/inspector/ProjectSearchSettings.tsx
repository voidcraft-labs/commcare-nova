"use client";

import { useId, useState } from "react";
import { ExpressionSlotEditor } from "@/components/builder/shared/ExpressionSlotEditors";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { Button } from "@/components/shadcn/button";
import {
	Field,
	FieldDescription,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useAppSettings } from "@/lib/doc/hooks/useAppSettings";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useUserProperties } from "@/lib/doc/hooks/useUserCollections";
import { projectSearchEditBatch } from "@/lib/doc/projectSearchEdits";
import { literal, term } from "@/lib/domain/expression/builders";
import {
	type OrdinaryCaseSearchConfig,
	projectSearchOf,
} from "@/lib/domain/modules";
import { asUuid, type Uuid } from "@/lib/domain/uuid";
import { useCanEdit } from "@/lib/session/hooks";
import { newUuid } from "../uuid";
import type { SearchPanelInspectorBodyProps } from "./SearchPanelInspectorBody";

type Defaults = NonNullable<
	OrdinaryCaseSearchConfig["projectSearch"]
>["defaults"];
export function ProjectSearchSettings({
	moduleUuid,
	value,
	caseTypes,
	currentCaseType,
	knownInputs,
}: {
	moduleUuid: Uuid;
} & Pick<
	SearchPanelInspectorBodyProps,
	"value" | "caseTypes" | "currentCaseType" | "knownInputs"
>) {
	const api = useBlueprintDocApi();
	const { commitMany } = useBlueprintMutations();
	const editable = useCanEdit();
	const settings = useAppSettings();
	const userProperties = useUserProperties();
	const labelId = useId();
	const active = value?.projectSearch;
	const [choice, setChoice] = useState<string>();
	const [newName, setNewName] = useState("");
	const [newKey, setNewKey] = useState("");
	const [newValue, setNewValue] = useState("");
	const [properties, setProperties] = useState<Record<string, string>>({});
	const [error, setError] = useState("");
	const [removing, setRemoving] = useState<string>();
	const selected = choice ?? active?.searchUuid ?? "ordinary";
	const searches = Object.entries(settings.projectSearches ?? {});
	const items = [
		{ value: "ordinary", label: "Ordinary case search" },
		...searches.map(([uuid, search]) => ({ value: uuid, label: search.name })),
		{ value: "create", label: "New project space search" },
	];
	const changing = selected !== (active?.searchUuid ?? "ordinary");
	const doc = api.getState();
	const fields = doc.modules[moduleUuid]?.caseListConfig?.searchInputs ?? [];
	const used = new Set(
		Object.values(doc.modules).map(
			(module) => projectSearchOf(module)?.searchUuid,
		),
	);
	const unused = searches.filter(([uuid]) => !used.has(asUuid(uuid)));
	const propertyNames =
		caseTypes
			.find((type) => type.name === currentCaseType)
			?.properties.map((property) => property.name) ?? [];
	const send = (change: Parameters<typeof projectSearchEditBatch>[2]) => {
		try {
			const result = commitMany(
				projectSearchEditBatch(api.getState(), moduleUuid, change),
			);
			if (!result.ok) {
				setError(result.messages.join(" "));
				return false;
			}
			setError("");
			return true;
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: "Nova couldn't change the search. Review the fields and try again.",
			);
			return false;
		}
	};
	const update = (edit: (existing: Defaults) => Defaults) => {
		const current = projectSearchOf(api.getState().modules[moduleUuid]);
		if (!current || current.searchUuid !== active?.searchUuid) {
			setError(
				"The menu's search changed. Review its current values before editing.",
			);
			return false;
		}
		return send({
			kind: "project",
			destination: { kind: "existing", uuid: current.searchUuid },
			defaults: edit(current.defaults),
			replaceFieldMatching: false,
		});
	};
	const addValue = () => ({
		uuid: newUuid(),
		name: newKey.trim(),
		value: term(literal(newValue)),
	});
	const confirm = () => {
		const seed = newKey.trim() ? [addValue()] : [];
		const done =
			selected === "ordinary"
				? send({
						kind: "ordinary",
						properties: new Map(
							Object.entries(properties).map(([key, val]) => [
								asUuid(key),
								val,
							]),
						),
					})
				: send({
						kind: "project",
						destination:
							selected === "create"
								? { kind: "create", uuid: newUuid(), name: newName.trim() }
								: { kind: "existing", uuid: asUuid(selected) },
						defaults: [...(active?.defaults ?? []), ...seed],
						replaceFieldMatching: true,
					});
		if (done) {
			setChoice(undefined);
			setNewName("");
			setNewKey("");
			setNewValue("");
		}
	};
	const parameterFields = (
		<div className="grid gap-2">
			<Field>
				<FieldLabel htmlFor={labelId + "-key"}>
					Name sent to the search
				</FieldLabel>
				<Input
					id={labelId + "-key"}
					value={newKey}
					onChange={(event) => setNewKey(event.target.value)}
				/>
			</Field>
			<Field>
				<FieldLabel htmlFor={labelId + "-value"}>Value</FieldLabel>
				<Input
					id={labelId + "-value"}
					value={newValue}
					onChange={(event) => setNewValue(event.target.value)}
				/>
			</Field>
		</div>
	);
	return (
		<FieldSet disabled={!editable}>
			<FieldLegend>Where matches come from</FieldLegend>
			<Field>
				<FieldLabel htmlFor={labelId}>Search source</FieldLabel>
				<Select
					value={selected}
					items={items}
					onValueChange={(next) => {
						setChoice(next ?? undefined);
						setError("");
					}}
				>
					<SelectTrigger id={labelId}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{items.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Field>
			{changing && (
				<>
					{selected === "create" && (
						<Field>
							<FieldLabel htmlFor={labelId + "-name"}>Search name</FieldLabel>
							<Input
								id={labelId + "-name"}
								value={newName}
								onChange={(event) => setNewName(event.target.value)}
							/>
						</Field>
					)}
					{selected !== "ordinary" ? (
						<>
							<FieldDescription>
								The project space decides which cases match. Each search field
								keeps its question and sends its answer. Any matching rules on
								those fields will be replaced.
							</FieldDescription>
							{!fields.length && !active?.defaults.length && parameterFields}
						</>
					) : (
						<>
							<FieldDescription>
								The menu will match each answer against a case property. Named
								values sent only to the project space will be removed from this
								menu.
							</FieldDescription>
							{fields
								.filter((field) => field.kind === "parameter")
								.map((field) => (
									<Field key={field.uuid}>
										<FieldLabel htmlFor={labelId + field.uuid}>
											{field.label || field.name}
										</FieldLabel>
										<Select
											value={properties[field.uuid] ?? ""}
											items={propertyNames.map((name) => ({
												value: name,
												label: name,
											}))}
											onValueChange={(next) =>
												setProperties((prior) => ({
													...prior,
													[field.uuid]: next ?? "",
												}))
											}
										>
											<SelectTrigger id={labelId + field.uuid}>
												<SelectValue placeholder="Choose a case property" />
											</SelectTrigger>
											<SelectContent>
												{propertyNames.map((name) => (
													<SelectItem key={name} value={name}>
														{name}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</Field>
								))}
						</>
					)}
					<Button type="button" variant="outline" onClick={confirm}>
						Use this search
					</Button>
				</>
			)}
			{!changing && active && (
				<>
					<FieldDescription>
						Workers see the matches returned by the connected project space.
						Changing that service in CommCare HQ changes the results in
						installed apps. You can choose its search ID when publishing.
					</FieldDescription>
					<Field>
						<FieldLabel>Search name in this app</FieldLabel>
						<BlurCommitTextInput
							ariaLabel="Search name in this app"
							value={settings.projectSearches?.[active.searchUuid]?.name ?? ""}
							onCommit={(name) =>
								send({ kind: "rename", uuid: active.searchUuid, name })
							}
						/>
					</Field>
					{active.defaults.map((row, index) => (
						<Field key={row.uuid}>
							<FieldLabel>Named value</FieldLabel>
							<BlurCommitTextInput
								ariaLabel="Name sent to the search"
								value={row.name}
								onCommit={(name) =>
									update((rows) =>
										rows.map((item) =>
											item.uuid === row.uuid ? { ...item, name } : item,
										),
									)
								}
							/>
							<ExpressionSlotEditor
								slot={{
									entity: "module",
									uuid: moduleUuid,
									slot: "project_search_parameter",
									member: { parameterUuid: row.uuid },
								}}
								value={row.value}
								onChange={(next) =>
									update((rows) =>
										rows.map((item) =>
											item.uuid === row.uuid ? { ...item, value: next } : item,
										),
									)
								}
								caseTypes={caseTypes}
								currentCaseType={currentCaseType}
								knownInputs={knownInputs ?? []}
								userProperties={userProperties}
								constraint={{ accepts: "any" }}
							/>
							<div className="flex gap-2">
								{index > 0 && (
									<Button
										type="button"
										variant="ghost"
										aria-label={"Move " + row.name + " up"}
										onClick={() =>
											update((rows) => {
												const position = rows.findIndex(
													(item) => item.uuid === row.uuid,
												);
												if (position <= 0) return rows;
												const reordered = [...rows];
												reordered.splice(
													position - 1,
													0,
													...reordered.splice(position, 1),
												);
												return reordered;
											})
										}
									>
										Move up
									</Button>
								)}
								<Button
									type="button"
									variant="ghost"
									aria-label={"Remove " + row.name}
									onClick={() =>
										update((rows) =>
											rows.filter((item) => item.uuid !== row.uuid),
										)
									}
								>
									Remove
								</Button>
							</div>
						</Field>
					))}
					{parameterFields}
					<Button
						type="button"
						variant="outline"
						disabled={!newKey.trim()}
						onClick={() => {
							if (update((rows) => [...rows, addValue()])) {
								setNewKey("");
								setNewValue("");
							}
						}}
					>
						Add named value
					</Button>
				</>
			)}
			{unused.length > 0 && (
				<details>
					<summary>Searches unused in this app</summary>
					{unused.map(([uuid, entry]) => (
						<div key={uuid} className="flex items-center justify-between gap-2">
							<span>{entry.name}</span>
							{removing === uuid ? (
								<>
									<Button
										type="button"
										variant="outline"
										onClick={() => {
											if (send({ kind: "remove", uuid: asUuid(uuid) }))
												setRemoving(undefined);
										}}
									>
										Remove from app
									</Button>
									<Button
										type="button"
										variant="ghost"
										onClick={() => setRemoving(undefined)}
									>
										Cancel
									</Button>
								</>
							) : (
								<Button
									type="button"
									variant="ghost"
									onClick={() => setRemoving(uuid)}
								>
									Remove
								</Button>
							)}
						</div>
					))}
				</details>
			)}
			{error && <p role="alert">{error}</p>}
		</FieldSet>
	);
}
