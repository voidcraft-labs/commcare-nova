/**
 * The app strings Nova's own build gives a document, read without a
 * deployment: the tables `compileCcz` would write into each language's
 * `app_strings.txt`, as values, with each string's source unit.
 *
 * Node-only, as the compiler is (`adm-zip`); imported by its own path.
 */

import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { compileCczParts } from "./compiler";
import { expandDoc } from "./expander";
import { buildLookupFixtures } from "./lookup/fixtures";
import { type LookupNamingDefinition, lookupWireNaming } from "./lookup/naming";
import type { AppStringTable } from "./reader/types";
import type { RuntimeTarget } from "./runtimeTarget";
import type { WireIdentity } from "./wireIdentity";

/** The project space a document's app strings are read for. With the
 *  server and the app's own id it names the profile's and the suite's
 *  request addresses and no app string. */
const APP_STRINGS_DOMAIN = "nova-app-strings";

/**
 * A document's app strings, by language code. Each named table is read
 * over the default table, as Core installs them. The named file omits
 * zero-length generated text; the default supplies the first nonblank
 * translation in build order. Values here precede locale-file escaping.
 *
 * The archive is compiled for a fixed stand-in target, with no media, and
 * with each lookup table the document reads named as `lookupDefinitions`
 * define it and carried in the suite with no rows. The definitions are
 * needed because a column's type decides how a comparison over it prints
 * (a date and time is compared as a moment), and only the definitions hold
 * it; no app string names a target or a table, so the tables are the ones
 * any archive of the document holds but for the strings only a media
 * manifest writes: a menu's media paths and an image map's alt texts, keyed
 * by a file's path.
 *
 * `identity` gives the word each case list column's property is kept under
 * (`WireIdentity.columnFieldWord`), which names the column's strings; a
 * reading passes the words its source keeps, so its overrides are judged
 * under the ids HQ's build of it writes. Absent reads the derivation.
 *
 * Total over a document Nova's gate admits under a lookup context holding
 * `lookupDefinitions`. The compiler's form, suite and media-suite oracles
 * throw for a document the gate refuses, so a caller holding such a
 * document asks the gate first
 * (`lib/deployment/reading/appStrings.ts::readingAppStrings`).
 */
export function localAppStringTable(
	doc: BlueprintDoc,
	lookupDefinitions: readonly LookupNamingDefinition[],
	identity?: WireIdentity,
): AppStringTable {
	const runtimeTarget: RuntimeTarget = {
		server: "production",
		domain: APP_STRINGS_DOMAIN,
		appId: doc.appId,
	};
	const read = new Set<string>(extractLookupReferenceTargets(doc).tableIds);
	const naming = lookupWireNaming(
		lookupDefinitions.filter((table) => read.has(table.id)),
	);
	const lookupFixtures = buildLookupFixtures(
		naming,
		new Map(naming.tables.map((table) => [table.tableId, []])),
	);
	const hqJson = expandDoc(doc, {
		runtimeTarget,
		lookupNaming: naming,
		...(identity !== undefined && { identity }),
	});
	const parts = compileCczParts(hqJson, doc.appName, doc, {
		runtimeTarget,
		lookupNaming: naming,
		lookupFixtures,
		...(identity !== undefined && { identity }),
	});
	return {
		languages: Object.fromEntries(
			Object.entries(parts.tables)
				.filter(([dir]) => dir !== "default")
				.map(([code, table]) => [
					code,
					Object.fromEntries([...parts.tables.default, ...table]),
				]),
		),
		units: parts.appStringUnits,
		wordingUnits: parts.wordingUnits,
	};
}
