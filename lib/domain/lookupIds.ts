import { z } from "zod";

declare const lookupTableIdBrand: unique symbol;
declare const lookupColumnIdBrand: unique symbol;
declare const lookupRowIdBrand: unique symbol;

/** Stable server-minted identity for one Project lookup table. */
export type LookupTableId = string & {
	readonly [lookupTableIdBrand]: true;
};

/** Stable server-minted identity for one column within a lookup table. */
export type LookupColumnId = string & {
	readonly [lookupColumnIdBrand]: true;
};

/** Stable server-minted identity for one row within a lookup table. */
export type LookupRowId = string & {
	readonly [lookupRowIdBrand]: true;
};

const UUID_V7_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function lookupUuidV7Schema<Identity extends string>() {
	return z
		.string()
		.regex(UUID_V7_PATTERN, "Expected a UUIDv7 identifier.")
		.transform((value) => value.toLowerCase() as Identity);
}

export const lookupTableIdSchema = lookupUuidV7Schema<LookupTableId>();
export const lookupColumnIdSchema = lookupUuidV7Schema<LookupColumnId>();
export const lookupRowIdSchema = lookupUuidV7Schema<LookupRowId>();
