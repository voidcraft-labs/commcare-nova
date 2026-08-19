// lib/domain/attachmentSlots.ts
//
// Which case properties hold a file rather than a value — ONE predicate
// for every surface that has to answer "is there anything here to read".
//
// A capture writing in `attachment` mode puts its file in the case's
// `<attachment>` block, and nothing lands in the property's scalar slot
// at all: the emitter deliberately keeps the property out of `<update>`
// (`lib/commcare/xform/caseBlocks.ts`), because a scalar there would be
// filled with the file NAME and sit beside the attachment carrying the
// file. So the property exists, and reading it yields nothing, forever.
//
// That makes it unlike an ordinary untyped property, where "unknown" is
// permissive because the wire is stringly and a mistyped column merely
// renders poorly (`columnApplicability.ts`). Here there is no value to
// render at any type, so the surfaces that offer a property to be read —
// case-list columns, the property pickers — have to leave it out, and
// the commit gate has to refuse a column already pointed at one.
//
// Nothing about this is CommCare-specific enough to live behind the
// emission boundary: it is a fact about what the author's own document
// says a property holds.

import type { BlueprintDoc } from "./blueprint";
import { fieldCaseWrite } from "./caseTypes";
import { type Field, isCaptureField } from "./fields";

/**
 * Does `(caseType, property)` hold a case attachment rather than a value?
 *
 * True only when the property HAS writers and EVERY one of them is an
 * attachment-mode capture. One ordinary writer is enough to make the
 * property readable — the scalar it writes is a real value, and the
 * attachment simply rides alongside it — so a mixed property is not a
 * slot, and neither is a property nothing writes (an author may be
 * reading something a form only preloads, or a property that arrives
 * from outside Nova entirely).
 */
export function casePropertyIsAttachmentSlot(
	doc: Pick<BlueprintDoc, "fields">,
	caseType: string,
	property: string,
): boolean {
	let hasWriter = false;
	for (const field of Object.values(doc.fields) as Field[]) {
		const write = fieldCaseWrite(field);
		if (write === undefined) continue;
		if (write.caseType !== caseType || write.property !== property) continue;
		if (!isCaptureField(field) || field.caseWrite?.mode !== "attachment") {
			return false;
		}
		hasWriter = true;
	}
	return hasWriter;
}
