/** Attributes JavaRosa exposes on the emitted primary `<data>` element. */
export interface XFormDataRootRuntimeAttributes {
	readonly uiVersion: "1";
	readonly version: "1";
	readonly name: string;
}

/**
 * Project a Nova form name into the exact non-namespace attributes emitted on
 * the primary instance root. Preview consumes this same projection so raw
 * XPath over `/data/@*` cannot drift from the compiled XForm.
 */
export function xformDataRootRuntimeAttributes(
	formName: string,
): XFormDataRootRuntimeAttributes {
	return {
		uiVersion: "1",
		version: "1",
		name: formName.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
	};
}
