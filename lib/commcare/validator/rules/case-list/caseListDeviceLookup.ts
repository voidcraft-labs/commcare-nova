import {
	caseListDeviceLookupSchema,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

export function caseListDeviceLookup(
	mod: Module,
	moduleUuid: Uuid,
): ValidationError[] {
	const config = mod.caseListConfig;
	if (config?.deviceLookup === undefined) return [];
	const message =
		mod.caseType === undefined || config.tile?.namedSlots
			? "Use a case list or a custom case tile to look up cases with an Android app."
			: config.deviceLookup.resultHeading !== undefined &&
					config.tile !== undefined
				? "Show lookup confidence in a case list with rows."
				: caseListDeviceLookupSchema.safeParse(config.deviceLookup).success
					? undefined
					: "Give the Android app an action, a lookup name, and named values and responses.";
	return message === undefined
		? []
		: [
				validationError("CASE_LIST_DEVICE_LOOKUP_INVALID", "module", message, {
					moduleUuid,
					moduleName: mod.name,
				}),
			];
}
