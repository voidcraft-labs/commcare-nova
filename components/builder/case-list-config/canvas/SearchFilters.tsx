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
import { newUuid } from "../uuid";

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
	const [adding, setAdding] = useState(false);
	const [text, setText] = useState("");
	const [chosen, setChosen] = useState<SearchFilterTarget>({
		kind: "record-id",
	});
	const options: { label: string; target: SearchFilterTarget }[] = [
		{ label: "Record ID", target: { kind: "record-id" } },
		{ label: "Record owner", target: { kind: "owner" } },
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
			{filters.map((row, index) => (
				<fieldset
					disabled={!canEdit}
					key={row.uuid}
					className="space-y-2 rounded-lg border border-white/[0.07] p-3"
				>
					{picker(row.target, (target) =>
						onEdit({ operation: "edit", uuid: row.uuid, patch: { target } }),
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
							onEdit({ operation: "edit", uuid: row.uuid, patch: { value } })
						}
						constraint={{ accepts: "any" }}
					/>
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
