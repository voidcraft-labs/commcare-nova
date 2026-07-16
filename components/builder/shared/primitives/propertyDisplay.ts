import type { CaseProperty } from "@/lib/domain";
import {
	canonicalCasePropertyName,
	effectiveDataType,
	isStandardCaseListProperty,
	standardCasePropertyDisplayLabel,
} from "@/lib/domain";
import { humanizeId } from "@/lib/domain/idSlug";

export function propertyDisplayLabel(property: CaseProperty): string {
	const authored = property.label.trim();
	const canonicalName = canonicalCasePropertyName(property.name);
	const authoredLooksGenerated =
		authored.toLowerCase() === property.name.toLowerCase() ||
		authored.toLowerCase() === humanizeId(property.name).toLowerCase();
	if (
		isStandardCaseListProperty(property.name) &&
		(authored.length === 0 || authoredLooksGenerated)
	) {
		return standardCasePropertyDisplayLabel(canonicalName);
	}
	return humanizeId(authored || property.name) || "Untitled information";
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
