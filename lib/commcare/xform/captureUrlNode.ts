// lib/commcare/xform/captureUrlNode.ts
//
// The node a capture field's case property actually reads, and the
// expression that fills it.
//
// One home for two callers that must not disagree: the XForm builder
// emits the node and its bind, and `formActions.ts` names the same node as
// the case update's question path. If they drifted, the case property
// would point at a node that does not exist and the write would silently
// vanish.
//
// The indirection is not a stylistic choice. CommCare HQ decides
// `<attachment>` versus `<update>` by looking at the question path alone:
// `app_manager/xform.py::CaseBlock.is_attachment` collects every
// `<upload ref>` in the body and `::add_case_updates` routes the update
// into an attachment block if the path is one of them, without consulting
// the `MM_CASE_PROPERTIES` toggle. Pointing a URL property at the capture
// question would therefore emit an attachment block on a domain that
// silently drops it, and no property at all.

import { RESERVED_XFORM_NODE_PREFIX } from "../constants";
import { xpathStringLiteral } from "../xpath/stringLiteral";
import type { FormPath } from "./formPath";

/**
 * The two halves of an attachment URL that the deployment target supplies.
 *
 * Declared here rather than in `lib/deployment` because `lib/commcare` is a
 * one-way emission boundary: the deployment layer may read the wire
 * package, never the other way round. What travels across is an origin and
 * a project space, already resolved — the emitter never learns what a
 * deployment is.
 */
export interface AttachmentUrlTarget {
	readonly origin: string;
	readonly domain: string;
}

/**
 * The form instance's own submission id.
 *
 * `meta/instanceID` is seeded client-side at form open — HQ emits
 * `<setvalue event="xforms-ready" ref="meta/instanceID" value="uuid()"/>`
 * in `app_manager/xform.py::XForm.add_case_and_meta` — and the receiver
 * takes that exact value as the stored form's id
 * (`form_processor/utils/xform.py::extract_meta_instance_id`). So a
 * calculate reading it during the session names the submission the
 * attachment will actually hang off.
 *
 * The node is absent from Nova's emitted source on the HQ-upload path,
 * because HQ regenerates the whole meta block at build time and a
 * `<meta>` child of `<data>` in the uploaded source makes the app
 * unopenable in HQ's form builder. Referencing it from an expression body
 * is still safe, and is what the existing
 * `@date_modified` bind in `caseOps.ts` already relies on: JavaRosa
 * resolves calculates by dependency graph after the document is whole, not
 * in document order.
 */
const META_INSTANCE_ID = "/data/meta/instanceID";

/** The path segment of HQ's machine-readable attachment endpoint. */
const FORM_ATTACHMENT_API_PATH = "/api/form_attachment/v1/";

/**
 * The node carrying a capture's case-bound URL.
 *
 * A sibling of the capture question rather than a node hoisted to the form
 * root, so a capture inside a repeat produces one URL per iteration and
 * lands in the same child-create bucket as the capture itself. Sibling ids
 * are unique within their container and `__nova_` is reserved from
 * authored ids (`validator/rules/field.ts`, `identifierValidation.ts`), so
 * the name cannot collide with an author's own question.
 */
export function captureUrlNodeName(captureElementName: string): string {
	return `${RESERVED_XFORM_NODE_PREFIX}url_${captureElementName}`;
}

export function captureUrlNodePath(capturePath: FormPath): FormPath {
	const segments = capturePath.segments();
	const last = segments[segments.length - 1];
	if (last === undefined || last.kind !== "element") {
		throw new Error(
			`A capture field's path must end in an element step, but ${capturePath.toXPath()} does not. ` +
				`The URL node is emitted as that element's sibling, so there is nowhere to put it.`,
		);
	}
	return capturePath.parent().child(captureUrlNodeName(last.name));
}

/**
 * The expression filling that node.
 *
 * Blank in, blank out. The guard is load-bearing on the HQ path: HQ
 * generates `relevant="count(<question path>) > 0"` for every case update
 * from the node it was given, and this node always exists, so without the
 * guard a form submitted with no attachment would write an address ending
 * in a bare slash. With it, clearing an attachment writes `""` — a real
 * blank that keeps the property honest about what the case now holds.
 */
export function captureUrlCalculate(
	capturePath: FormPath,
	target: AttachmentUrlTarget,
): string {
	const capture = capturePath.toXPath();
	const prefix = xpathStringLiteral(
		`${target.origin}/a/${target.domain}${FORM_ATTACHMENT_API_PATH}`,
	);
	return (
		`if(${capture} = '', '', ` +
		`concat(${prefix}, ${META_INSTANCE_ID}, '/', ${capture}))`
	);
}
