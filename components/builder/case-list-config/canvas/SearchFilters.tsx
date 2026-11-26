"use client";

import { useState } from "react";
import { ExpressionSlotEditor } from "@/components/builder/shared/ExpressionSlotEditors";
import type { EditorSearchInputDecl } from "@/components/builder/shared/searchInputPresentation";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { Mutation } from "@/lib/doc/types";
import type {
	CaseType,
	SearchFilter,
	SearchFilterTarget,
	UserProperty,
	Uuid,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression";
import { isOrdinaryCaseSearchConfig } from "@/lib/domain/modules";
import {
	CANONICAL_STANDARD_CASE_PROPERTY_LABELS,
	isDeviceOnlyCaseProperty,
} from "@/lib/domain/standardCaseProperties";
import { newUuid } from "../uuid";
import { SearchResultOrder } from "./SearchResultOrder";

export type SearchFilterEdit = NonNullable<
	Extract<Mutation, { kind: "setCaseListMeta" }>["patch"]["searchFilterEdit"]
>;

interface Props {
	readonly moduleUuid: Uuid;
	readonly requestedTypes: readonly string[];
	readonly filters: readonly SearchFilter[];
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly EditorSearchInputDecl[];
	readonly userProperties: readonly UserProperty[];
	readonly canEdit: boolean;
	readonly onEdit: (change: SearchFilterEdit) => void;
}

export function SearchFilters({
	moduleUuid,
	filters,
	requestedTypes,
	caseTypes,
	currentCaseType,
	knownInputs,
	userProperties,
	canEdit,
	onEdit,
}: Props) {
	const projectProse = useProseProjection();
	const module = useModule(moduleUuid);
	const { commitMany } = useBlueprintMutations();
	const search = isOrdinaryCaseSearchConfig(module?.caseSearchConfig)
		? module.caseSearchConfig
		: undefined;
	const propertyOptions = new Map<string, { value: string; label: string }>();
	for (const type of caseTypes) {
		if (!requestedTypes.includes(type.name)) continue;
		for (const property of type.properties)
			if (!propertyOptions.has(property.name))
				propertyOptions.set(property.name, {
					value: property.name,
					label: projectProse(property.label) || property.name,
				});
	}
	const relatedProperties = [...propertyOptions.keys()].filter(
		(property) => !isDeviceOnlyCaseProperty(property),
	);
	const properties = [...propertyOptions.values()];
	// The record's own indexed information also works for every type.
	for (const [value, label] of Object.entries(
		CANONICAL_STANDARD_CASE_PROPERTY_LABELS,
	))
		if (!propertyOptions.has(value)) properties.push({ value, label });
	const orderProperties = properties.filter(
		({ value }) => !isDeviceOnlyCaseProperty(value),
	);
	const [adding, setAdding] = useState(false);
	const [text, setText] = useState("");
	const [chosen, setChosen] = useState<SearchFilterTarget>({
		kind: "record-id",
	});
	// New authoring offers the dedicated owner exclusion: HQ's editor shows it
	// to every project space. A default-filter spelling brought in from HQ
	// keeps its place and its own label below.
	const options: { label: string; target: SearchFilterTarget }[] = [
		{
			label: "Include related records when a value is present",
			target: { kind: "include-related-records" },
		},
		{ label: "Record ID", target: { kind: "record-id" } },
		{ label: "Record owner", target: { kind: "owner" } },
		{
			label: "Owners to leave out of Search",
			target: { kind: "excluded-owners", placement: "search-setting" },
		},
		{ label: "Project space", target: { kind: "project-space" } },
		{ label: "Record name", target: { kind: "record-name" } },
	];
	const seen = new Set<string>();
	const ancestors: { identifier: string; throughCaseType: string }[] = [];
	let type = caseTypes.find((t) => t.name === currentCaseType);
	while (type && !seen.has(type.name)) {
		seen.add(type.name);
		const via =
			ancestors.length === 0
				? {}
				: {
						ancestors: [ancestors[0], ...ancestors.slice(1)] as [
							(typeof ancestors)[number],
							...typeof ancestors,
						],
					};
		const relatedLabel = (label: string) =>
			ancestors.length ? `${type?.name} · ${label}` : label;
		if (ancestors.length)
			options.push({
				label: relatedLabel("Record name"),
				target: { kind: "record-name", ...via },
			});
		for (const [attribute, label] of [
			["id", "Record ID attribute"],
			["owner", "Owner attribute"],
			["type", "Record type"],
			["status", "Open or closed"],
		] as const) {
			options.push({
				label: relatedLabel(label),
				target: { kind: "attribute", attribute, ...via },
			});
		}
		for (const property of type.properties) {
			const label = projectProse(property.label) || property.name;
			if (!ancestors.length && ["case_id", "owner_id"].includes(property.name))
				continue;
			options.push({
				label: ancestors.length ? `${type.name} · ${label}` : label,
				target: {
					kind: "property",
					property: property.name,
					...via,
				},
			});
		}
		if (!type.parent_type) break;
		if (!ancestors.length)
			options.push({
				label: `Link to ${type.parent_type}`,
				target: { kind: "link", identifier: "parent" },
			});
		ancestors.push({ identifier: "parent", throughCaseType: type.parent_type });
		const parentType: string = type.parent_type;
		type = caseTypes.find((t) => t.name === parentType);
	}
	const labelFor = (target: SearchFilterTarget) =>
		options.find((o) => JSON.stringify(o.target) === JSON.stringify(target))
			?.label ??
		(target.kind === "property"
			? [
					...(target.ancestors ?? []).map((s) => s.identifier),
					target.property,
				].join(" · ")
			: target.kind === "link"
				? `Link · ${target.identifier}`
				: target.kind === "excluded-owners"
					? "Owners to leave out, as a search filter"
					: target.kind);
	function picker(
		target: SearchFilterTarget,
		setTarget: (t: SearchFilterTarget) => void,
	) {
		const displayed = options.some(
			(o) => JSON.stringify(o.target) === JSON.stringify(target),
		)
			? options
			: [...options, { label: labelFor(target), target }];
		return (
			<Select
				value={JSON.stringify(target)}
				onValueChange={(key) => {
					const picked = displayed.find(
						(option) => JSON.stringify(option.target) === key,
					);
					if (picked) setTarget(picked.target);
				}}
			>
				<SelectTrigger aria-label="Information to match">
					<SelectValue>{labelFor(target)}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{displayed.map((option) => (
						<SelectItem
							key={JSON.stringify(option.target)}
							value={JSON.stringify(option.target)}
						>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		);
	}

	function settingPicker(
		label: string,
		options: readonly string[],
		value: string | undefined,
		onPick: (value: string) => void,
	) {
		const choices = [...new Set([...options, ...(value ? [value] : [])])];
		return (
			<Select
				value={value ?? ""}
				onValueChange={(picked) => {
					if (picked) onPick(picked);
				}}
			>
				<SelectTrigger aria-label={label}>
					<SelectValue>{value || label}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{choices.map((option) => (
						<SelectItem key={option} value={option}>
							{option}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		);
	}
	return (
		<section
			aria-label="Search filters"
			className="space-y-3 border-t border-white/[0.07] p-3"
		>
			<h3 className="text-sm font-semibold">Search filters</h3>
			<p className="text-xs text-nova-text-secondary">
				Match record information using the project space’s search settings.
			</p>
			<fieldset disabled={!canEdit} className="space-y-2">
				<legend className="text-sm font-medium">
					Which matches arrive first
				</legend>
				<p className="text-xs text-nova-text-secondary">
					When Search finds more matches than it can send, this order decides
					which records reach the worker. This setting uses advanced case search
					in your project space.
				</p>
				<SearchResultOrder
					order={search?.requestOrder ?? []}
					properties={orderProperties}
					onChange={(order) =>
						commitMany([
							{
								kind: "updateModule",
								uuid: moduleUuid,
								patch: {},
								caseSearchConfigPatch: {
									requestOrder: order.length ? order : null,
								},
							},
						])
					}
				/>
			</fieldset>
			{filters.map((row, index) => (
				<fieldset
					disabled={!canEdit}
					key={row.uuid}
					className="space-y-2 rounded-lg border border-white/[0.07] p-3"
				>
					{"order" in row ? (
						<SearchResultOrder
							order={row.order}
							properties={orderProperties}
							onChange={(order) =>
								onEdit(
									order.length
										? { operation: "edit", uuid: row.uuid, patch: { order } }
										: { operation: "remove", uuid: row.uuid },
								)
							}
						/>
					) : "target" in row ? (
						<>
							{picker(row.target, (target) =>
								onEdit({
									operation: "edit",
									uuid: row.uuid,
									patch: { target },
								}),
							)}
							<ExpressionSlotEditor
								slot={{
									entity: "module",
									uuid: moduleUuid,
									slot: "search_filter_value",
									member: { filterUuid: row.uuid },
								}}
								value={row.value}
								caseTypes={caseTypes}
								currentCaseType={currentCaseType}
								knownInputs={knownInputs}
								userProperties={userProperties}
								onChange={(value) =>
									onEdit({
										operation: "edit",
										uuid: row.uuid,
										patch: { value },
									})
								}
								constraint={{ accepts: "any" }}
							/>
						</>
					) : row.kind === "request-record-type" ? (
						settingPicker(
							"Record type to include in the search request",
							caseTypes.map((type) => type.name),
							row.caseType,
							(caseType) =>
								onEdit({
									operation: "replace",
									uuid: row.uuid,
									filter: { ...row, caseType },
								}),
						)
					) : (
						settingPicker(
							"Property holding the related record ID",
							relatedProperties,
							row.property,
							(property) =>
								onEdit({
									operation: "replace",
									uuid: row.uuid,
									filter: { ...row, property },
								}),
						)
					)}
					<div className="flex flex-wrap gap-2">
						{index > 0 && (
							<Button
								type="button"
								variant="ghost"
								onClick={() =>
									onEdit({
										operation: "move",
										uuid: row.uuid,
										after: filters[index - 2]?.uuid ?? null,
									})
								}
							>
								Move up
							</Button>
						)}
						{index + 1 < filters.length && (
							<Button
								type="button"
								variant="ghost"
								onClick={() =>
									onEdit({
										operation: "move",
										uuid: row.uuid,
										after: filters[index + 1].uuid,
									})
								}
							>
								Move down
							</Button>
						)}
						<Button
							type="button"
							variant="ghost"
							onClick={() => onEdit({ operation: "remove", uuid: row.uuid })}
						>
							Remove filter
						</Button>
					</div>
				</fieldset>
			))}
			{canEdit && (
				<div className="space-y-1">
					<Button
						variant="ghost"
						type="button"
						onClick={() =>
							onEdit({
								operation: "add",
								filter: {
									uuid: newUuid(),
									kind: "order",
									order: [
										{
											property: orderProperties[0]?.value ?? "case_name",
											comparison: "text",
											direction: "ascending",
										},
									],
								},
							})
						}
					>
						Add order as a search filter
					</Button>
					<p className="text-xs text-nova-text-secondary">
						An order among the search filters works without advanced case
						search. The server applies it before the order above.
					</p>
				</div>
			)}

			{canEdit &&
				settingPicker(
					"Include another record type in the request",
					caseTypes.map((type) => type.name),
					undefined,
					(caseType) =>
						onEdit({
							operation: "add",
							filter: {
								uuid: newUuid(),
								kind: "request-record-type",
								caseType,
							},
						}),
				)}
			{canEdit &&
				relatedProperties.length > 0 &&
				!filters.some(
					(row) => "kind" in row && row.kind === "related-record-id",
				) &&
				settingPicker(
					"Include the record named by a property",
					relatedProperties,
					undefined,
					(property) =>
						onEdit({
							operation: "add",
							filter: { uuid: newUuid(), kind: "related-record-id", property },
						}),
				)}
			{canEdit &&
				(adding ? (
					<div className="space-y-2">
						{picker(chosen, setChosen)}
						<Input
							aria-label="Value to match"
							placeholder="Value to match"
							value={text}
							onChange={(e) => setText(e.target.value)}
						/>
						<div className="flex gap-2">
							<Button
								type="button"
								onClick={() => {
									onEdit({
										operation: "add",
										filter: {
											uuid: newUuid(),
											target: chosen,
											value: term(literal(text)),
										},
									});
									setText("");
									setAdding(false);
								}}
							>
								Add filter
							</Button>
							<Button
								type="button"
								variant="ghost"
								onClick={() => setAdding(false)}
							>
								Cancel
							</Button>
						</div>
					</div>
				) : (
					<Button
						type="button"
						variant="outline"
						onClick={() => setAdding(true)}
					>
						Add search filter
					</Button>
				))}
		</section>
	);
}
