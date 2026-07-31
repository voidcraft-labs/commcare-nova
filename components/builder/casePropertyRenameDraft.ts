import {
	CASE_SCALAR_PROPERTY_NAMES,
	type CaseType,
	humanizeId,
} from "@/lib/domain";

export interface CasePropertyRenameSource {
	readonly caseType: string;
	readonly property: string;
	readonly label: string;
}

export interface CasePropertyRenameDraftRow
	extends Pick<CasePropertyRenameSource, "caseType" | "property"> {
	readonly to: string;
}

/** Complete visible inventory: authored/effective properties plus row scalars. */
export function casePropertyInventoryNames(
	caseType: CaseType,
): readonly string[] {
	const names = caseType.properties.map((property) => property.name);
	const present = new Set(names);
	for (const scalar of CASE_SCALAR_PROPERTY_NAMES) {
		if (!present.has(scalar)) names.push(scalar);
	}
	return names;
}

export function casePropertyRenameSourceId(
	caseType: string,
	property: string,
): string {
	return JSON.stringify([caseType, property]);
}

export function parseCasePropertyRenameSourceId(
	value: string,
): Pick<CasePropertyRenameSource, "caseType" | "property"> | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			Array.isArray(parsed) &&
			parsed.length === 2 &&
			typeof parsed[0] === "string" &&
			typeof parsed[1] === "string"
		) {
			return { caseType: parsed[0], property: parsed[1] };
		}
	} catch {
		// A Select value is an opaque UI token. An unrecognized token is a no-op.
	}
	return undefined;
}

/** Custom properties that the app-wide rename relation may use as sources. */
export function casePropertyRenameSources(
	caseTypes: readonly CaseType[],
): readonly CasePropertyRenameSource[] {
	return caseTypes.flatMap((caseType) =>
		caseType.properties.flatMap((property) =>
			CASE_SCALAR_PROPERTY_NAMES.has(property.name)
				? []
				: [
						{
							caseType: caseType.name,
							property: property.name,
							label: humanizeId(property.name) || property.name,
						},
					],
		),
	);
}

export function availableCasePropertyRenameSources(
	sources: readonly CasePropertyRenameSource[],
	rows: readonly CasePropertyRenameDraftRow[],
	currentIndex?: number,
): readonly CasePropertyRenameSource[] {
	const selected = new Set(
		rows.flatMap((row, index) =>
			index === currentIndex
				? []
				: [casePropertyRenameSourceId(row.caseType, row.property)],
		),
	);
	return sources.filter(
		(source) =>
			!selected.has(
				casePropertyRenameSourceId(source.caseType, source.property),
			),
	);
}
