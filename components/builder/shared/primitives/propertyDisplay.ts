import type { CaseProperty } from "@/lib/domain";
import {
	authorableCaseProperties,
	canonicalCasePropertyName,
	effectiveDataType,
	isStandardCaseListProperty,
	LEGACY_STANDARD_CASE_PROPERTY_ALIASES,
	standardCasePropertyDisplayLabel,
} from "@/lib/domain";
import { humanizeId } from "@/lib/domain/idSlug";

export function propertyDisplayLabel(property: CaseProperty): string {
	const authored = property.label.trim();
	const canonicalName = canonicalCasePropertyName(property.name);
	const generatedNames = [
		canonicalName,
		...Object.entries(LEGACY_STANDARD_CASE_PROPERTY_ALIASES)
			.filter(([, canonical]) => canonical === canonicalName)
			.map(([legacy]) => legacy),
	];
	const authoredLooksGenerated = generatedNames.some(
		(name) =>
			normalizedIdentifierLabel(authored) === normalizedIdentifierLabel(name),
	);
	if (
		isStandardCaseListProperty(property.name) &&
		(authored.length === 0 || authoredLooksGenerated)
	) {
		return propertyFallbackDisplayLabel(canonicalName);
	}
	return authored.length > 0
		? humanizeId(authored)
		: propertyFallbackDisplayLabel(property.name);
}

/**
 * Friendly fallback when a surface has only a stored property name. Legacy
 * CCHQ spellings are normalized before display so they can keep working in an
 * old document without reappearing as a second Nova concept.
 */
export function propertyFallbackDisplayLabel(name: string): string {
	const canonicalName = canonicalCasePropertyName(name);
	if (isStandardCaseListProperty(canonicalName)) {
		return standardCasePropertyDisplayLabel(canonicalName);
	}
	return humanizeId(canonicalName) || "Untitled information";
}

/**
 * Resolve a stored name through Nova's canonical authoring projection. A
 * meaningful legacy-authored label survives, while generated alias copy is
 * replaced by the canonical system label.
 */
export function propertyDisplayLabelForName(
	name: string,
	properties: readonly CaseProperty[],
): string {
	const canonicalName = canonicalCasePropertyName(name);
	const property = authorableCaseProperties(properties).find(
		(candidate) => candidate.name === canonicalName,
	);
	return property === undefined
		? propertyFallbackDisplayLabel(canonicalName)
		: propertyDisplayLabel(property);
}

/**
 * Sentence-case counterpart for predicate prose. Keep the current concise
 * identifier wording for ordinary properties, while the canonical case-name,
 * external-ID, and opened-date concepts use their carefully cased labels.
 */
export function propertyFallbackSentenceLabel(name: string): string {
	const canonicalName = canonicalCasePropertyName(name);
	if (
		canonicalName === "case_name" ||
		canonicalName === "external_id" ||
		canonicalName === "date_opened"
	) {
		const label = propertyFallbackDisplayLabel(canonicalName);
		return label.charAt(0).toLowerCase() + label.slice(1);
	}
	return canonicalName.replace(/[_-]+/g, " ").trim() || canonicalName;
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
): string | undefined {
	const label = propertyDisplayLabel(property);
	const peers = properties.filter(
		(candidate) =>
			normalizedDisplayLabel(propertyDisplayLabel(candidate)) ===
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
