/**
 * The one way project data makes a finding named by a manifest entry: the
 * entry's standing, cause and subject are read from the manifest, never set
 * by the producer. A circumstance is made through
 * `lib/publish/hqFindings.ts::circumstanceFinding` instead.
 *
 * Pure.
 */

import { inventoryIndex } from "@/lib/commcare/surface/inventory";
import {
	cutFindingName,
	type FindingStanding,
	type HqPlace,
	type ManifestFinding,
	type Subject,
} from "@/lib/publish/hqFindings";

/**
 * A finding under the manifest entry `entryId`, at `place`, naming `name`
 * (cut to a finding's bound). Throws on an id the manifest lacks, and on an
 * entry whose standing makes no finding or that names no subject: either is
 * a producer naming the wrong entry.
 */
export function manifestFinding(
	entryId: string,
	place: HqPlace,
	name: string,
): ManifestFinding {
	const entry = inventoryIndex().entry(entryId);
	if (entry === undefined) {
		throw new Error(`The manifest holds no entry "${entryId}".`);
	}
	const standing = entry.standing;
	if (
		standing !== "not-yet" &&
		standing !== "never" &&
		standing !== "fix-in-hq"
	) {
		throw new Error(
			`The manifest entry "${entryId}" stands "${standing}", which makes no finding.`,
		);
	}
	if (entry.subject === null) {
		throw new Error(`The manifest entry "${entryId}" names no subject.`);
	}
	const findingStanding: FindingStanding = standing;
	return {
		code: entry.id,
		standing: findingStanding,
		...(standing === "fix-in-hq" && entry.cause !== null
			? { cause: entry.cause }
			: {}),
		place,
		subject: entry.subject as Subject,
		detail: { name: cutFindingName(name) },
	};
}
