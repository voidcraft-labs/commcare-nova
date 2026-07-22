/** Stable lookup-table limits shared by parsing, persistence, and routes. */

export const LOOKUP_MAX_ROWS = 5_000;
export const LOOKUP_MAX_COLUMNS = 250;
export const LOOKUP_MAX_CELL_BYTES = 64 * 1_024;
export const LOOKUP_MAX_ROW_BYTES = 256 * 1_024;
export const LOOKUP_MAX_TABLE_BYTES = 8 * 1_024 * 1_024;
export const LOOKUP_MAX_CSV_BYTES = 8 * 1_024 * 1_024;
export const LOOKUP_MAX_VALIDATION_DETAILS = 100;

export const LOOKUP_MAX_TABLE_NAME_LENGTH = 120;
export const LOOKUP_MAX_COLUMN_LABEL_LENGTH = 120;
export const LOOKUP_MAX_TAG_LENGTH = 32;
export const LOOKUP_MAX_WIRE_NAME_LENGTH = 255;

export const LOOKUP_INT4_MIN = -2_147_483_648;
export const LOOKUP_INT4_MAX = 2_147_483_647;
export const LOOKUP_REVISION_MAX = BigInt("9223372036854775807");

export const LOOKUP_DATA_TYPES = [
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
] as const;

/** ASCII identifiers accepted by the lookup wire boundary. */
export const LOOKUP_WIRE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const LOOKUP_XML_PREFIX_PATTERN = /^xml/i;
