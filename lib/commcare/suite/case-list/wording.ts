/** Each position's generated locale id and the stable column and output it names. */
import type { TranslationUnitId, Uuid } from "@/lib/domain";
import {
	columnWordingRole,
	generatedWordingId,
} from "@/lib/domain/generatedWording";
import type { DetailTarget } from "./types";
export function columnOutputWordings(
	column: Uuid,
	target: DetailTarget,
	detail: "short" | "long",
	sources: Readonly<Record<string, TranslationUnitId>>,
): Record<string, TranslationUnitId> {
	const role = columnWordingRole(target === "search", detail === "long");
	return Object.fromEntries(
		Object.entries(sources).map(([key, base]) => [
			key,
			generatedWordingId(column, role, base),
		]),
	);
}
