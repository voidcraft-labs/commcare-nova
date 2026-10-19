// lib/preview/engine/viewerLocation.ts
//
// The rule a running list follows for `here()` while the viewer's position
// moves. A calculated column that holds `here()` runs in Postgres with the
// position as a bound parameter, so the question here is only WHEN the list
// reads again and when the browser may stop watching. CommCare Android's
// handler is the one CommCare rule for a moving position (Formplayer reads
// whatever the browser sent with each request and watches nothing), so
// Preview follows it, read at the android pin:
//
//   - Refresh: the first position re-reads the list; a later one re-reads
//     it only when it is more than 30 metres from the position the list last
//     showed (`app/src/org/commcare/utils/AndroidHereFunctionHandler.java::
//     REFRESH_METER_DELTA`, `::shouldRefreshEntityList`).
//   - Stop: the watch stops once a position of 1,600 metres accuracy or
//     better is in hand (`::onLocationChanged`, and
//     `app/src/org/commcare/utils/GeoUtils.java::DEFAULT_ACCEPTABLE_ACCURACY`).
//
// The move is measured with Core's spherical haversine
// (`javaRosaPointDistance`). Android's `Location.distanceTo` is ellipsoidal,
// which at 30 metres differs by a fraction of a metre.
//
// Pure: no I/O, no React, no browser API, so the server action, the hooks
// and the tests share one definition.

import type { CaseListConfig, Column } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression";
import { walkExpressionNodes } from "@/lib/domain/expression/walk";
import { javaRosaPointDistance } from "@/lib/preview/xpath/javaRosaGeo";

/** The viewer's position as the browser reported it, in decimal degrees. */
export interface ViewerLocation {
	readonly latitude: number;
	readonly longitude: number;
}

/** A move strictly greater than this re-reads the list. */
export const VIEWER_LOCATION_REFRESH_METRES = 30;

/** A position at this accuracy or better stops the watch. */
export const VIEWER_LOCATION_ACCEPTABLE_ACCURACY_METRES = 1600;

/**
 * Whether a newly reported position makes the list read again: always when
 * the list has shown no position yet, otherwise only past 30 metres from the
 * one it last showed.
 */
export function shouldReReadForPosition(
	lastShown: ViewerLocation | undefined,
	next: ViewerLocation,
): boolean {
	if (lastShown === undefined) return true;
	return (
		javaRosaPointDistance(lastShown, next) > VIEWER_LOCATION_REFRESH_METRES
	);
}

/**
 * Whether a position is accurate enough for the watch to stop. An accuracy
 * the browser did not report, or one that is not a number, never settles, so
 * the watch keeps running until a position it can trust arrives.
 */
export function positionSettles(accuracy: number | undefined): boolean {
	return (
		accuracy !== undefined &&
		Number.isFinite(accuracy) &&
		accuracy <= VIEWER_LOCATION_ACCEPTABLE_ACCURACY_METRES
	);
}

/**
 * Whether a screen of this case list shows a calculated column whose tree
 * holds `here()`. `"list"` is Results: every column of a list without a
 * tile, and the columns shown in Results for a tile list. `"detail"` is the
 * case's Details. A column the screen never shows asks for no position,
 * as Android turns its location on only when a list evaluates `here()`.
 */
export function columnsReadHere(
	config: CaseListConfig | undefined,
	screen: "list" | "detail",
): boolean {
	if (config === undefined) return false;
	return config.columns.some(
		(column) =>
			column.kind === "calculated" &&
			columnShowsOn(column, config, screen) &&
			expressionReadsHere(column.expression),
	);
}

function columnShowsOn(
	column: Column,
	config: CaseListConfig,
	screen: "list" | "detail",
): boolean {
	if (screen === "detail") return column.visibleInDetail !== false;
	return config.tile === undefined || column.visibleInList !== false;
}

function expressionReadsHere(expression: Expression): boolean {
	let found = false;
	walkExpressionNodes(expression, (node) => {
		if (node.kind === "here") found = true;
	});
	return found;
}
