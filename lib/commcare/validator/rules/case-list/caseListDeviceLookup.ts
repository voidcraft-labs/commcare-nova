import {
	type BlueprintDoc,
	caseListDeviceLookupSchema,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";
import { resolvePropertyDataType } from "./shared";

const LOOKUP_MESSAGES = {
	layout:
		"Use a case list or a custom case tile to look up cases with an Android app.",
	"confidence-rows": "Show lookup confidence in a case list with rows.",
	configuration:
		"Give the Android app an action, a lookup name, and named values and responses.",
	"confidence-property":
		"Choose a text property from the only record type in this case list.",
};

export function caseListDeviceLookup(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const config = mod.caseListConfig;
	if (config?.deviceLookup === undefined) return [];
	const { resultProperty } = config.deviceLookup;
	const reason =
		mod.caseType === undefined || config.tile?.namedSlots
			? "layout"
			: config.deviceLookup.resultHeading !== undefined &&
					config.tile !== undefined
				? "confidence-rows"
				: !caseListDeviceLookupSchema.safeParse(config.deviceLookup).success
					? "configuration"
					: resultProperty !== undefined &&
							((config.additionalCaseTypes?.length ?? 0) > 0 ||
								resolvePropertyDataType(doc, mod.caseType, resultProperty) !==
									"text")
						? "confidence-property"
						: undefined;
	return reason === undefined
		? []
		: [
				validationError(
					"CASE_LIST_DEVICE_LOOKUP_INVALID",
					"module",
					LOOKUP_MESSAGES[reason],
					{ moduleUuid, moduleName: mod.name },
					{ reason },
				),
			];
}
