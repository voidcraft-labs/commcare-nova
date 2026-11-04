/**
 * Which case property writes stand in a form's own source.
 *
 * A form writes a case property in one of two places, as its placements
 * decide (`placement.ts::planPlacements`). A basic slot (HQ's Case
 * Management tab) is written by HQ's build, so the form's source never
 * holds it. A Save to Case block is written into the source, where HQ's
 * form builder reads every element by name. The blocks the source holds
 * are `caseOps.ts::writtenSaveToCaseBlocks`, the list the emitter writes
 * from, so the emitter and the validator cannot disagree about which writes
 * the source holds.
 */

import {
	type FormLinkProjectionContext,
	moduleFrameActionsBuildableIn,
} from "@/lib/commcare/formLinkProjection";
import { writtenSaveToCaseBlocks } from "@/lib/commcare/xform/caseOps";
import {
	type BlueprintDoc,
	caseWriteValueField,
	orderedCaseOperations,
	type Uuid,
} from "@/lib/domain";

/** One case property a block in the form's source writes, with its author:
 *  the question whose "Saves to" it is, where the value reads one as it
 *  is, else the case change that holds it. */
export interface SourceBlockCaseWrite {
	readonly property: string;
	readonly origin:
		| { readonly kind: "operation"; readonly operationUuid: Uuid }
		| { readonly kind: "field"; readonly fieldUuid: Uuid };
}

/** Every case property the form's source writes, each located at the
 *  question or the case change that authored it, in operation order. */
export function sourceBlockCaseWrites(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid,
	linkContext: FormLinkProjectionContext,
): readonly SourceBlockCaseWrite[] {
	const form = doc.forms[formUuid];
	if (form === undefined || doc.modules[moduleUuid] === undefined) return [];
	// A form whose placements cannot be read (a question id that is no XML
	// name, a case type that is no identifier: each a finding of its own) is
	// answered as if every write stood in its source, so the answer stays
	// total over every document the validator sees.
	const inSource = !moduleFrameActionsBuildableIn(doc, linkContext, moduleUuid)
		? new Set(orderedCaseOperations(form).map((operation) => operation.uuid))
		: new Set(
				writtenSaveToCaseBlocks(
					doc,
					formUuid,
					linkContext.attachmentTarget,
				).flatMap((block) =>
					block.subject.kind === "operation"
						? [block.subject.operationUuid]
						: [],
				),
			);
	const writes: SourceBlockCaseWrite[] = [];
	for (const operation of orderedCaseOperations(form)) {
		if (!inSource.has(operation.uuid)) continue;
		for (const write of operation.writes ?? []) {
			const source = caseWriteValueField(write.value);
			writes.push({
				property: write.property,
				origin:
					source === undefined
						? { kind: "operation", operationUuid: operation.uuid }
						: { kind: "field", fieldUuid: source.field },
			});
		}
	}
	return writes;
}
