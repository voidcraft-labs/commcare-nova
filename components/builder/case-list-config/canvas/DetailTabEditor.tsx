"use client";

import { useId, useRef, useState } from "react";
import { useBuilderLookupCatalog } from "@/components/builder/lookup/BuilderLookupCatalogProvider";
import {
	ConditionSlotEditor,
	ExpressionSlotEditor,
} from "@/components/builder/shared/ExpressionSlotEditors";
import { PredicateWorkbench } from "@/components/builder/shared/PredicateWorkbench";
import { Button } from "@/components/shadcn/button";
import { Checkbox } from "@/components/shadcn/checkbox";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/shadcn/dialog";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type { DetailTabGroup } from "@/lib/doc/caseDetailTabMutations";
import { deepEqual } from "@/lib/doc/deepEqual";
import { useExpressionSlotContext } from "@/lib/doc/hooks/useExpressionSlotContext";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type {
	CaseListConfig,
	CaseType,
	Column,
	UserProperty,
	Uuid,
} from "@/lib/domain";
import { detailTabSpans } from "@/lib/domain/detailTabs";
import { type Expression, matchAll, prop, term } from "@/lib/domain/expression";
import { expressionRowScope } from "@/lib/domain/expression/typeChecker";
import { propertyDisplayLabel } from "@/lib/domain/propertyDisplay";
import { newUuid } from "../uuid";
import { columnLabel } from "./ColumnInventory";
import { moveDraftField, setDraftRowSource } from "./detailTabDraft";

interface Props {
	moduleUuid: Uuid;
	caseTypes: readonly CaseType[];
	currentCaseType: string;
	userProperties: readonly UserProperty[];
	config: CaseListConfig;
	columns: readonly Column[];
	canEdit: boolean;
	onSave: (groups: readonly DetailTabGroup[]) => string | undefined;
}

export function DetailTabEditor({
	moduleUuid,
	caseTypes,
	currentCaseType,
	userProperties,
	config,
	columns,
	canEdit,
	onSave,
}: Props) {
	const [draft, setDraft] = useState<DetailTabGroup[] | null>(null);
	const id = useId();
	const [error, setError] = useState("");
	const firstFocus = useRef<Uuid | null>(null);
	const original = useRef<{
		tabs: CaseListConfig["detailTabs"];
		shown: Uuid[];
	} | null>(null);
	const spans = detailTabSpans(config.detailTabs ?? [], columns) ?? [];
	const groups = spans.map(({ tab, start, end }) => ({
		uuid: tab.uuid,
		title: tab.title,
		displayCondition: tab.displayCondition,
		rowSource: tab.rowSource,
		orderFields: tab.orderFields,
		fields: columns.slice(start, end).map((col) => col.uuid),
	}));
	const labels = new Map(columns.map((col) => [col.uuid, columnLabel(col)]));
	function open() {
		original.current = {
			tabs: config.detailTabs,
			shown: columns.map((c) => c.uuid),
		};
		setError("");
		if (groups.length) {
			setDraft(groups);
			return;
		}
		const first = {
			uuid: newUuid(),
			title: "Overview",
			fields: columns.map((col) => col.uuid),
		};
		setDraft([first]);
	}
	function moveGroup(index: number, step: number) {
		if (!draft || index + step < 0 || index + step >= draft.length) return;
		const ordered = [...draft];
		ordered.splice(index + step, 0, ...ordered.splice(index, 1));
		setDraft(ordered);
	}
	function moveField(uuid: Uuid, destination: Uuid) {
		if (!draft) return;
		setDraft(moveDraftField(draft, uuid, destination));
	}
	function save(groups: readonly DetailTabGroup[]) {
		if (
			!deepEqual(original.current, {
				tabs: config.detailTabs,
				shown: columns.map((c) => c.uuid),
			})
		) {
			setError(
				"The Details fields or tabs changed while you were editing. Close this dialog and reopen it to use the current layout.",
			);
			return;
		}
		const issue = onSave(groups);
		if (issue) setError(issue);
		else setDraft(null);
	}
	if (!columns.length) return null;
	return (
		<section className="mb-6" aria-label="Detail tabs">
			{groups.length > 0 && (
				<ul className="mb-2 flex flex-wrap gap-2" aria-label="Tabs in order">
					{groups.map((group) => (
						<li
							className="rounded-md bg-nova-panel px-2 py-1 text-sm"
							key={group.uuid}
						>
							{group.title}
						</li>
					))}
				</ul>
			)}
			{canEdit && (
				<Dialog
					open={draft !== null}
					onOpenChange={(next) => {
						if (next) open();
						else setDraft(null);
					}}
				>
					<DialogTrigger render={<Button variant="outline" />}>
						{groups.length ? "Edit tabs" : "Group fields into tabs"}
					</DialogTrigger>
					{draft && (
						<DialogContent className="sm:max-w-2xl">
							<DialogHeader>
								<DialogTitle>Detail tabs</DialogTitle>
								<DialogDescription>
									Each tab groups the fields a worker sees together when they
									open a case.
								</DialogDescription>
							</DialogHeader>
							<DialogBody className="space-y-4">
								{draft.map((group, index) => (
									<fieldset
										key={group.uuid}
										className="rounded-lg border border-nova-border p-3"
									>
										<legend className="px-1 text-sm font-semibold">
											{group.title || "New tab"}
										</legend>
										<div className="text-sm">
											Tab title
											<Input
												aria-label="Tab title"
												value={group.title}
												ref={(node) => {
													if (node && firstFocus.current === group.uuid) {
														firstFocus.current = null;
														node.focus();
													}
												}}
												onChange={(event) =>
													setDraft(
														draft.map((one) =>
															one.uuid === group.uuid
																? { ...one, title: event.target.value }
																: one,
														),
													)
												}
											/>
										</div>
										<div className="my-2 flex flex-wrap gap-1">
											<Button
												variant="ghost"
												disabled={index === 0}
												onClick={() => moveGroup(index, -1)}
											>
												Move earlier
											</Button>
											<Button
												variant="ghost"
												disabled={index === draft.length - 1}
												onClick={() => moveGroup(index, 1)}
											>
												Move later
											</Button>
											{draft.length > 1 && (
												<Button
													variant="ghost"
													onClick={() => {
														const recipient =
															draft[index === 0 ? 1 : index - 1];
														if (!recipient) return;
														setDraft(
															draft
																.filter((one) => one.uuid !== group.uuid)
																.map((one) =>
																	one.uuid !== recipient.uuid
																		? one
																		: {
																				...one,
																				newFields:
																					index === 0
																						? [
																								...(group.newFields ?? []),
																								...(one.newFields ?? []),
																							]
																						: [
																								...(one.newFields ?? []),
																								...(group.newFields ?? []),
																							],
																				fields:
																					index === 0
																						? [...group.fields, ...one.fields]
																						: [...one.fields, ...group.fields],
																			},
																),
														);
													}}
												>
													Join with {index === 0 ? "next" : "previous"} tab
												</Button>
											)}
										</div>
										<TabRowEditor
											firstShown={columns[0].uuid}
											group={group}
											moduleUuid={moduleUuid}
											caseTypes={caseTypes}
											currentCaseType={currentCaseType}
											userProperties={userProperties}
											onAddField={(header, expression) =>
												setDraft(
													draft.map((one) =>
														one.uuid === group.uuid
															? {
																	...one,
																	newFields: [
																		...(one.newFields ?? []),
																		{ uuid: newUuid(), header, expression },
																	],
																}
															: one,
													),
												)
											}
											onChange={(rowSource) =>
												setDraft(
													setDraftRowSource(draft, group.uuid, rowSource),
												)
											}
										/>
										<TabCondition
											firstShown={columns[0].uuid}
											group={group}
											moduleUuid={moduleUuid}
											currentCaseType={currentCaseType}
											caseTypes={caseTypes}
											userProperties={userProperties}
											onChange={(condition) =>
												setDraft(
													draft.map((one) =>
														one.uuid === group.uuid
															? { ...one, displayCondition: condition }
															: one,
													),
												)
											}
										/>
										<ul className="divide-y divide-nova-border">
											{group.fields.map((field) => (
												<li
													key={field}
													className="flex items-center justify-between gap-2 py-1 text-sm"
												>
													<span>{labels.get(field)}</span>
													{group.rowSource &&
														columns.some(
															(column) =>
																column.uuid === field &&
																(column.kind === "plain" ||
																	column.kind === "calculated"),
														) && (
															<label
																htmlFor={`${id}-order-${field}`}
																className="flex items-center gap-2 text-xs"
															>
																<Checkbox
																	id={`${id}-order-${field}`}
																	checked={
																		group.orderFields?.includes(field) ?? false
																	}
																	onCheckedChange={(checked) => {
																		setDraft(
																			draft.map((one) =>
																				one.uuid !== group.uuid
																					? one
																					: {
																							...one,
																							orderFields: one.fields.filter(
																								(uuid) =>
																									uuid === field
																										? checked
																										: one.orderFields?.includes(
																												uuid,
																											),
																							),
																						},
																			),
																		);
																	}}
																/>
																Use only for ordering
															</label>
														)}
													{draft.length > 1 && (
														<Select<Uuid>
															value={group.uuid}
															onValueChange={(value) => {
																if (value && value !== group.uuid)
																	moveField(field, value);
															}}
														>
															<SelectTrigger
																aria-label={`Tab for ${labels.get(field)}`}
															>
																<SelectValue>
																	{group.title || "New tab"}
																</SelectValue>
															</SelectTrigger>
															<SelectContent>
																{draft.map((one) => (
																	<SelectItem key={one.uuid} value={one.uuid}>
																		{one.title || "New tab"}
																	</SelectItem>
																))}
															</SelectContent>
														</Select>
													)}
												</li>
											))}
										</ul>
										{group.newFields?.map((field) => (
											<div
												className="flex items-center justify-between gap-2"
												key={field.uuid}
											>
												<span>{field.header}</span>
												<Button
													variant="ghost"
													onClick={() =>
														setDraft(
															draft.map((one) =>
																one.uuid === group.uuid
																	? {
																			...one,
																			newFields: one.newFields?.filter(
																				(v) => v.uuid !== field.uuid,
																			),
																		}
																	: one,
															),
														)
													}
												>
													Remove {field.header}
												</Button>
											</div>
										))}
										{!group.fields.length && !group.newFields?.length && (
											<p className="text-sm text-nova-text-muted">
												This tab needs a field. You can move one here from
												another tab.
											</p>
										)}
									</fieldset>
								))}
								<Button
									variant="outline"
									onClick={() => {
										const uuid = newUuid();
										firstFocus.current = uuid;
										setDraft([...draft, { uuid, title: "", fields: [] }]);
									}}
								>
									Add a tab
								</Button>
								{error && (
									<p role="alert" className="text-sm text-nova-text">
										{error}
									</p>
								)}
							</DialogBody>
							<DialogFooter>
								{groups.length > 0 && (
									<Button variant="ghost" onClick={() => save([])}>
										Show fields without tabs
									</Button>
								)}
								<Button variant="outline" onClick={() => setDraft(null)}>
									Cancel
								</Button>
								<Button
									disabled={draft.some(
										(group) =>
											!group.title.trim() ||
											(!group.fields.length && !group.newFields?.length),
									)}
									onClick={() => save(draft)}
								>
									Save tabs
								</Button>
							</DialogFooter>
						</DialogContent>
					)}
				</Dialog>
			)}
		</section>
	);
}

function TabCondition({
	group,
	firstShown,
	moduleUuid,
	currentCaseType,
	caseTypes,
	userProperties,
	onChange,
}: Pick<
	Props,
	"moduleUuid" | "currentCaseType" | "caseTypes" | "userProperties"
> & {
	group: DetailTabGroup;
	firstShown: Uuid;
	onChange: (value: Expression | null) => void;
}) {
	const anchor = group.fields[0] ?? group.newFields?.[0]?.uuid ?? firstShown;
	const context = useExpressionSlotContext(
		{
			entity: "module",
			uuid: moduleUuid,
			slot: "case_detail_tab_condition",
			member: { tabUuid: group.uuid },
		},
		anchor
			? {
					entity: "detail-tab",
					value: {
						uuid: group.uuid,
						title: group.title,
						startColumnUuid: anchor,
					},
				}
			: undefined,
	);
	if (!context) return null;
	if (!group.displayCondition)
		return (
			<Button variant="ghost" onClick={() => onChange(matchAll())}>
				Add a display condition
			</Button>
		);
	return (
		<div className="my-3">
			<p className="mb-2 text-sm font-medium">Show this tab when</p>
			<PredicateWorkbench
				expressionContext={context}
				value={group.displayCondition}
				caseTypes={caseTypes}
				currentCaseType={currentCaseType}
				userProperties={userProperties}
				onChange={onChange}
				onRemoveRoot={() => onChange(null)}
				removeRootLabel="Show for every case"
			/>
		</div>
	);
}

function TabRowEditor({
	group,
	firstShown,
	onAddField,
	moduleUuid,
	caseTypes,
	currentCaseType,
	userProperties,
	onChange,
}: Pick<
	Props,
	"moduleUuid" | "caseTypes" | "currentCaseType" | "userProperties"
> & {
	group: DetailTabGroup;
	firstShown: Uuid;
	onChange: (source: DetailTabGroup["rowSource"]) => void;
	onAddField: (header: string, expression: Expression) => void;
}) {
	const catalog = useBuilderLookupCatalog();
	const tables = catalog.kind === "ready" ? catalog.tables : [];
	const source = group.rowSource;
	const first = group.fields[0] ?? group.newFields?.[0]?.uuid ?? firstShown;
	const tableId =
		source?.kind === "records" && source.rows.kind === "table-rows"
			? source.rows.tableId
			: undefined;
	const table = tables.find((one) => one.id === tableId);
	const places = source?.kind === "records" && source.rows.kind === "locations";
	const selectedSource = table
		? table.id
		: places
			? "places"
			: (source?.kind ?? "selected");
	const candidate = first
		? {
				entity: "detail-tab" as const,
				value: {
					uuid: group.uuid,
					title: group.title,
					startColumnUuid: first,
					...(source && { rowSource: source }),
				},
			}
		: undefined;
	const rowsContext = useExpressionSlotContext(
		candidate
			? {
					entity: "module",
					uuid: moduleUuid,
					slot: "case_detail_tab_rows",
					member: { tabUuid: group.uuid },
				}
			: undefined,
		candidate,
	);
	const rowScope =
		source?.kind === "records" && rowsContext
			? expressionRowScope(source.rows, rowsContext)
			: undefined;
	const rowType =
		source?.kind === "children"
			? source.caseType
			: rowScope?.kind === "case"
				? rowScope.caseType
				: undefined;
	const properties = caseTypes.find(
		(type) => type.name === rowType,
	)?.properties;
	const projectProse = useProseProjection();
	const common = { caseTypes, currentCaseType, userProperties, candidate };
	return (
		<section className="my-3 space-y-2">
			<div className="grid gap-1 text-sm">
				Records in this tab
				<Select<string>
					value={selectedSource}
					onValueChange={(kind) => {
						if (kind === "selected") onChange(null);
						else if (kind === "children")
							onChange({ kind, caseType: currentCaseType });
						else if (kind === "places")
							onChange({
								kind: "records",
								rows: { kind: "locations", where: [] },
							});
						else if (tables.some((one) => one.id === kind)) {
							const table = tables.find((one) => one.id === kind);
							if (table)
								onChange({
									kind: "records",
									rows: { kind: "table-rows", tableId: table.id, where: [] },
								});
						} else if (kind === "records")
							onChange({
								kind,
								rows: {
									kind: "cases",
									source: "casedb",
									where: [
										{
											kind: "eq",
											left: { kind: "term", term: { kind: "case-row-type" } },
											right: {
												kind: "term",
												term: { kind: "case-type", caseType: currentCaseType },
											},
										},
									],
								},
							});
					}}
				>
					<SelectTrigger aria-label="Records in this tab">
						<SelectValue>
							{source?.kind === "children"
								? "Open child cases"
								: source?.kind === "records"
									? (table?.name ?? (places ? "Places" : "Other cases"))
									: "The selected case"}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="selected">The selected case</SelectItem>
						<SelectItem value="children">Open child cases</SelectItem>
						<SelectItem value="records">Other cases</SelectItem>
						<SelectItem value="places">Places</SelectItem>
						{tables.map((table) => (
							<SelectItem key={table.id} value={table.id}>
								{table.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{source?.kind === "children" && (
				<>
					<div className="grid gap-1 text-sm">
						Child record type
						<Select<string>
							value={source.caseType}
							onValueChange={(caseType) => {
								if (caseType) onChange({ ...source, caseType });
							}}
						>
							<SelectTrigger aria-label="Child record type">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{caseTypes.map((type) => (
									<SelectItem key={type.name} value={type.name}>
										{type.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{source.condition && candidate ? (
						<ConditionSlotEditor
							{...common}
							currentCaseType={source.caseType}
							slot={{
								entity: "module",
								uuid: moduleUuid,
								slot: "case_detail_tab_filter",
								member: { tabUuid: group.uuid },
							}}
							value={source.condition}
							onChange={(condition) => onChange({ ...source, condition })}
							onRemoveRoot={() =>
								onChange({ kind: "children", caseType: source.caseType })
							}
							removeRootLabel="Show all open child cases"
						/>
					) : (
						<Button
							variant="ghost"
							onClick={() => onChange({ ...source, condition: matchAll() })}
						>
							Filter child records
						</Button>
					)}
				</>
			)}
			{rowType && properties && (
				<div className="grid gap-1 text-sm">
					Add information from these cases
					<Select<string>
						value={null}
						onValueChange={(name) => {
							const property = properties.find((one) => one.name === name);
							if (property)
								onAddField(
									propertyDisplayLabel(property, projectProse),
									term(prop(rowType, property.name)),
								);
						}}
					>
						<SelectTrigger aria-label="Add information from these cases">
							<SelectValue placeholder="Choose case information" />
						</SelectTrigger>
						<SelectContent>
							{properties.map((property) => (
								<SelectItem key={property.name} value={property.name}>
									{propertyDisplayLabel(property, projectProse)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}
			{table && (
				<div className="grid gap-1 text-sm">
					Add a table field
					<Select<string>
						value={null}
						onValueChange={(id) => {
							const col = table.columns.find((one) => one.id === id);
							if (col)
								onAddField(col.label, {
									kind: "term",
									term: {
										kind: "table-column",
										tableId: table.id,
										columnId: col.id,
									},
								});
						}}
					>
						<SelectTrigger aria-label="Add a table field">
							<SelectValue placeholder="Choose a column" />
						</SelectTrigger>
						<SelectContent>
							{table.columns.map((c) => (
								<SelectItem key={c.id} value={c.id}>
									{c.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}
			{places && (
				<Button
					variant="outline"
					onClick={() =>
						onAddField("Place", {
							kind: "term",
							term: { kind: "location-field", field: "name" },
						})
					}
				>
					Add place name
				</Button>
			)}
			{source?.kind === "records" && (
				<div className="grid gap-1 text-sm">
					Child cases to include in Search
					<Select<string>
						value={source.includeChildrenOfType ?? ""}
						onValueChange={(value) => {
							const { includeChildrenOfType: _previous, ...collection } =
								source;
							onChange(
								value
									? { ...collection, includeChildrenOfType: value }
									: collection,
							);
						}}
					>
						<SelectTrigger aria-label="Child cases to include in Search">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="">No additional child cases</SelectItem>
							{caseTypes.map((type) => (
								<SelectItem key={type.name} value={type.name}>
									{type.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}
			{source?.kind === "records" && candidate && (
				<ExpressionSlotEditor
					{...common}
					slot={{
						entity: "module",
						uuid: moduleUuid,
						slot: "case_detail_tab_rows",
						member: { tabUuid: group.uuid },
					}}
					value={source.rows}
					onChange={(rows) => onChange({ ...source, rows })}
				/>
			)}
		</section>
	);
}
