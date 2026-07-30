import { sql } from "kysely";
import { describe, expect, test } from "vitest";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import {
	frozenJsonSourceBytes,
	verifyFrozenJsonCarriers,
} from "../20260728000000_canonical_identity_foundation/frozenJsonCarriers";
import { materializeFrozenBlueprintJson } from "../20260728000000_canonical_identity_foundation/frozenPersistableBlueprintDecoder";

const h = setupPerTestDatabase({
	databaseNamePrefix: "frozen_json_carriers_",
});

async function sourceTexts(): Promise<{
	safe_integer: string;
	exact_unsafe_integer: string;
	unsafe_integer: string;
	scaled_decimal: string;
	fraction: string;
	prototype_keys: string;
	json_null: string;
}> {
	const result = await sql<{
		safe_integer: string;
		exact_unsafe_integer: string;
		unsafe_integer: string;
		scaled_decimal: string;
		fraction: string;
		prototype_keys: string;
		json_null: string;
	}>`
		SELECT
			'{"n":9007199254740991}'::jsonb::text AS safe_integer,
			'{"n":9007199254740992}'::jsonb::text AS exact_unsafe_integer,
			'{"n":9007199254740993}'::jsonb::text AS unsafe_integer,
			'{"n":1.00}'::jsonb::text AS scaled_decimal,
			'{"n":0.1}'::jsonb::text AS fraction,
			'{"__proto__":{"ok":true},"constructor":"own"}'::jsonb::text
				AS prototype_keys,
			'null'::jsonb::text AS json_null
	`.execute(h.db);
	const row = result.rows[0];
	if (row === undefined)
		throw new Error("Frozen JSON fixture query returned no row.");
	return row;
}

describe("frozen JSON carrier gate", () => {
	test("returns branded values only after exact PostgreSQL round-trip proof", async () => {
		const source = await sourceTexts();
		const verified = await verifyFrozenJsonCarriers(h.db, [
			{ id: "safe-integer", sourceText: source.safe_integer },
			{ id: "fraction", sourceText: source.fraction },
			{ id: "prototype-keys", sourceText: source.prototype_keys },
			{ id: "json-null", sourceText: source.json_null },
			{ id: "sql-null", sourceText: null },
		]);

		const safe = verified.get("safe-integer");
		const fraction = verified.get("fraction");
		const prototypeKeys = verified.get("prototype-keys");
		const jsonNull = verified.get("json-null");
		const sqlNull = verified.get("sql-null");
		if (
			safe === undefined ||
			fraction === undefined ||
			prototypeKeys === undefined ||
			jsonNull === undefined ||
			sqlNull === undefined
		) {
			throw new Error("Frozen JSON carrier disappeared.");
		}

		const materialize = <T>(carrier: NonNullable<typeof safe>): T | null => {
			const result = materializeFrozenBlueprintJson<T>(carrier, {
				id: `carrier_test:${carrier.sourceDigest}`,
			});
			return result.kind === "sql-null" ? null : result.value;
		};
		expect(materialize(safe)).toEqual({ n: 9_007_199_254_740_991 });
		expect(materialize(fraction)).toEqual({ n: 0.1 });
		const prototypeValue = materialize<Record<string, unknown>>(prototypeKeys);
		if (prototypeValue === null) {
			throw new Error("Prototype fixture materialized as SQL NULL.");
		}
		expect(Object.hasOwn(prototypeValue, "__proto__")).toBe(true);
		expect(Object.hasOwn(prototypeValue, "constructor")).toBe(true);
		expect(materialize(jsonNull)).toBeNull();
		expect(materialize(sqlNull)).toBeNull();
		expect(jsonNull.sourceText).toBe("null");
		expect(sqlNull.sourceText).toBeNull();
		expect(frozenJsonSourceBytes(safe)).toBe(
			Buffer.byteLength(source.safe_integer, "utf8"),
		);
		expect(safe.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
	});

	test("keeps non-runtime numeric lexemes opaque until a semantic decoder", async () => {
		const source = await sourceTexts();
		for (const [id, sourceText] of [
			["exact-unsafe-integer", source.exact_unsafe_integer],
			["unsafe-integer", source.unsafe_integer],
			["scaled-decimal", source.scaled_decimal],
		] as const) {
			const verified = await verifyFrozenJsonCarriers(h.db, [
				{ id, sourceText },
			]);
			const carrier = verified.get(id);
			if (carrier === undefined) throw new Error("Opaque carrier disappeared.");
			expect(carrier.sourceText).toBe(sourceText);
			expect(() =>
				materializeFrozenBlueprintJson(carrier, {
					id: `carrier_test:${carrier.sourceDigest}`,
				}),
			).toThrow(
				/Frozen persisted Blueprint carrier_test:[0-9a-f]{64} failed canonicality validation/,
			);
		}
	});

	test("rejects duplicate identifiers and invalid source text before exposure", async () => {
		await expect(
			verifyFrozenJsonCarriers(h.db, [
				{ id: "same", sourceText: "null" },
				{ id: "same", sourceText: "null" },
			]),
		).rejects.toThrow(/identifiers must be unique/);
		await expect(
			verifyFrozenJsonCarriers(h.db, [
				{ id: "invalid", sourceText: "not-json" },
			]),
		).rejects.toThrow(
			/Frozen JSON carrier invalid is not valid JSON \([0-9a-f]{64}\)/,
		);
	});
});
