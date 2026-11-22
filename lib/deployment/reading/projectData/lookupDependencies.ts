import "server-only";

import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import type { HqAlignedModule } from "@/lib/commcare/hq/appReading";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { baseUrl, type CommCareCredentials } from "@/lib/commcare/hq/http";
import type { HqLookupTable } from "@/lib/commcare/hq/lookupTables";
import {
	type ReaderLookupTable,
	readHqLookupTagsSteps,
} from "@/lib/commcare/reader";
import { mintingResolver } from "@/lib/commcare/reader/identity";
import { alignedFromSource } from "../../hqChanges/baselineSource";
import { readingAppStrings } from "../appStrings";
import type { Pieces } from "../pieces";
import { broughtInLookupColumnId, broughtInLookupTableId } from "./lookupIds";
import { readingMediaIndex } from "./media";

/** Find the active table reads while the only remote data in hand is HQ's
 * table list. Resolve each choice's columns against that list so a lookup
 * inside its filter also registers. Rows and local Project data enter only
 * after this pass. The base and current source share one set of row reads. */
export async function referencedLookupTags(input: {
	readonly source: HqAppSource;
	readonly alsoSource?: HqAppSource;
	readonly modules?: readonly HqAlignedModule[];
	readonly listed: readonly HqLookupTable[];
	readonly appId: string;
	readonly readingId: string;
	readonly domain: string;
	readonly creds: CommCareCredentials;
	readonly pieces: Pieces;
}): Promise<ReadonlySet<string>> {
	const { appId, readingId, pieces } = input;
	const listed = new Map<string, HqLookupTable>();
	for (const table of input.listed) {
		if (!listed.has(table.tag)) listed.set(table.tag, table);
	}
	const cache = new Map<string, ReaderLookupTable>();
	const lookup = {
		definitions: new Map(),
		table(tag: string) {
			const remote = listed.get(tag);
			if (!remote) return undefined;
			const known = cache.get(tag);
			if (known !== undefined) return known;
			const fields = new Set(remote.fields);
			const table: ReaderLookupTable = {
				tableId: broughtInLookupTableId(appId, readingId, tag),
				column: (name) =>
					fields.has(name)
						? broughtInLookupColumnId(appId, readingId, tag, name)
						: undefined,
			};
			cache.set(tag, table);
			return table;
		},
	};
	const tags = new Set<string>();
	const sources =
		input.alsoSource === undefined
			? [input.source]
			: [input.source, input.alsoSource];
	for (const source of sources) {
		const read = await pieces.at("the lookup dependencies").steps(
			readHqLookupTagsSteps({
				appId,
				target: { origin: baseUrl(input.creds), domain: input.domain },
				source,
				modules:
					source === input.source && input.modules !== undefined
						? input.modules
						: alignedFromSource(source),
				resolver: mintingResolver(appId),
				lookup,
				organization: { levels: [], levelCodes: [] },
				media: readingMediaIndex({ source, appId, plan: null }),
				appStrings: readingAppStrings({ kind: "unavailable" }),
				recordDialect: recordDialectRoundTrip,
			}),
		);
		for (const tag of read) tags.add(tag);
	}
	return tags;
}
