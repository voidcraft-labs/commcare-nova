/** A namespace-free XML 1.0 (fifth edition) Name. The unqualified
 * spelling must survive as one element in the fixture. XPath has a
 * narrower portable alphabet, checked where a worker reads that name. */
const XML_NAME_START =
	"A-Z_a-z\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u02ff\\u0370-\\u037d\\u037f-\\u1fff\\u200c-\\u200d\\u2070-\\u218f\\u2c00-\\u2fef\\u3001-\\ud7ff\\uf900-\\ufdcf\\ufdf0-\\ufffd\\u{10000}-\\u{effff}";
const XML_NAME_CONTINUATION = ".0-9\\u00b7\\u0300-\\u036f\\u203f-\\u2040-";
export const XML_NCNAME_PATTERN = new RegExp(
	`^[${XML_NAME_START}][${XML_NAME_START}${XML_NAME_CONTINUATION}]*$`,
	"u",
);
