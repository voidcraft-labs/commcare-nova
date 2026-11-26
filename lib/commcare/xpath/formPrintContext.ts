import {
	readsProjectSearchResults,
	slotContext,
} from "@/lib/domain/expression/context";
import { formFieldPath } from "@/lib/domain/expression/formStructure";
import type { FormPrintContext } from "@/lib/domain/expression/print";
import { lookupReadType, lookupReadTypes } from "@/lib/domain/lookupRead";
import {
	locationPropertiesOf,
	organizationLevelsOf,
} from "@/lib/domain/organization";
import { referenceNames } from "@/lib/domain/referenceNames";
import {
	entryDatumIdResolver,
	entryDatumIds,
	formLinkProjectionContext,
} from "../formLinkProjection";
import { lookupInstanceIdForScope } from "../lookup/naming";
import { lookupReadSteps } from "../lookup/read";
import { itextIdFor } from "../xform/itextIds";
import { formNodeProjection } from "./formNodeProjection";
import type { FormParseScope } from "./formParseScope";
import { w } from "./wire/builders";
import { serializeWire } from "./wire/serialize";

export function formScopeContext(scope: FormParseScope) {
	return slotContext(
		scope.doc,
		scope.slot,
		scope.lookup === "unavailable"
			? new Map()
			: new Map(
					[...scope.lookup].map(([id, table]) => [id, lookupReadTypes(table)]),
				),
		{ form: scope.form },
	);
}

/** Parser hints and all human projections use this same identity projection. */
export function formPrintContext(
	scope: FormParseScope,
): FormPrintContext | undefined {
	const context = formScopeContext(scope);
	if (context === undefined) return undefined;
	const form = context.form;
	const names = referenceNames(scope.doc);
	const projection =
		form === undefined
			? undefined
			: formNodeProjection(scope.doc, form, { surface: "authoring" });
	const datums =
		form === undefined
			? []
			: entryDatumIds(
					scope.doc,
					formLinkProjectionContext(scope.doc, { entryMetadataOnly: true }),
					form.moduleUuid,
					form.formUuid,
				);
	const datumId = entryDatumIdResolver(datums);
	return {
		projectSearchResults: readsProjectSearchResults(context),
		...names,
		...(projection === undefined
			? {}
			: { graph: projection.graph, step: projection.step }),
		sourceNode: context.sourceNode,
		contextNode: context.contextNode,
		fieldPathSegments: (uuid) =>
			form === undefined
				? names.fieldPathSegments(uuid)
				: formFieldPath(form, uuid),
		choiceValues: (field, options) => {
			const choices = form?.fields.get(field)?.choices;
			if (choices?.kind !== "inline") return undefined;
			const values = options.map(
				(uuid) => choices.options.find((option) => option.uuid === uuid)?.value,
			);
			return values.every((value): value is string => value !== undefined)
				? values
				: undefined;
		},
		datumId,
		selectedCasesId: (module) =>
			datums.find(
				(row) =>
					!row.scalar &&
					row.refs.some(
						(ref) => ref.kind === "selected-case" && ref.module === module,
					),
			)?.id,
		tableTag: (table) =>
			scope.lookup === "unavailable" ? undefined : scope.lookup.get(table)?.tag,
		tableColumnName: (table, column) =>
			scope.lookup === "unavailable"
				? undefined
				: scope.lookup.get(table)?.columns.find((value) => value.id === column)
						?.wireName,
		lookupInstanceId: lookupInstanceIdForScope(context.profile.scope),
		tableReadPath: (id, read) => {
			const table =
				scope.lookup === "unavailable" ? undefined : scope.lookup.get(id);
			if (!table || !lookupReadType(lookupReadTypes(table), read))
				return undefined;
			const requiredName = (name: string | undefined) => {
				if (!name)
					throw new Error(
						"The lookup detail is missing from the checked table.",
					);
				return name;
			};
			const steps = lookupReadSteps(
				{
					wireNameFor: (column) =>
						requiredName(
							table.columns.find((item) => item.id === column)?.wireName,
						),
					memberNameFor: (column, id) =>
						requiredName(
							(column === undefined
								? table.attributes
								: table.columns.find((item) => item.id === column)?.properties
							)?.find((member) => member.id === id)?.wireName,
						),
				},
				read,
			);
			return serializeWire(w.context(steps), { target: "suite" }).text;
		},
		locationLevelCode: (level) => organizationLevelsOf(scope.doc)[level]?.code,
		locationPropertySlug: (property) =>
			locationPropertiesOf(scope.doc)[property]?.slug,
		itextId: (unit) => itextIdFor(scope.doc, unit, form),
	};
}
