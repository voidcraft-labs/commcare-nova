"use client";

import { useId, useMemo } from "react";
import { buildEditorTypeContext } from "@/components/builder/shared/editorTypeContext";
import type { EditorFormFieldDecl } from "@/components/builder/shared/formFieldPresentation";
import type { EditorLookupTableDecl } from "@/components/builder/shared/lookupTablePresentation";
import { PredicateWorkbench } from "@/components/builder/shared/PredicateWorkbench";
import { Button } from "@/components/shadcn/button";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@/components/shadcn/field";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import {
	type CaseOptionsSource,
	type CaseType,
	caseSelectionCardinality,
	type Form,
	formOpensWithOneCase,
	type Module,
	reachableCaseTypes,
	type UserProperty,
} from "@/lib/domain";
import {
	and,
	checkPredicate,
	eq,
	exists,
	matchAll,
	type Predicate,
	prop,
	term,
} from "@/lib/domain/predicate";
import { propertyDisplayLabel } from "@/lib/domain/propertyDisplay";
import { useCanEdit } from "@/lib/session/hooks";
import { freshCaseSource } from "./optionsSourceModel";

export function CaseOptionsEditor({
	source,
	caseTypes,
	formContext,
	formFields,
	userProperties,
	tables,
	staged,
	onChange,
	onCommit,
	onCancel,
}: {
	source: CaseOptionsSource;
	caseTypes: readonly CaseType[];
	formContext: { form: Form; module: Module } | null;
	formFields: readonly EditorFormFieldDecl[];
	userProperties: readonly UserProperty[];
	tables: readonly EditorLookupTableDecl[];
	staged: boolean;
	onChange: (next: CaseOptionsSource) => void;
	onCommit: () => void;
	onCancel: () => void;
}) {
	const canEdit = useCanEdit();
	const project = useProseProjection();
	const typeId = useId();
	const labelId = useId();
	const type = caseTypes.find((type) => type.name === source.caseType);
	const labelProperty = type?.properties.find(
		(property) => property.name === source.labelProperty,
	);
	const selectedType =
		formContext &&
		formOpensWithOneCase(
			formContext.form.type,
			caseSelectionCardinality(formContext.module),
		)
			? formContext.module.caseType
			: undefined;
	const formCaseTypes = useMemo(
		() =>
			new Set(
				reachableCaseTypes(selectedType, caseTypes).map((type) => type.name),
			),
		[selectedType, caseTypes],
	);
	const setFilter = (filter: Predicate | undefined) => {
		const { filter: _old, ...identity } = source;
		onChange(filter === undefined ? identity : { ...identity, filter });
	};
	const typeContext = buildEditorTypeContext({
		caseTypes,
		currentCaseType: source.caseType,
		formCaseTypes,
		formFields,
		userProperties,
		knownInputs: [],
		lookupTables: tables,
	});
	const valid =
		type?.properties.some(
			(property) => property.name === source.labelProperty,
		) &&
		(source.filter === undefined ||
			checkPredicate(source.filter, typeContext).ok);
	return (
		<FieldGroup>
			<FieldDescription>
				Choices come from cases available to this worker. A filter narrows those
				cases; it doesn't fetch more or change access.
			</FieldDescription>
			<Field>
				<FieldLabel htmlFor={typeId}>Record type</FieldLabel>
				<Select
					value={source.caseType}
					disabled={!canEdit}
					onValueChange={(next) => {
						if (next && caseTypes.some((type) => type.name === next))
							onChange(freshCaseSource(next));
					}}
				>
					<SelectTrigger id={typeId} wrapValue>
						<SelectValue>{source.caseType}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{caseTypes.map((type) => (
							<SelectItem key={type.name} value={type.name}>
								{type.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Field>
			<Field>
				<FieldLabel htmlFor={labelId}>Label people see</FieldLabel>
				<Select
					value={source.labelProperty}
					disabled={!canEdit}
					onValueChange={(next) => {
						if (
							next &&
							type?.properties.some((property) => property.name === next)
						)
							onChange({ ...source, labelProperty: next });
					}}
				>
					<SelectTrigger id={labelId} wrapValue>
						<SelectValue>
							{labelProperty
								? propertyDisplayLabel(labelProperty, project)
								: source.labelProperty}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{type?.properties.map((property) => (
							<SelectItem key={property.name} value={property.name}>
								{propertyDisplayLabel(property, project)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<FieldDescription>
					Each answer saves the record's unique ID. Labels are record data and
					keep their saved wording in every app language.
				</FieldDescription>
			</Field>
			<div className="space-y-3 rounded-lg border border-nova-border bg-nova-elevated p-3">
				{source.filter ? (
					<PredicateWorkbench
						value={source.filter}
						onChange={setFilter}
						onRemoveRoot={() => setFilter(undefined)}
						removeRootLabel="Offer all available records"
						rootLabel="Case choices"
						caseTypes={caseTypes}
						currentCaseType={source.caseType}
						formCaseTypes={formCaseTypes}
						formFields={formFields}
						userProperties={userProperties}
						lookupTables={tables}
					/>
				) : (
					<>
						<p className="text-sm text-nova-text-secondary">
							Every available record of this type is offered, including closed
							records.
						</p>
						<Button
							type="button"
							variant="ghost"
							disabled={!canEdit}
							onClick={() => setFilter(freshCaseSource(source.caseType).filter)}
						>
							Add an open-record rule
						</Button>
					</>
				)}
				{canEdit && selectedType && type?.parent_type === selectedType ? (
					<Button
						type="button"
						variant="outline"
						onClick={() =>
							setFilter(
								and(
									source.filter ?? matchAll(),
									exists(
										{
											kind: "ancestor",
											via: [
												{ identifier: "parent", throughCaseType: selectedType },
											],
										},
										eq(
											prop(selectedType, "case_id"),
											term({
												kind: "form-case",
												caseType: selectedType,
												property: "case_id",
											}),
										),
									),
								),
							)
						}
					>
						Children of the selected record
					</Button>
				) : null}
			</div>
			{staged && (
				<div className="flex justify-end gap-2">
					<Button type="button" variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
					<Button
						type="button"
						disabled={!canEdit || !valid}
						onClick={onCommit}
					>
						Use these cases
					</Button>
				</div>
			)}
		</FieldGroup>
	);
}
