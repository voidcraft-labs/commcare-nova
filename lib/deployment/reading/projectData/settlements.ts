/**
 * How project data settles what the reader handed it: a media path with no
 * file, and a read of a table the reader's catalog lacks. The reader claims
 * neither, because project data's rules name their entry, so acceptance asks
 * this answer whether each was judged.
 *
 * Pure.
 */

import type { HandOffRecord } from "@/lib/commcare/reader/accounting";
import {
	cutFindingName,
	type Finding,
	type HqPlace,
} from "@/lib/publish/hqFindings";
import type { HqMediaPlan } from "./media";

/** One hand-off project data judged, with that hand-off's own `artifact`, `where` and `key`. */
export interface HandOffSettlement {
	readonly artifact: string;
	readonly where: string;
	readonly key: string;
	readonly by: "inert-claim" | "finding";
}

/** Two places as one: the same kind and the same value of every member. */
function samePlace(left: HqPlace, right: HqPlace): boolean {
	const leftEntries = Object.entries(left);
	const rightRecord = right as Readonly<Record<string, unknown>>;
	return (
		leftEntries.length === Object.keys(right).length &&
		leftEntries.every(
			([key, value]) =>
				Object.hasOwn(rightRecord, key) && rightRecord[key] === value,
		)
	);
}

/**
 * One settlement per hand-off this part judged, in the hand-offs' order. A
 * hand-off is settled by its `subject`: a media path, or a table's tag.
 *
 * A path is settled `finding` where a finding is at `{ kind: "media", path }`,
 * or at the place of a reference of that path with the path as its name; and
 * otherwise `inert-claim` where `media.claims` holds a reference of that path.
 * A tag is settled `finding` where a finding is at
 * `{ kind: "lookup-table", tag }`. A hand-off neither settles gets none.
 *
 * `media` is the read's plan with every claim it answers, the claims of files
 * judged missing included, and `findings` every finding of the read's media
 * and project data.
 */
export function handOffSettlements(
	handOffs: readonly HandOffRecord[],
	media: HqMediaPlan,
	findings: readonly Finding[],
): readonly HandOffSettlement[] {
	const settlements: HandOffSettlement[] = [];
	for (const handOff of handOffs) {
		const by =
			handOff.to === "media-reference"
				? mediaSettlement(handOff.subject, media, findings)
				: tableSettlement(handOff.subject, findings);
		if (by === null) continue;
		settlements.push({
			artifact: handOff.artifact,
			where: handOff.where,
			key: handOff.key,
			by,
		});
	}
	return settlements;
}

function mediaSettlement(
	path: string,
	media: HqMediaPlan,
	findings: readonly Finding[],
): HandOffSettlement["by"] | null {
	const name = cutFindingName(path);
	const referencePlaces = [
		...media.references,
		...media.claims.map((claim) => claim.reference),
	]
		.filter((reference) => reference.path === path)
		.map((reference) => reference.place);
	const found = findings.some(
		(finding) =>
			(finding.place.kind === "media" && finding.place.path === path) ||
			(finding.detail.name === name &&
				referencePlaces.some((place) => samePlace(place, finding.place))),
	);
	if (found) return "finding";
	if (media.claims.some((claim) => claim.reference.path === path)) {
		return "inert-claim";
	}
	return null;
}

function tableSettlement(
	tag: string,
	findings: readonly Finding[],
): HandOffSettlement["by"] | null {
	return findings.some(
		(finding) =>
			finding.place.kind === "lookup-table" && finding.place.tag === tag,
	)
		? "finding"
		: null;
}
