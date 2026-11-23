/**
 * The note under a question's Find an address setting, read from the
 * platforms the app declares. Web Apps searches only where the project space
 * has what the platform table's target condition names, and publishing asks
 * about it only for an app that runs in Web Apps
 * (`lib/domain/platformUses.ts::targetConditionUses`). An app that runs only
 * on Android meets none of it: the worker types an answer there.
 */

import type { FieldKind } from "@/lib/domain";
import { type Platform, targetConditionOf } from "@/lib/domain/platforms";

const ADDRESS_SEARCH_CONDITION = targetConditionOf("address-lookup");

export function addressSearchNote(
	platforms: readonly Platform[],
	kind: FieldKind,
): string {
	const masked = kind === "secret";
	if (
		ADDRESS_SEARCH_CONDITION === undefined ||
		!platforms.includes(ADDRESS_SEARCH_CONDITION.platform)
	)
		return masked
			? "This app runs only on Android, where the worker types the answer and it stays masked, so publishing asks nothing of the project space for it."
			: "This app runs only on Android, where the worker types the answer, so publishing asks nothing of the project space for it.";
	const condition = `${ADDRESS_SEARCH_CONDITION.reason} Publishing checks the project space and asks you to confirm the plan feature.`;
	if (!masked) return condition;
	return platforms.includes("android")
		? `${condition} Web Apps shows the address as the worker searches. Android masks the answer.`
		: `${condition} Web Apps shows the address as the worker searches.`;
}
