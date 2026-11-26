/**
 * How a property read's relationship reads in the author's vocabulary: the
 * case it reaches and, where a saved connection cannot be followed, the line
 * that names it for repair. A connection name is valid by the same grammar
 * the stored document admits (`isAdvancedCaseIndexIdentifier`).
 */
import type { CaseType } from "@/lib/domain";
import { isAdvancedCaseIndexIdentifier } from "@/lib/domain/caseOperationIdentifiers";
import type { PropertyRef } from "@/lib/domain/expression";
import { humanizeId } from "@/lib/domain/idSlug";
import { resolveRelationDestination } from "./relationDestination";

export interface RelationSummary {
	readonly label: string;
	readonly detail?: string;
	readonly needsAttention?: boolean;
}

function destinationLabel(
	prefix: string,
	destination: string | undefined,
): string {
	return destination === undefined
		? prefix
		: `${prefix}: ${humanizeId(destination)}`;
}

function savedRelationshipDetail(identifier: string): string {
	const relationship = humanizeId(identifier);
	return relationship.length === 0
		? "Saved connection needs attention"
		: `Saved connection needs attention: ${relationship}`;
}

/**
 * Summarize a relational read in the author's vocabulary. Direction and the
 * case reached are the ordinary decision; the storage-level relationship name
 * stays in More settings unless it is needed to understand or repair an
 * ambiguous/imported path.
 */
export function relationSummary(
	value: NonNullable<PropertyRef["via"]>,
	originCaseType: string,
	caseTypes: readonly CaseType[],
): RelationSummary {
	const destination = resolveRelationDestination(
		value,
		originCaseType,
		caseTypes,
	);

	switch (value.kind) {
		case "self":
			return { label: "This case" };
		case "ancestor": {
			const invalidStep = value.via.find(
				(step) => !isAdvancedCaseIndexIdentifier(step.identifier),
			);
			if (invalidStep !== undefined) {
				return {
					label: destinationLabel(
						value.via.length === 1 ? "Parent case" : "Ancestor case",
						destination,
					),
					detail: savedRelationshipDetail(invalidStep.identifier),
					needsAttention: true,
				};
			}
			return {
				label: destinationLabel(
					value.via.length === 1 ? "Parent case" : "Ancestor case",
					destination,
				),
				detail:
					value.via.length > 1
						? `${value.via.length} connections away`
						: undefined,
			};
		}
		case "subcase":
		case "any-relation": {
			const selectedCaseType = destination;
			const prefix = value.kind === "subcase" ? "Child case" : "Related case";
			const invalidIdentifier = !isAdvancedCaseIndexIdentifier(
				value.identifier,
			);
			if (invalidIdentifier) {
				return {
					label: destinationLabel(prefix, selectedCaseType),
					detail: savedRelationshipDetail(value.identifier),
					needsAttention: true,
				};
			}

			const needsCaseType = selectedCaseType === undefined;
			if (needsCaseType) {
				const unavailable =
					value.ofCaseType !== undefined
						? `${humanizeId(value.ofCaseType)} is unavailable`
						: value.kind === "subcase"
							? "Choose a child case type"
							: "Choose a related case type";
				return {
					label: prefix,
					detail: `${unavailable} · Saved connection: ${humanizeId(value.identifier)}`,
					needsAttention: true,
				};
			}

			return { label: destinationLabel(prefix, selectedCaseType) };
		}
	}
}
