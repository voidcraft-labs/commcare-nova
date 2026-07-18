// Human-facing column naming shared by the Results and Details composers.
// Raw case-property ids are implementation details, so a missing authored
// header falls back to readable words rather than leaking `snake_case`.

import type { Column } from "@/lib/domain";
import { propertyFallbackDisplayLabel } from "../../shared/primitives/propertyDisplay";

export function columnLabel(column: Column): string {
	if (column.header.trim() !== "") return column.header;
	if (column.kind === "calculated") return "Calculated value";
	return propertyFallbackDisplayLabel(column.field);
}
