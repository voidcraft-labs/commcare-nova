/**
 * The apps CommCare HQ's own pages, models and form builder made, as the
 * proof lane retained them under `proof/hq-apps/<base>/` and holds them to
 * HQ at its pin, byte for byte (`proof/matrix/test_retained.py`). A suite
 * reads them through here and builds nothing HQ did not answer.
 *
 * `NAMED_BASES` is every base the lane's registry names
 * (`proof/matrix/bases.json`, which `proof/matrix/test_registry.py` holds to
 * `registry.BASES`), so a suite that iterates `RETAINED_BASES` can hold the
 * tree to it and fail on a tree no lane run has written, rather than pass
 * over nothing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	laneInputFor,
	loadRetainedHqApp,
	type RetainedHqApp,
	retainedBaseIds,
} from "@/proof/corpus/hqAuthored";
import type { LaneReadInput } from "@/proof/reader/laneReading";

/** The directory names under `proof/hq-apps/`, sorted. */
export const RETAINED_BASES: readonly string[] = retainedBaseIds();

/** Every base the lane's registry names, sorted. */
export const NAMED_BASES: readonly string[] = JSON.parse(
	readFileSync(
		join(import.meta.dirname, "..", "..", "proof", "matrix", "bases.json"),
		"utf8",
	),
);

/** A base's directory, read synchronously: under `proof/hq-apps/`, or under `root` where given. */
export function retainedBase(id: string, root?: string): RetainedHqApp {
	return root === undefined
		? loadRetainedHqApp(id)
		: loadRetainedHqApp(id, root);
}

/** A first reading's input: `identity: "mint"`, `claims: "full"`, `appId` the base's id, and the
 *  base's own declaration where `base.json` states one. */
export function laneInputOf(base: RetainedHqApp): LaneReadInput {
	return laneInputFor(base);
}
