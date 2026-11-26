/** Standalone component of the exact-source Step 7 converter. Settings are
 * authenticated by the outer fold loader. Only a verified target contributes
 * a value to the ordinary app. Every target retains its own source digest and
 * prior ownership for comparison on the next publish or bring-in. */
export const sourceRevision = "3e16e43f8cfa56e485860f3345c81f5f9a68aec9";

/** @param {readonly {previous: boolean | null, claim?: string}[]} targets */
export function locationDecision(targets) {
	const active = targets.filter(({ claim }) => claim !== "ended");
	const known = new Set(
		active.flatMap(({ previous }) => (previous === null ? [] : [previous])),
	);
	const agreement = known.size === 1;
	const standing =
		active.length === 0
			? "no-target"
			: known.size === 0
				? "unobserved"
				: !agreement
					? "disagreement"
					: known.has(true)
						? "agreed-on"
						: "agreed-off";
	return { standing, captureLocation: agreement && known.has(true) };
}

/** Apply before converting the released connectType to activity roles.
 * A private genesis has no deployed app. Private edits and independent
 * deployment references start from their owning app's converted source
 * snapshot. The untouched normalized HQ source still names the prior value
 * at that specific target, even in a target disagreement.
 * @param {any} snapshot @param {any} settings
 * @param {{appId: string, projectId: string, purpose?: string}} coordinate
 */
export function convert(snapshot, settings, { appId, projectId, purpose }) {
	if (
		!snapshot ||
		snapshot.appId !== appId ||
		!Object.hasOwn(snapshot, "connectType") ||
		!projectId
	)
		throw new Error(
			"Automatic location needs the released document and its owning app and Project.",
		);
	// Earlier canonical baselines omit appSettings when no setting was stored.
	// Absence had the released default, and remains absent without an adoption.
	if (
		snapshot.appSettings &&
		Object.hasOwn(snapshot.appSettings, "captureLocation")
	)
		throw new Error(
			"The automatic location converter requires the released setting representation.",
		);
	if (snapshot.connectType !== null || purpose === "private-genesis")
		return snapshot;
	const matches = settings.locationCapture.decisions.filter(
		(item) => item.appId === appId && item.projectId === projectId,
	);
	if (matches.length !== 1)
		throw new Error(
			"The frozen location scan has no unique standing for this app and Project. Scan it again.",
		);
	const decision = matches[0];
	const calculated = locationDecision(decision.targets);
	if (
		calculated.standing !== decision.standing ||
		calculated.captureLocation !== decision.captureLocation
	)
		throw new Error(
			"The automatic location decision disagrees with its frozen targets.",
		);
	return calculated.captureLocation
		? {
				...snapshot,
				appSettings: { ...snapshot.appSettings, captureLocation: true },
			}
		: snapshot;
}
