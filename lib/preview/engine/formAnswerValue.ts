import { z } from "zod";
import type { Field } from "@/lib/domain";
import { GEOPOINT_PATTERN } from "@/lib/domain/predicate/jsonSchema";
import { FormEvaluationInputError } from "./formEvaluationTypes";
import { formatGeopoint, parseGeopoint } from "./geopointValue";

const storedGeopointPattern = new RegExp(GEOPOINT_PATTERN);

const locationAnswerSchema = z.strictObject({
	latitude: z.number().min(-90).max(90),
	longitude: z.number().min(-180).max(180),
	altitude: z.number().optional(),
	accuracy: z.number().min(0).optional(),
});

export const formAnswerValueSchema = z
	.union([z.string().max(10_000), locationAnswerSchema])
	.describe(
		"Answer text, or coordinates {latitude, longitude, altitude?, accuracy?} for a location picker. Coordinates simulate a chosen point, not GPS capture.",
	);
export type FormAnswerValue = z.infer<typeof formAnswerValueSchema>;

/** The same formatter the real picker uses; malformed test inputs are not
 * observations of a worker's form validation. Authored defaults remain untouched. */
export function evaluationAnswerValue(
	kind: Field["kind"],
	path: string,
	value: FormAnswerValue,
): string {
	if (typeof value !== "string") {
		const location = locationAnswerSchema.safeParse(value);
		if (kind !== "geopoint" || !location.success)
			throw new FormEvaluationInputError(
				`Test answer ${path} needs valid coordinates for a location question, or text for another question.`,
			);
		const point = location.data;
		return formatGeopoint({
			lat: point.latitude,
			lon: point.longitude,
			alt: point.altitude ?? 0,
			accuracy: point.accuracy ?? 0,
		});
	}
	if (kind === "geopoint" && value !== "") {
		const tokens = value.trim().split(/\s+/);
		if (
			!storedGeopointPattern.test(value) ||
			tokens.length !== 4 ||
			tokens.some((token) => !Number.isFinite(Number(token))) ||
			!parseGeopoint(value)
		)
			throw new FormEvaluationInputError(
				`Test answer ${path} is not a location-picker value. Supply coordinates as {latitude, longitude}; the picker formats them automatically. This is a test-input error, not a worker validation result.`,
			);
	}
	return value;
}
