/** The HQ Application default is false. An unread source has no observed setting. */
export function sourceCapturesLocation(source: unknown): boolean {
	return (
		typeof source === "object" &&
		source !== null &&
		"auto_gps_capture" in source &&
		source.auto_gps_capture === true
	);
}

/** The historical source under the document value. A newly owned setting a target
 * kept is compared to what the person can edit when reviewing its first write. */
export function locationComparisonSource(
	source: unknown,
	enabled: boolean,
): unknown {
	if (typeof source !== "object" || source === null || Array.isArray(source))
		throw new Error("A location comparison needs an observed app source.");
	return { ...source, auto_gps_capture: enabled };
}
