/** Attributes JavaRosa exposes on the emitted primary `<data>` element. */
export interface XFormDataRootRuntimeAttributes {
	readonly uiVersion: "1";
	readonly version: "1";
	readonly name: string;
}

/**
 * The exact non-namespace attributes emitted on the primary instance root.
 * `name` is the form's wire name (`lib/domain/formWireName.ts`) as given,
 * the same string `<h:title>` holds, because HQ's form builder writes the
 * form's name into both on every save. Preview consumes this same
 * projection so raw XPath over `/data/@*` cannot drift from the compiled
 * XForm.
 */
export function xformDataRootRuntimeAttributes(
	formWireName: string,
): XFormDataRootRuntimeAttributes {
	return {
		uiVersion: "1",
		version: "1",
		name: formWireName,
	};
}
