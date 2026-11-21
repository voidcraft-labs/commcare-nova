/**
 * Where a claim's record stands in the claim log: where the value of the
 * surface key it names sits, which is where the lane's parity looks for it
 * (`proof/checks/parity.py::join`, keyed on artifact and place).
 *
 * It would catch a refusal of a JSON key recorded at the key while it names
 * the key of an object above (a profile setting refused under
 * `schema:Application.profile`), a refusal of an element whole recorded at
 * the element while it names one of the element's attributes (an inline
 * instance refused under `xform:model/instance@id`), and an itext value's form
 * recorded at the `<value>` while the form is its `form` attribute's value.
 */

import type { Document, Element } from "domhandler";
import { isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { inventoryIndex } from "../../surface/inventory";
import { parseXml } from "../../xmlParse";
import { Accounting } from "../accounting";
import { account, defineClaims, refuse, take } from "../claims";
import { appPlace, formPlace } from "../place";

const A = "application-and-settings";
const PROFILE = "schema:Application.profile";

const CLAIMS = defineClaims("recordedPlaceTest", {
	profile: account(
		`${A}/any-other-profile-properties-features-key-not-in-the-yaml`,
		PROFILE,
	),
	sense: refuse(
		`${A}/profile-features-sense-true-or-profile-properties-cc-entry-mode`,
		PROFILE,
	),
	setting: account(
		`${A}/32-features-credentials`,
		"setting:features.credentials",
	),
	inline: refuse(
		"expressions-and-data/inline-instance-content-inside-instance-no-src",
		"xform:model/instance@id",
	),
	markdown: take(
		"questions/markdown-form-equal-to-the-default-text",
		"itext-form:core/markdown",
	),
	value: take(
		"questions/label-default-text-itext-value",
		"xform:model/itext/translation/text/value",
	),
});

const APP = appPlace();
const FORM = formPlace(0, 0, "Visits", "Register");

function books(): Accounting {
	return new Accounting(inventoryIndex(), { log: "full" });
}

function records(closed: ReturnType<Accounting["close"]>) {
	return [...closed.claims.records()].map(({ where, key, entry }) => ({
		where,
		key,
		entry,
	}));
}

describe("a JSON claim's record", () => {
	it("stands where the key it names sits: the profile, for a setting refused under the profile's key", () => {
		const ledger = books();
		const app = ledger.json(
			{ profile: { features: { sense: "true", credentials: "x" } } },
			APP,
		);
		const profile = app.object(
			"profile",
			"Application.profile",
			CLAIMS.profile,
		);
		const features = profile.object(
			"features",
			"Application.profile.features",
			CLAIMS.profile,
		);
		features.refuse("sense", CLAIMS.sense, { name: "sense" });
		features.account("credentials", CLAIMS.setting);
		const closed = ledger.close();
		expect(closed.findings.map((finding) => finding.code)).toEqual([
			CLAIMS.sense.entry,
		]);
		expect(records(closed)).toEqual([
			{ where: "/profile", key: PROFILE, entry: CLAIMS.profile.entry },
			{ where: "/profile", key: PROFILE, entry: CLAIMS.profile.entry },
			{ where: "/profile", key: PROFILE, entry: CLAIMS.sense.entry },
			{
				where: "/profile/features/credentials",
				key: "setting:features.credentials",
				entry: CLAIMS.setting.entry,
			},
		]);
	});

	it("stands at a part's key beside the key's own claim, one finding a part", () => {
		const ledger = books();
		const app = ledger.json({ profile: { features: { sense: "true" } } }, APP);
		app.refusePart("profile", "features/sense", CLAIMS.sense, {
			name: "sense",
		});
		app.refusePart("profile", "features/sense", CLAIMS.sense, {
			name: "sense",
		});
		app.account("profile", CLAIMS.profile);
		const closed = ledger.close();
		expect(closed.defects.map((defect) => defect.why)).toEqual([
			expect.stringContaining("claimed twice"),
		]);
		expect(
			records(closed).filter((record) => record.entry === CLAIMS.sense.entry),
		).toEqual([{ where: "/profile", key: PROFILE, entry: CLAIMS.sense.entry }]);
	});
});

const XFORM = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
	<h:head>
		<model>
			<instance id="choices"><root><item>a</item></root></instance>
			<itext><translation lang="en"><text id="q-label"><value>Q</value><value form="markdown">Q</value></text></translation></itext>
		</model>
	</h:head>
</h:html>`;

function child(parent: Document | Element, local: string): Element {
	const found = parent.children.find(
		(node): node is Element =>
			isTag(node) && node.name.split(":").pop() === local,
	);
	if (found === undefined) throw new Error(`No ${local} element.`);
	return found;
}

describe("an XML claim's record", () => {
	const document = parseXml(XFORM);
	const model = child(child(child(document, "html"), "head"), "model");
	const instance = child(model, "instance");
	const text = child(child(child(model, "itext"), "translation"), "text");
	const [plain, markdown] = text.children.filter(isTag) as Element[];
	if (plain === undefined || markdown === undefined)
		throw new Error("No two values.");

	it("stands at the attribute the claim's key names, for an element refused whole", () => {
		const ledger = books();
		const cursor = ledger.xml(document, 0, 0, FORM);
		cursor.refuseSubtree(instance, CLAIMS.inline, FORM, { name: "choices" });
		expect(
			records(ledger.close()).filter(
				(record) => record.entry === CLAIMS.inline.entry,
			),
		).toEqual([
			{
				where: "/h:html/h:head[1]/model[1]/instance[1]/@id",
				key: "xform:model/instance@id",
				entry: CLAIMS.inline.entry,
			},
		]);
	});

	it("stands at a value's `form` for the itext form the claim names, and at the value for its text", () => {
		const ledger = books();
		const cursor = ledger.xml(document, 0, 0, FORM);
		expect(cursor.take({ element: plain }, CLAIMS.value).value).toBe("Q");
		expect(cursor.takeSubtree(markdown, CLAIMS.markdown).value).toBe(markdown);
		const values = records(ledger.close()).filter((record) =>
			record.where.includes("/value["),
		);
		expect(values).toEqual([
			{
				where:
					"/h:html/h:head[1]/model[1]/itext[1]/translation[1]/text[1]/value[1]",
				key: "xform:model/itext/translation/text/value",
				entry: CLAIMS.value.entry,
			},
			{
				where:
					"/h:html/h:head[1]/model[1]/itext[1]/translation[1]/text[1]/value[2]/@form",
				key: "itext-form:core/markdown",
				entry: CLAIMS.markdown.entry,
			},
		]);
	});
});
