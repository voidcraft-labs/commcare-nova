/**
 * The app strings a reading of a CommCare HQ app judges the app's generated
 * translation keys against: Nova's own build of a document, asked only of a
 * document Nova's gate admits.
 */

import { localAppStringTable } from "@/lib/commcare/appStrings";
import type { AppStringTable } from "@/lib/commcare/reader/types";
import {
	type ColumnFieldWordRow,
	targetWireIdentity,
} from "@/lib/commcare/wireIdentity";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";

/**
 * The `ReaderInput.appStrings` of a reading: a document's local app strings,
 * or null where Nova's gate refuses the document.
 *
 * The gate is asked with an empty batch, which validates the document as it
 * stands, under `lookupContext`: the gate's context over every table the
 * reading's catalog binds, so a document that reads a table the context
 * lacks is refused and one beside a table it never reads is not. The
 * strings are then built over the context's own definitions, each case list
 * column named by the word its source keeps it under (`columnWords`), as
 * HQ's build of the source names it. A
 * provisional document, holding stand-ins for what a finding withheld, can
 * be one Nova's build cannot write, and the null says so instead of the
 * build's throw.
 */
export function readingAppStrings(
	lookupContext: LookupValidationContext,
): (
	doc: BlueprintDoc,
	columnWords: readonly ColumnFieldWordRow[],
) => AppStringTable | null {
	const definitions =
		lookupContext.kind === "available" ? lookupContext.definitions : [];
	return (doc, columnWords) =>
		mutationCommitVerdict(doc, [], lookupContext).ok
			? localAppStringTable(
					doc,
					definitions,
					targetWireIdentity([], columnWords),
				)
			: null;
}
