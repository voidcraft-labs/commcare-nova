import type { CaseProperty } from "@/lib/domain";
import {
	effectiveDataType,
	isStandardCaseListProperty,
	standardCasePropertyDisplayLabel,
} from "@/lib/domain";
import { humanizeId } from "@/lib/domain/idSlug";

/**
 * A catalog label is a `ProseTemplate`, so its current spelling only exists
 * relative to a document. The projector is required rather than defaulted: a
 * default would render the same property correctly on one screen and as a
 * repair marker on the next, and the caller that cannot supply a document is
 * the one that should not be projecting.
 */
export function propertyDisplayLabel(
	property: CaseProperty,
	project: (label: CaseProperty["label"]) => string,
): string {
	const authored = project(property.label).trim();
	const authoredLooksGenerated =
		normalizedIdentifierLabel(authored) ===
		normalizedIdentifierLabel(property.name);
	if (
		isStandardCaseListProperty(property.name) &&
		(authored.length === 0 || authoredLooksGenerated)
	) {
		return propertyFallbackDisplayLabel(property.name);
	}
	return authored.length > 0
		? humanizeId(authored)
		: propertyFallbackDisplayLabel(property.name);
}

/**
 * Friendly fallback when a surface has only a stored property name.
 */
export function propertyFallbackDisplayLabel(name: string): string {
	if (isStandardCaseListProperty(name)) {
		return standardCasePropertyDisplayLabel(name);
	}
	return humanizeId(name) || "Untitled information";
}

export function propertyDisplayLabelForName(
	name: string,
	properties: readonly CaseProperty[],
	project: (label: CaseProperty["label"]) => string,
): string {
	const property = properties.find((candidate) => candidate.name === name);
	return property === undefined
		? propertyFallbackDisplayLabel(name)
		: propertyDisplayLabel(property, project);
}

/**
 * Sentence-case counterpart for predicate prose. Keep the current concise
 * identifier wording for ordinary properties, while the canonical case-name,
 * external-ID, and opened-date concepts use their carefully cased labels.
 */
export function propertyFallbackSentenceLabel(name: string): string {
	if (
		name === "case_name" ||
		name === "external_id" ||
		name === "date_opened"
	) {
		const label = propertyFallbackDisplayLabel(name);
		return label.charAt(0).toLowerCase() + label.slice(1);
	}
	return name.replace(/[_-]+/g, " ").trim() || name;
}

function normalizedIdentifierLabel(value: string): string {
	return value.trim().toLowerCase().replace(/[_-]+/g, " ");
}

function normalizedDisplayLabel(label: string): string {
	return label.trim().toLowerCase();
}

/**
 * Keep authored labels primary. A readable form of the stored name appears
 * only when two choices would otherwise look identical.
 */
export function friendlyPropertyDisambiguator(
	property: CaseProperty,
	properties: readonly CaseProperty[],
	project: (label: CaseProperty["label"]) => string,
): string | undefined {
	const label = propertyDisplayLabel(property, project);
	const peers = properties.filter(
		(candidate) =>
			normalizedDisplayLabel(propertyDisplayLabel(candidate, project)) ===
			normalizedDisplayLabel(label),
	);
	if (peers.length < 2) return undefined;
	const humanizedName = humanizeId(property.name) || "Stored information";
	// A parenthetical must add information. Canonical/system properties often
	// have a friendly label that is already the readable form of their stored
	// name (for example, "Case name"). Repeating that as "Case name (Case
	// name)" exposes implementation scaffolding without resolving ambiguity.
	if (normalizedDisplayLabel(humanizedName) === normalizedDisplayLabel(label)) {
		return undefined;
	}
	const sameNamePeers = peers.filter(
		(candidate) =>
			normalizedDisplayLabel(humanizeId(candidate.name)) ===
			normalizedDisplayLabel(humanizedName),
	);
	if (sameNamePeers.length === 1) return humanizedName;
	const peerIndex = sameNamePeers.indexOf(property);
	return FRIENDLY_FIELD_POSITIONS[peerIndex] ?? `Field ${peerIndex + 1}`;
}

const FRIENDLY_FIELD_POSITIONS = [
	"First field",
	"Second field",
	"Third field",
	"Fourth field",
	"Fifth field",
] as const;

export function propertyTypeLabel(property: CaseProperty): string {
	switch (effectiveDataType(property)) {
		case "text":
			return "Text";
		case "int":
		case "decimal":
			return "Number";
		case "date":
			return "Date";
		case "datetime":
			return "Date and time";
		case "time":
			return "Time";
		case "single_select":
			return "One choice";
		case "multi_select":
			return "Multiple choices";
		case "geopoint":
			return "Location";
	}
}
