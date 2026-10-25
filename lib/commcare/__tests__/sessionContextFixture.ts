/**
 * The session context reads the native `expression` family runs in Core
 * (`proof/native/core/SessionContextRuntimeTest.java`, written by
 * `proof/native/producers/emit-expression-evidence.ts` under
 * `session-context/`).
 *
 * `windowWidthGateXForm` is the window width gate's form: one calculate reads
 * `session/context/window_width` bare and a second reads it under the count
 * guard. Nova never emits the bare read in a form, so the form is written
 * here by hand, a control rather than an export: the class initializes it
 * once with a width and again without one, on the same `FormDef` (Formplayer's
 * cached form) and on a fresh one (the form Formplayer deserializes after a
 * cache miss), and the two runs decide whether a form may read the width.
 */

/** The window width as every form reads it. */
export const WINDOW_WIDTH_PATH =
	"instance('commcaresession')/session/context/window_width";

/** The count guard over an absent-capable read: `if(count(P) > 0, P, '')`. */
export function countGuarded(read: string, counted: string = read): string {
	return `if(count(${counted}) > 0, ${read}, '')`;
}

/** Escapes text for an XML attribute value. */
function attribute(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** The nodes the gate's two calculates fill. */
export const WINDOW_WIDTH_GATE_NODES = {
	bare: "/data/bare",
	guarded: "/data/guarded",
} as const;

/** The gate's XForm: a bare and a guarded calculate of the window width. */
export function windowWidthGateXForm(): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml" xmlns:jr="http://openrosa.org/javarosa">
  <h:head>
    <h:title>Window width</h:title>
    <model>
      <instance>
        <data xmlns="http://nova.proof/session-context/window-width" uiVersion="1" version="1" name="Window width">
          <note/>
          <bare/>
          <guarded/>
        </data>
      </instance>
      <instance id="commcaresession" src="jr://instance/session"/>
      <bind nodeset="/data/note" type="xsd:string"/>
      <bind nodeset="${WINDOW_WIDTH_GATE_NODES.bare}" calculate="${attribute(WINDOW_WIDTH_PATH)}"/>
      <bind nodeset="${WINDOW_WIDTH_GATE_NODES.guarded}" calculate="${attribute(countGuarded(WINDOW_WIDTH_PATH))}"/>
    </model>
  </h:head>
  <h:body>
    <input ref="/data/note">
      <label>Note</label>
    </input>
  </h:body>
</h:html>
`;
}
