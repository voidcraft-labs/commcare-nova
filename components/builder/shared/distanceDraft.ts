import {
	type DistanceUnit,
	distanceValidationIssue,
} from "@/lib/domain/predicate";
export function positiveDistance(
	draft: string,
	unit: DistanceUnit,
): { value: number; error?: undefined } | { value?: undefined; error: string } {
	if (draft.trim() === "") {
		return { error: "Enter a distance greater than 0" };
	}
	const parsed = Number(draft);
	const issue = distanceValidationIssue(parsed, unit);
	switch (issue) {
		case "not-positive-finite":
			return { error: "Enter a distance greater than 0" };
		case "meters-overflow":
			return { error: `Enter a smaller distance in ${unit}` };
		case undefined:
			return { value: parsed };
		default: {
			const _exhaustive: never = issue;
			return _exhaustive;
		}
	}
}
