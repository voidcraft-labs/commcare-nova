/**
 * A base directory laid out as `proof/hq-apps/<base>/` lays one out, made of
 * CommCare HQ's own retained answers for an app Nova published
 * (`proof/hq-reads/`): `navigation-base`'s source read, HQ's application
 * resource and version read for it (`proof/hq-reads/reading/`) and a lookup
 * table list (`proof/hq-reads/lookups/lookup-tables.json`), each copied byte
 * for byte, read under the reading's preselected declaration. No lane run
 * wrote it, so the suites that read retained bases hold their own logic over
 * it (what they ask of a base, and what they report), never that a base is
 * HQ's: the lane holds that (`proof/matrix/test_retained.py`).
 *
 * Its `expected.json` is what the lane writes from a first reading of the
 * answers (`proof/matrix/retain.py`): the declaration it was read under, the
 * entries its claim counts name, and that declaration's first-publish ids.
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LaneReading } from "@/proof/reader/laneReading";

/** The control base's id, its directory's name. */
export const CONTROL_BASE = "navigation-base";

const HQ_READS = join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"..",
	"proof",
	"hq-reads",
);

/** Each file of the control base, from the retained answer it is a copy of. */
const COPIED = [
	["navigation-base/app-source.json", "app-source.json"],
	["reading/application.json", "application.json"],
	["reading/current-version.json", "current-version.json"],
	["lookups/lookup-tables.json", "lookup-tables.json"],
] as const;

export interface ExpectedJson {
	readonly reads: true;
	readonly declaration: {
		readonly runsOnlyOn: "web-apps" | "android" | null;
		readonly splitDatetime: boolean;
	};
	readonly claimed: readonly string[];
	readonly firstPublish: readonly string[];
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

/** Copy the retained answer `from` (a path under `proof/hq-reads/`) into the base as `name`. */
export async function copyRetained(
	directory: string,
	from: string,
	name: string,
): Promise<void> {
	await copyFile(join(HQ_READS, from), join(directory, name));
}

/** The body of the retained answer `from` (a path under `proof/hq-reads/`), parsed. */
export async function retainedBody(from: string): Promise<unknown> {
	const answer = JSON.parse(await readFile(join(HQ_READS, from), "utf8")) as {
		readonly body: string;
	};
	return JSON.parse(answer.body);
}

/** Write the control base under `root/navigation-base/`, with `expected` as its `expected.json`.
 *  Returns its directory. */
export async function writeControlBase(
	root: string,
	expected: ExpectedJson,
): Promise<string> {
	const directory = join(root, CONTROL_BASE);
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "base.json"),
		json({
			id: CONTROL_BASE,
			configuration: {
				flags: [],
				namedPrivileges: [],
				commcareVersion: "2.57.0",
				commtrack: false,
				syncCasesOnFormEntry: false,
				caseSearchEnabled: false,
			},
			declaration: "preselected",
			exhibits: [],
		}),
	);
	for (const [from, to] of COPIED) await copyRetained(directory, from, to);
	await writeFile(join(directory, "expected.json"), json(expected));
	return directory;
}

/** Rewrite the base's `expected.json`. */
export async function writeExpected(
	directory: string,
	expected: ExpectedJson,
): Promise<void> {
	await writeFile(join(directory, "expected.json"), json(expected));
}

/** The entry ids a reading's claims name: the keys a count names under `counts`, the `entry` of
 *  each line under `full`; sorted, as `proof/matrix/retain.py::claimed` reads them. */
export function claimedEntries(claims: string): string[] {
	if (claims === "") return [];
	let counts: unknown;
	try {
		counts = JSON.parse(claims);
	} catch {
		counts = undefined;
	}
	const entries = new Set<string>();
	if (typeof counts === "object" && counts !== null && !Array.isArray(counts)) {
		for (const [entry, count] of Object.entries(counts))
			if (typeof count === "number" && count > 0) entries.add(entry);
	} else {
		for (const line of claims.split("\n")) {
			if (line.trim() === "") continue;
			const { entry } = JSON.parse(line) as { readonly entry: string | null };
			if (entry) entries.add(entry);
		}
	}
	return [...entries].sort();
}

/** The `expected.json` the lane writes from a first reading that comes in. */
export function expectedOf(reading: LaneReading): ExpectedJson {
	if (reading.kind !== "read")
		throw new Error(
			`The control base reads as ${reading.kind}, and it is HQ's own answers for an app Nova published, which come in.`,
		);
	return {
		reads: true,
		declaration: reading.declaration,
		claimed: claimedEntries(reading.claims),
		firstPublish: [...reading.firstPublish],
	};
}
