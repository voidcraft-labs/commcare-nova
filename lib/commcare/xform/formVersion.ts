/**
 * Stamp a form's version on its data node at compile time.
 *
 * HQ's build sets the data root's `version` to the form's own version
 * (`models/forms.py::FormBase.add_stuff_to_xform`, `xform.py::
 * XForm.set_version`), and a submission carries it. The local `.ccz` has no
 * HQ build, so the compiler stamps the document's sequence there, beside
 * `addCaseBlocks` and `addMetaBlock`. The HQ source keeps the emitter's `1`,
 * which HQ overwrites at build.
 */

import {
	findDataElement,
	parseXForm,
	serializeXForm,
} from "@/lib/commcare/xform/domSplice";

/** The XForm with its data root's `version` set to `version`, and nothing else moved. */
export function setFormVersion(xform: string, version: number): string {
	const doc = parseXForm(xform);
	findDataElement(doc, "setFormVersion").attribs.version = String(version);
	return serializeXForm(doc);
}
