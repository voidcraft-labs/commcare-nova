/** Pure validation of structural lookup-table references. */

import { descendantFieldUuids } from "@/lib/doc/fieldWalk";
import {
	extractLookupReferenceOccurrences,
	type LookupReferenceExtractorRegistry,
	type LookupReferenceOccurrence,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { declaredPlatforms } from "@/lib/domain/platforms";
import {
	formBuilderTagCollisionSentence,
	formBuilderTagSuggestion,
	hqManagedTagRefusal,
	reservedInstanceTagCause,
} from "@/lib/lookup/constants";
import {
	lookupPathNameIssue,
	lookupPathNameSentence,
} from "@/lib/lookup/pathNames";
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

/** The occurrences in document order: modules in menu order, a module's own
 * slots before its forms, a form's questions in question order before the
 * form's own slots. Extraction runs in identity order, which is stable but
 * means nothing to a person reading the findings. */
function inDocumentOrder(
	doc: BlueprintDoc,
	occurrences: readonly LookupReferenceOccurrence[],
): LookupReferenceOccurrence[] {
	const rank = new Map<string, readonly number[]>();
	doc.moduleOrder.forEach((moduleUuid, moduleIndex) => {
		rank.set(moduleUuid, [moduleIndex, -1]);
		(doc.formOrder[moduleUuid] ?? []).forEach((formUuid, formIndex) => {
			rank.set(formUuid, [moduleIndex, formIndex, Number.MAX_SAFE_INTEGER]);
			[...descendantFieldUuids(doc, formUuid)].forEach((fieldUuid, index) => {
				rank.set(fieldUuid, [moduleIndex, formIndex, index]);
			});
		});
	});
	const keyOf = (occurrence: LookupReferenceOccurrence): readonly number[] => {
		const { moduleUuid, formUuid, fieldUuid } = occurrence.location;
		const anchor = fieldUuid ?? formUuid ?? moduleUuid;
		if (anchor === undefined) return [-1];
		return rank.get(anchor) ?? [Number.MAX_SAFE_INTEGER];
	};
	const compare = (left: readonly number[], right: readonly number[]) => {
		for (let i = 0; i < Math.max(left.length, right.length); i++) {
			const difference = (left[i] ?? -1) - (right[i] ?? -1);
			if (difference !== 0) return difference;
		}
		return 0;
	};
	return [...occurrences].sort((left, right) =>
		compare(keyOf(left), keyOf(right)),
	);
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
	const occurrences = inDocumentOrder(
		doc,
		extractLookupReferenceOccurrences(doc, registry),
	);
	if (occurrences.length === 0) return [];
	if (context.kind === "unavailable") {
		return occurrences.map(unavailableFinding);
	}

	const definitions = definitionIndex(context.definitions);
	const errors: ValidationError[] = [];
	// One expression can name a table at several of its paths (a lookup's
	// result column and its match column); a missing table is one problem
	// with that read, so it is reported once per carrier slot.
	const goneReads = new Set<string>();
	const checkedTags = new Set<string>();
	const platforms = declaredPlatforms(doc);
	function checkName(
		occurrence: LookupReferenceOccurrence,
		name: string,
		part: "tag" | "column",
	): void {
		const slot = occurrence.registrySlot;
		const issue = lookupPathNameIssue(name, slot, part, platforms);
		if (issue === null) return;
		const readableInWebApps =
			issue === "unreadable-name" &&
			lookupPathNameIssue(name, slot, part, ["web-apps"]) === null;
		errors.push(
			validationError(
				"LOOKUP_PATH_NAME_UNAVAILABLE",
				occurrence.location.scope,
				lookupPathNameSentence({ name, part, issue, readableInWebApps }),
				occurrenceLocation(occurrence),
				occurrenceDetails(occurrence, {
					name,
					part,
					issue,
					...(readableInWebApps && { readableInWebApps: "yes" }),
				}),
			),
		);
	}

	for (const occurrence of occurrences) {
		const table = definitions.get(occurrence.tableId);
		if (table === undefined) {
			const read = JSON.stringify([
				occurrence.carrierUuid,
				occurrence.registrySlot,
				occurrence.location,
				occurrence.tableId,
			]);
			if (!goneReads.has(read)) {
				goneReads.add(read);
				errors.push(tableNotAvailableFinding(occurrence));
			}
			continue;
		}
		// A table CommCare HQ manages is never written by Nova, so a tag that
		// collides with the form builder's own ids comes in as it is
		// (`lib/lookup/constants.ts::hqManagedTagRefusal`).
		const reserved =
			table.hq?.managedBy === "commcare-hq"
				? hqManagedTagRefusal(table.tag)
				: reservedInstanceTagCause(table.tag);
		if (reserved !== null) {
			errors.push(
				validationError(
					"LOOKUP_TAG_RESERVED_BY_RUNTIME",
					occurrence.location.scope,
					reserved.kind === "name"
						? `The lookup table ${table.name} uses the export tag ${table.tag}, which CommCare reserves for its own data. Rename the export tag in Project data, then try again.`
						: reserved.kind === "form-builder"
							? table.hq?.managedBy === "commcare-hq"
								? `The lookup table ${table.name}, which CommCare HQ manages, uses the export tag ${table.tag}. ${formBuilderTagCollisionSentence(reserved.collision)} You can choose another table for this setting.`
								: `The lookup table ${table.name} uses the export tag ${table.tag}, and Nova would put it into CommCare HQ on a publish. ${formBuilderTagCollisionSentence(reserved.collision)} You can rename the export tag in Project data, to ${formBuilderTagSuggestion(table.tag)} for example, then publish again.`
							: `The lookup table ${table.name} uses the export tag ${table.tag}, which contains ${reserved.word}, and CommCare reads any tag containing ${reserved.word} as its own data. Rename the export tag in Project data, then try again.`,
					occurrenceLocation(occurrence),
					occurrenceDetails(occurrence, {
						tag: table.tag,
						tableName: table.name,
						...(reserved.kind === "contains"
							? { reservedWord: reserved.word }
							: {}),
					}),
				),
			);
			continue;
		}
		const tagUse = JSON.stringify([
			occurrence.carrierUuid,
			occurrence.registrySlot,
			table.id,
		]);
		if (!checkedTags.has(tagUse)) {
			checkedTags.add(tagUse);
			checkName(occurrence, table.tag, "tag");
		}
		if (occurrence.memberId !== undefined) {
			const members =
				occurrence.columnId === undefined
					? table.attributes
					: table.columns.find((column) => column.id === occurrence.columnId)
							?.properties;
			const member = members?.find(
				(candidate) => candidate.id === occurrence.memberId,
			);
			if (member === undefined) {
				errors.push(
					validationError(
						"LOOKUP_COLUMN_NOT_AVAILABLE",
						occurrence.location.scope,
						"This lookup detail is no longer available in its table. Choose a current detail or change the source.",
						occurrenceLocation(occurrence),
						{ ...occurrenceDetails(occurrence), memberId: occurrence.memberId },
					),
				);
				continue;
			}
			checkName(occurrence, member.wireName, "column");
		}
		if (occurrence.columnId === undefined) continue;

		const column = table.columns.find(
			(candidate) => candidate.id === occurrence.columnId,
		);
		if (column === undefined) {
			errors.push(columnNotAvailableFinding(occurrence));
			continue;
		}

		checkName(occurrence, column.wireName, "column");

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
