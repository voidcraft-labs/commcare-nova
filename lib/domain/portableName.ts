import android from "./androidNameRanges.json";
import { PLATFORMS, type Platform } from "./platforms";
import web from "./portableNameRanges.json";

/** Inclusive start/end pairs generated from the worker's character table. */
function containsUnit(pairs: readonly number[], unit: number): boolean {
	let low = 0;
	let high = pairs.length / 2;
	while (low < high) {
		const middle = (low + high) >>> 1;
		const start = pairs[middle * 2];
		const end = pairs[middle * 2 + 1];
		if (unit < start) high = middle;
		else if (unit > end) low = middle + 1;
		else return true;
	}
	return false;
}

/** API 23 is the oldest supported Android client. Both workers parse with
 * Core's Lexer, but ART and Formplayer's JVM classify some units differently.
 * The Core probe in proof/android/lookup_names exercises those runtimes. */
function tableFor(platforms: readonly Platform[]) {
	return platforms.includes("android") ? android : web;
}

export function isPortableNameStart(
	unit: number,
	platforms: readonly Platform[] = PLATFORMS,
): boolean {
	return containsUnit(tableFor(platforms).initial, unit);
}

export function isPortableNameContinuation(
	unit: number,
	platforms: readonly Platform[] = PLATFORMS,
): boolean {
	const table = tableFor(platforms);
	return (
		containsUnit(table.initial, unit) ||
		containsUnit(table.continuationOnly, unit)
	);
}

export function isPortableName(
	name: string,
	platforms: readonly Platform[] = PLATFORMS,
): boolean {
	if (name.length === 0 || !isPortableNameStart(name.charCodeAt(0), platforms))
		return false;
	for (let i = 1; i < name.length; i++) {
		if (!isPortableNameContinuation(name.charCodeAt(i), platforms))
			return false;
	}
	return true;
}
