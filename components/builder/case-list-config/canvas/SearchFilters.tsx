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
import { CANONICAL_STANDARD_CASE_PROPERTY_LABELS } from "@/lib/domain/standardCaseProperties";
import { newUuid } from "../uuid";
import { SearchResultOrder } from "./SearchResultOrder";

export type SearchFilterEdit = NonNullable<
	Extract<Mutation, { kind: "setCaseListMeta" }>["patch"]["searchFilterEdit"]
>;

interface Props {
	readonly moduleUuid: Uuid;
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
	const properties =
		caseTypes
			.find((type) => type.name === currentCaseType)
			?.properties.map((property) => ({
				value: property.name,
				label: projectProse(property.label) || property.name,
			})) ?? [];
	// The record's own information HQ's search index also holds
	// (`case_search/const.py::INDEXED_METADATA_BY_KEY`).
	for (const [value, label] of Object.entries(
		CANONICAL_STANDARD_CASE_PROPERTY_LABELS,
	))
		if (!properties.some((option) => option.value === value))
			properties.push({ value, label });
	const [adding, setAdding] = useState(false);
	const [text, setText] = useState("");
	const [chosen, setChosen] = useState<SearchFilterTarget>({
		kind: "record-id",
	});
	// New authoring offers the dedicated owner exclusion: HQ's editor shows it
	// to every project space. A default-filter spelling brought in from HQ
	// keeps its place and its own label below.
	const options: { label: string; target: SearchFilterTarget }[] = [
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
					properties={properties}
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
							properties={properties}
							onChange={(order) =>
								onEdit(
									order.length
										? { operation: "edit", uuid: row.uuid, patch: { order } }
										: { operation: "remove", uuid: row.uuid },
								)
							}
						/>
					) : (
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
											property: properties[0].value,
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
