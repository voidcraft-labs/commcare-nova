/** Pure validation of structural lookup-table references. */

import {
	extractLookupReferenceOccurrences,
	type LookupReferenceExtractorRegistry,
	type LookupReferenceOccurrence,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import {
	type ValidationError,
	type ValidationLocation,
	validationError,
} from "./errors";

function occurrenceLocation(
	occurrence: LookupReferenceOccurrence,
): ValidationLocation {
	const { scope: _scope, ...location } = occurrence.location;
	return location;
}

function occurrenceDetails(
	occurrence: LookupReferenceOccurrence,
	extra?: Readonly<Record<string, string>>,
): Record<string, string> {
	return {
		carrierUuid: occurrence.carrierUuid,
		registrySlot: occurrence.registrySlot,
		subpath: occurrence.subpath,
		tableId: occurrence.tableId,
		...(occurrence.columnId !== undefined && {
			columnId: occurrence.columnId,
		}),
		...extra,
	};
}

function unavailableFinding(
	occurrence: LookupReferenceOccurrence,
): ValidationError {
	return validationError(
		"LOOKUP_CONTEXT_UNAVAILABLE",
		occurrence.location.scope,
		`This lookup reference can't be checked right now because its Project lookup definitions are unavailable. Nothing was changed; wait for lookup data to reconnect, then retry.`,
		occurrenceLocation(occurrence),
		occurrenceDetails(occurrence),
	);
}

function tableNotAvailableFinding(
	occurrence: LookupReferenceOccurrence,
): ValidationError {
	return validationError(
		"LOOKUP_TABLE_NOT_AVAILABLE",
		occurrence.location.scope,
		`This reference points to a lookup table that isn't available in this Project (${occurrence.tableId}). Choose an available table, or remove the reference.`,
		occurrenceLocation(occurrence),
		occurrenceDetails(occurrence),
	);
}

function columnNotAvailableFinding(
	occurrence: LookupReferenceOccurrence,
): ValidationError {
	return validationError(
		"LOOKUP_COLUMN_NOT_AVAILABLE",
		occurrence.location.scope,
		`This reference points to a lookup column that isn't available in its table (${occurrence.columnId}). Choose an available column, or remove the reference.`,
		occurrenceLocation(occurrence),
		occurrenceDetails(occurrence),
	);
}

function columnTypeMismatchFinding(
	occurrence: LookupReferenceOccurrence,
	actualType: string,
): ValidationError {
	const accepted = occurrence.acceptedColumnTypes ?? [];
	return validationError(
		"LOOKUP_COLUMN_TYPE_MISMATCH",
		occurrence.location.scope,
		`This lookup reference needs ${accepted.join(" or ")} data, but the selected column contains ${actualType} data. Choose a compatible column.`,
		occurrenceLocation(occurrence),
		occurrenceDetails(occurrence, {
			acceptedColumnTypes: accepted.join(","),
			actualColumnType: actualType,
		}),
	);
}

function definitionIndex(
	definitions: readonly LookupTableDefinition[],
): ReadonlyMap<string, LookupTableDefinition> {
	return new Map(definitions.map((definition) => [definition.id, definition]));
}

/**
 * Validate every exact occurrence against one caller-owned definition context.
 * Missing and foreign-Project resources are both represented by absence from
 * the same exact requested snapshot and therefore produce identical findings.
 */
export function validateLookupReferences(
	doc: BlueprintDoc,
	context: LookupValidationContext,
	registry: LookupReferenceExtractorRegistry,
): ValidationError[] {
	const occurrences = extractLookupReferenceOccurrences(doc, registry);
	if (occurrences.length === 0) return [];
	if (context.kind === "unavailable") {
		return occurrences.map(unavailableFinding);
	}

	const definitions = definitionIndex(context.definitions);
	const errors: ValidationError[] = [];

	for (const occurrence of occurrences) {
		const table = definitions.get(occurrence.tableId);
		if (table === undefined) {
			errors.push(tableNotAvailableFinding(occurrence));
			continue;
		}
		if (occurrence.columnId === undefined) continue;

		const column = table.columns.find(
			(candidate) => candidate.id === occurrence.columnId,
		);
		if (column === undefined) {
			errors.push(columnNotAvailableFinding(occurrence));
			continue;
		}

		const accepted = occurrence.acceptedColumnTypes;
		if (
			accepted !== undefined &&
			accepted.length > 0 &&
			!accepted.includes(column.dataType)
		) {
			errors.push(columnTypeMismatchFinding(occurrence, column.dataType));
		}
	}

	return errors;
}
