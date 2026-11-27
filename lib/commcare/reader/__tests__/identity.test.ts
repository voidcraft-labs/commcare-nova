/**
 * The minter of the UUIDs a reading of a CommCare HQ app gives. Catches a
 * changed namespace, version string or name layout (which would re-id every
 * app a later reading brings in), a kind left out of the name, a minted UUID
 * the document schema refuses, an identity kind nobody classified, a key met
 * twice that mints twice, a matching resolver that answers a known key
 * with anything but its UUID, one that gives an entity it mints a UUID
 * the map already holds for another (a key renamed in Nova, or an ordinal
 * moved by a removal, beside a key CommCare HQ then added), and a resolver
 * that keeps what one reading claimed, so a second reading given it finds
 * its keys taken.
 */
import { describe, expect, it } from "vitest";
import {
	asUuid,
	BLUEPRINT_AUTHORED_IDENTITY_KINDS,
	uuidSchema,
} from "@/lib/domain";
import {
	claimsUnder,
	EXTERNAL_ENTITY_KINDS,
	type ExternalKey,
	externalKey,
	externalKeyText,
	type IdentityMapEntry,
	KINDS_WITH_NO_EXTERNAL_KEY,
	matchingResolver,
	mintEntityUuid,
	mintingResolver,
} from "../identity";

const APP_ID = "3f2c9a1e-5b7d-4c8e-9f10-2a3b4c5d6e7f";
/** A form's UUID, which an opening record's and value's keys name. */
const FORM_UUID = "8b1f6c2e-4d3a-4e5f-9a0b-1c2d3e4f5a6b";
const XMLNS =
	"http://openrosa.org/formdesigner/1A2B3C4D-0000-4000-8000-ABCDEF012345";

describe("mintEntityUuid", () => {
	it("mints the golden UUIDs", () => {
		expect(
			mintEntityUuid(
				APP_ID,
				externalKey.module("a1b2c3d4e5f60718293a4b5c6d7e8f90"),
			),
		).toBe("378c6a63-9d66-56ad-b0f2-06b79ad46109");
		expect(mintEntityUuid(APP_ID, externalKey.form(XMLNS))).toBe(
			"82b5fae7-6161-544d-8549-a3814e6670df",
		);
		expect(
			mintEntityUuid(
				APP_ID,
				externalKey.field(XMLNS, ["household", "head_name"]),
			),
		).toBe("032e17ab-28fd-5672-a25e-3a1122d8fc42");
		expect(
			mintEntityUuid(
				APP_ID,
				externalKey.selectOption(XMLNS, ["household", "sex"], "f"),
			),
		).toBe("21202100-d17b-5467-a6c6-47fa90e94f17");
	});

	it("gives equal parts under two kinds two UUIDs", () => {
		const slug = "district";
		expect(mintEntityUuid(APP_ID, externalKey.userProperty(slug))).not.toBe(
			mintEntityUuid(APP_ID, externalKey.locationProperty(slug)),
		);
	});

	it("gives one key under two apps two UUIDs", () => {
		const key = externalKey.form(XMLNS);
		expect(mintEntityUuid(APP_ID, key)).not.toBe(
			mintEntityUuid("another-app", key),
		);
	});

	it("uses every part exactly as read", () => {
		const uuids = [" f", "f", "F", "é", "é"].map((value) =>
			mintEntityUuid(APP_ID, externalKey.selectOption(XMLNS, ["sex"], value)),
		);
		expect(new Set(uuids).size).toBe(uuids.length);
	});

	it("mints a UUID the document schema admits, of version 5", () => {
		const keys: ExternalKey[] = [
			externalKey.module("a1b2c3d4e5f60718293a4b5c6d7e8f90"),
			externalKey.form(XMLNS),
			externalKey.field(XMLNS, ["q"]),
			externalKey.selectOption(XMLNS, ["q"], "v"),
			externalKey.caseListColumn("m", "calculated", "", 0),
			externalKey.caseListSort("m", "priority", 0),
			externalKey.caseDetailTab(
				externalKey.caseListColumn("m", "calculated", "", 0),
				[],
			),
			externalKey.caseMappingRow(
				uuidSchema.parse("378c6a63-9d66-56ad-b0f2-06b79ad46109"),
				JSON.stringify(["selected", "a"]),
			),
			externalKey.searchInput("m", "name"),
			externalKey.searchInputGroup("m", ["name"], 1),
			externalKey.projectSearch(17),
			externalKey.projectSearchParameter("m", "district", 1),
			externalKey.installationProfile("field-team"),
			externalKey.searchFilter("m", "owner_id", 0),
			externalKey.caseOperation(XMLNS, ["basic", "subcase", 2], "create", 1),
			externalKey.formLink(XMLNS, ["this-form"], 0),
			externalKey.entryPoint("module", "m", "case-list"),
			externalKey.userProperty("slug"),
			externalKey.organizationLevel("district"),
			externalKey.locationProperty("slug"),
			externalKey.formSelection(asUuid(FORM_UUID), "household"),
			externalKey.entryValue(asUuid(FORM_UUID), "visit_day"),
			externalKey.openingAssignment(
				asUuid(FORM_UUID),
				"own",
				asUuid("5f6e7d8c-9b0a-4f1e-8d2c-3b4a59687766"),
			),
		];
		expect(new Set(keys.map((key) => key.kind))).toEqual(
			new Set(EXTERNAL_ENTITY_KINDS),
		);
		for (const key of keys) {
			const uuid = mintEntityUuid(APP_ID, key);
			expect(uuidSchema.safeParse(uuid).success).toBe(true);
			expect(uuid[14]).toBe("5");
		}
	});
});

describe("the key table", () => {
	it("classifies every authored identity kind exactly once", () => {
		const classified = [
			...EXTERNAL_ENTITY_KINDS,
			...KINDS_WITH_NO_EXTERNAL_KEY,
		] as string[];
		expect(new Set(classified).size).toBe(classified.length);
		expect([...classified].sort()).toEqual(
			[...BLUEPRINT_AUTHORED_IDENTITY_KINDS].sort(),
		);
	});

	it("spells each key as its kind followed by its parts", () => {
		expect(
			externalKeyText(
				externalKey.caseOperation(
					XMLNS,
					["save-to-case", ["kids"], ["nova_operations", "visit"]],
					"update",
					3,
				),
			),
		).toBe(
			JSON.stringify([
				"caseOperation",
				XMLNS,
				["save-to-case", ["kids"], ["nova_operations", "visit"]],
				"update",
				3,
			]),
		);
		expect(externalKey.entryPoint("form", XMLNS)).toEqual({
			kind: "entryPoint",
			parts: ["form", XMLNS],
		});
	});

	it("refuses an ordinal that is not a whole number from 0", () => {
		expect(() => externalKey.caseListColumn("m", "plain", "age", -1)).toThrow(
			/whole number/,
		);
		expect(() => externalKey.formLink(XMLNS, ["this-form"], 0.5)).toThrow(
			/whole number/,
		);
	});

	it("keeps a key from a later change of the array it was built from", () => {
		const path = ["household", "head_name"];
		const key = externalKey.field(XMLNS, path);
		path[1] = "renamed";
		expect(externalKeyText(key)).toBe(
			JSON.stringify(["field", XMLNS, ["household", "head_name"]]),
		);
	});
});

describe("mintingResolver", () => {
	it("mints each key once and answers a second claim with the first place", () => {
		const resolver = claimsUnder(mintingResolver(APP_ID));
		const key = externalKey.selectOption(XMLNS, ["sex"], "f");
		const first = resolver.claim(key, "form 1, question sex, choice 1");
		expect(first).toEqual({ ok: true, uuid: mintEntityUuid(APP_ID, key) });
		const second = resolver.claim(
			externalKey.selectOption(XMLNS, ["sex"], "f"),
			"form 1, question sex, choice 2",
		);
		expect(second).toEqual({
			ok: false,
			key,
			firstPlace: "form 1, question sex, choice 1",
		});
		expect(resolver.entries()).toEqual([
			{ kind: key.kind, parts: key.parts, uuid: mintEntityUuid(APP_ID, key) },
		]);
	});

	it("lists every claimed key in the order of its text", () => {
		const resolver = claimsUnder(mintingResolver(APP_ID));
		const keys = [
			externalKey.userProperty("zone"),
			externalKey.form(XMLNS),
			externalKey.field(XMLNS, ["b"]),
			externalKey.field(XMLNS, ["a"]),
			externalKey.module("m"),
		];
		keys.forEach((key, i) => {
			resolver.claim(key, `place ${i}`);
		});
		expect(resolver.entries().map((entry) => externalKeyText(entry))).toEqual(
			keys.map(externalKeyText).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		);
	});

	it("keeps nothing a reading claimed, so claims under it again start with none taken", () => {
		const resolver = mintingResolver(APP_ID);
		const key = externalKey.module("m");
		const first = claimsUnder(resolver);
		const second = claimsUnder(resolver);
		const claimed = first.claim(key, "menu 1");
		expect(claimed).toEqual({ ok: true, uuid: mintEntityUuid(APP_ID, key) });
		expect(second.entries()).toEqual([]);
		expect(second.claim(key, "menu 1")).toEqual(claimed);
		expect(second.entries()).toEqual(first.entries());
	});
});

describe("matchingResolver", () => {
	const knownKey = externalKey.field(XMLNS, ["household", "head_name"]);
	const knownUuid = uuidSchema.parse("6f1d2c3b-4a59-4687-9a1b-2c3d4e5f6a7b");
	const known: IdentityMapEntry[] = [
		{ kind: knownKey.kind, parts: knownKey.parts, uuid: knownUuid },
	];

	it("answers a known key with its UUID and mints an unknown one", () => {
		const resolver = claimsUnder(matchingResolver(APP_ID, known));
		expect(
			resolver.claim(
				externalKey.field(XMLNS, ["household", "head_name"]),
				"form 1",
			),
		).toEqual({ ok: true, uuid: knownUuid });
		const unknown = externalKey.field(XMLNS, ["household", "age"]);
		expect(resolver.claim(unknown, "form 1")).toEqual({
			ok: true,
			uuid: mintEntityUuid(APP_ID, unknown),
		});
		expect(resolver.claim(knownKey, "form 2")).toEqual({
			ok: false,
			key: knownKey,
			firstPlace: "form 1",
		});
	});

	it("refuses a map that holds one key twice", () => {
		const other = uuidSchema.parse("7a1d2c3b-4a59-4687-9a1b-2c3d4e5f6a7b");
		expect(() =>
			matchingResolver(APP_ID, [
				...known,
				{ kind: knownKey.kind, parts: knownKey.parts, uuid: other },
			]),
		).toThrow(/names the key .* twice \(entries 0 and 1\)/);
	});

	it("refuses a map that holds one UUID under two keys", () => {
		const otherKey = externalKey.field(XMLNS, ["household", "age"]);
		expect(() =>
			matchingResolver(APP_ID, [
				...known,
				{ kind: otherKey.kind, parts: otherKey.parts, uuid: knownUuid },
			]),
		).toThrow(/names the UUID .* twice \(entries 0 and 1\)/);
	});

	it("gives a new entity another UUID where the map holds its key's UUID under a renamed one", () => {
		/* A first reading minted field `a`; Nova renamed it `b`, which kept the UUID; CommCare HQ
		 * then added a new `a`. */
		const a = externalKey.field(XMLNS, ["a"]);
		const b = externalKey.field(XMLNS, ["b"]);
		const renamed = mintEntityUuid(APP_ID, a);
		const map: IdentityMapEntry[] = [
			{ kind: b.kind, parts: b.parts, uuid: renamed },
		];
		const resolver = matchingResolver(APP_ID, map);
		const first = claimsUnder(resolver);
		expect(first.claim(b, "form 1")).toEqual({ ok: true, uuid: renamed });
		const added = first.claim(a, "form 1");
		if (!added.ok) throw new Error("The new field was claimed once.");
		expect(added.uuid).not.toBe(renamed);
		expect(uuidSchema.parse(added.uuid)).toBe(added.uuid);
		/* Another reading told the same map gives the same UUID, whatever it claims first. */
		const second = claimsUnder(resolver);
		expect(second.claim(a, "form 1")).toEqual(added);
		expect(second.claim(b, "form 1")).toEqual({ ok: true, uuid: renamed });
	});

	it("gives two columns of one property two UUIDs after the first was removed in Nova", () => {
		/* Two columns of `x` were minted at ordinals 0 and 1; the first was removed, so the
		 * second's key is ordinal 0 while it keeps ordinal 1's UUID; CommCare HQ then added a
		 * second column of `x`. */
		const at = (n: number) =>
			externalKey.caseListColumn("menu-1", "plain", "x", n);
		const map: IdentityMapEntry[] = [
			{
				kind: "caseListColumn",
				parts: at(0).parts,
				uuid: mintEntityUuid(APP_ID, at(1)),
			},
		];
		const resolver = claimsUnder(matchingResolver(APP_ID, map));
		const kept = resolver.claim(at(0), "menu 1");
		const added = resolver.claim(at(1), "menu 1");
		expect(kept).toEqual({ ok: true, uuid: mintEntityUuid(APP_ID, at(1)) });
		if (!kept.ok || !added.ok) throw new Error("Each column was claimed once.");
		expect(added.uuid).not.toBe(kept.uuid);
		expect(resolver.entries().map((entry) => entry.uuid)).toEqual([
			kept.uuid,
			added.uuid,
		]);
	});
});

it.each(["", "vvv", "v00000003_"])(
	"recognizes a translated piece across native and emitted names only within its own calculated field (%s)",
	(prefix) => {
		const owner = mintEntityUuid(APP_ID, externalKey.module("owner"));
		const other = mintEntityUuid(APP_ID, externalKey.module("another"));
		const native = externalKey.caseCalculationText(owner, "greeting");
		const uuid = mintEntityUuid(APP_ID, native);
		const generated = `${prefix}case_text_${uuid.replaceAll("-", "")}`;
		const printed = externalKey.caseCalculationText(owner, generated);
		const imported = matchingResolver(APP_ID, [{ ...native, uuid }]);
		expect(imported.uuidOf(printed)).toBe(uuid);
		expect(
			matchingResolver(APP_ID, [{ ...printed, uuid }]).uuidOf(native),
		).toBe(uuid);
		expect(
			imported.uuidOf(externalKey.caseCalculationText(other, generated)),
		).not.toBe(uuid);
		expect(
			imported.uuidOf(printed, undefined, new Set([externalKeyText(native)])),
		).not.toBe(uuid);
		expect(mintingResolver(APP_ID).uuidOf(printed)).not.toBe(uuid);
	},
);
