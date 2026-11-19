/**
 * The app comparison over CommCare HQ's own answers. Every input is a read
 * HQ gave (`proof/hq-reads/`), whole or with the one edit a case names, so
 * the normalization and the comparison are held to what HQ actually serves
 * and never to a hand-written app source.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readHqApp } from "@/lib/commcare/reader";
import {
	readerInput,
	sourceFromBody,
} from "@/lib/commcare/reader/__tests__/readerInput";
import { schemaPropertyDefault } from "@/lib/commcare/surface/schemaDefaults";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import { adoptedAppBaselineWrite, adoptedIdentityRows } from "../adoption";
import {
	type AppChangePart,
	diffHqAppSource,
	normalizeHqAppSource,
} from "../hqSourceBaseline";
import type { AppOwnership } from "../types";

const READS = path.join(process.cwd(), "proof/hq-reads");

type Source = Record<string, unknown> & {
	modules: (Record<string, unknown> & { forms: Record<string, unknown>[] })[];
};

/** The body of one retained HQ answer (`{ status, headers, body }`). */
function retainedRead(relative: string): Source {
	const answer = JSON.parse(readFileSync(path.join(READS, relative), "utf8"));
	return JSON.parse(answer.body) as Source;
}

function retainedOwnership(relative: string): AppOwnership {
	return JSON.parse(
		readFileSync(path.join(READS, relative), "utf8"),
	) as AppOwnership;
}

function normalized(source: unknown) {
	const result = normalizeHqAppSource(source);
	if ("malformed" in result) {
		throw new Error(`A retained read did not normalize: ${result.malformed}`);
	}
	return result;
}

function diff(
	baseline: unknown,
	current: unknown,
	ownership: AppOwnership,
	options: {
		shell?: boolean;
		languageNames?: "nova" | "target";
	} = {},
): readonly AppChangePart[] {
	return diffHqAppSource({
		baseline: normalized(baseline).normalized,
		current: normalized(current).normalized,
		ownership,
		shell: options.shell ?? false,
		languageNames: options.languageNames ?? "nova",
	});
}

/** `navigation-base` as HQ served it after Nova's first publish, one menu holding `Visit` and `Register`. */
const NAVIGATION_BASE = "navigation-base/app-source.json";
/** The ownership that publish's answer returned. */
const NAVIGATION_BASE_OWNERSHIP = "navigation-base/ownership.json";

function edited(edit: (source: Source) => void): Source {
	const source = retainedRead(NAVIGATION_BASE);
	edit(source);
	return source;
}

describe("normalizing a read", () => {
	it("keeps only the current forms' attachments, under their tokens, and no admin password", () => {
		const source = retainedRead(NAVIGATION_BASE);
		(source._attachments as Record<string, string>)["orphan.xml"] = "<h:html/>";
		const { normalized: result, text } = normalized(source);
		const out = result as Source;
		expect(Object.keys(out._attachments as object).sort()).toEqual([
			"m0.f0.xml",
			"m0.f1.xml",
		]);
		const [visit] = source.modules[0]?.forms ?? [];
		expect((out._attachments as Record<string, string>)["m0.f0.xml"]).toBe(
			(source._attachments as Record<string, string>)[
				`${String(visit?.unique_id)}.xml`
			],
		);
		expect(out.modules[0]?.forms.map((form) => form.unique_id)).toEqual([
			"m0.f0",
			"m0.f1",
		]);
		expect(text).not.toContain("admin_password");
		expect(text).not.toContain("orphan.xml");
	});

	it("rewrites the four form-id reference paths to tokens and marks one that names no form", () => {
		const source = edited((app) => {
			const module = app.modules[0];
			if (module === undefined) throw new Error("navigation-base has a menu");
			const [visit, register] = module.forms;
			module.case_list_form = { form_id: register?.unique_id, label: {} };
			if (visit !== undefined) {
				visit.form_links = [{ form_id: register?.unique_id }];
				visit.shadow_parent_form_id = "a-form-no-read-holds";
			}
			module.schedule_phases = [{ forms: [{ form_id: visit?.unique_id }] }];
			module.report_configs = [{ uuid: "minted-per-read", report_slug: "" }];
		});
		const out = normalized(source).normalized as Source;
		const module = out.modules[0] as Record<string, unknown> & {
			forms: Record<string, unknown>[];
		};
		expect(module.case_list_form).toEqual({ form_id: "m0.f1", label: {} });
		expect(module.forms[0]?.form_links).toEqual([{ form_id: "m0.f1" }]);
		expect(module.forms[0]?.shadow_parent_form_id).toEqual({
			unresolved: "a-form-no-read-holds",
		});
		expect(module.schedule_phases).toEqual([{ forms: [{ form_id: "m0.f0" }] }]);
		expect(module.report_configs).toEqual([{ report_slug: "" }]);
	});

	it("refuses anything that is not an Application source", () => {
		expect(normalizeHqAppSource({ doc_type: "LinkedApplication" })).toEqual({
			malformed: "doc_type",
		});
		expect(normalizeHqAppSource(null)).toEqual({ malformed: "doc_type" });
	});
});

describe("comparing two reads", () => {
	const base = retainedRead(NAVIGATION_BASE);
	const ownership = retainedOwnership(NAVIGATION_BASE_OWNERSHIP);

	it("names a removed menu, and a menu added after or before the first, as the list of menus alone", () => {
		const removed = edited((app) => {
			app.modules = [];
		});
		const second = (atStart: boolean) =>
			edited((app) => {
				const [menu] = app.modules;
				if (menu === undefined) throw new Error("navigation-base has a menu");
				const added = {
					...structuredClone(menu),
					unique_id: "another-menu",
					forms: [],
				};
				app.modules = atStart ? [added, menu] : [menu, added];
			});
		expect(diff(base, removed, ownership)).toEqual([{ kind: "menu-list" }]);
		expect(diff(base, second(false), ownership)).toEqual([
			{ kind: "menu-list" },
		]);
		expect(diff(base, second(true), ownership)).toEqual([
			{ kind: "menu-list" },
		]);
	});

	it("names a form added to a menu as that menu, and a changed form label as the form in its menu", () => {
		const added = edited((app) => {
			const module = app.modules[0];
			const [visit] = module?.forms ?? [];
			module?.forms.push({
				...structuredClone(visit),
				unique_id: "third-form",
			});
		});
		expect(diff(base, added, ownership)).toEqual([
			{ kind: "menu", menu: 0, name: "Patients" },
		]);
		const relabeled = edited((app) => {
			const register = app.modules[0]?.forms[1];
			if (register !== undefined) register.name = { en: "Enroll" };
		});
		expect(diff(base, relabeled, ownership)).toEqual([
			{ kind: "form", menu: 0, form: 1, name: "Enroll", menuName: "Patients" },
		]);
	});

	it("names a form changed only in its attachment text", () => {
		const changed = edited((app) => {
			const visit = app.modules[0]?.forms[0];
			const attachments = app._attachments as Record<string, string>;
			const key = `${String(visit?.unique_id)}.xml`;
			attachments[key] = `${attachments[key]} `;
		});
		expect(diff(base, changed, ownership)).toEqual([
			{ kind: "form", menu: 0, form: 0, name: "Visit", menuName: "Patients" },
		]);
	});

	it("names each thing from HQ's current read, falling back from the read's languages to the map's first text to the position", () => {
		const named = (name: unknown) =>
			edited((app) => {
				app.langs = ["en", "fr"];
				const module = app.modules[0];
				if (module !== undefined) module.name = name;
			});
		const withLangs = (source: Source) => {
			source.langs = ["en", "fr"];
			return source;
		};
		const menuName = (name: unknown) => {
			const [part] = diff(
				withLangs(retainedRead(NAVIGATION_BASE)),
				named(name),
				ownership,
			);
			return part?.kind === "menu" ? part.name : part;
		};
		expect(menuName({ fr: "Patients FR" })).toBe("Patients FR");
		expect(menuName({ sw: "Wagonjwa" })).toBe("Wagonjwa");
		expect(menuName({ en: "", fr: "" })).toBe("#1");
	});

	it("lists the parts in their stated order", () => {
		const changed = edited((app) => {
			const visit = app.modules[0]?.forms[0];
			if (visit !== undefined) visit.name = { en: "Follow up" };
			const module = app.modules[0];
			if (module !== undefined) module.case_type = "client";
			app.name = "Renamed in HQ";
			app.langs = ["en", "fr"];
			app.application_version = "1.0";
			app.translations = { en: { en: "Anglais" } };
		});
		expect(diff(base, changed, ownership).map((part) => part.kind)).toEqual([
			"menu",
			"form",
			"name",
			"languages",
			"settings",
			"text",
		]);
	});

	it("reads only Nova's part of the translations: a target key and an add-on Nova does not need are no change, a language's name is one", () => {
		const target = edited((app) => {
			const translations = app.translations as Record<
				string,
				Record<string, string>
			>;
			translations.en = { ...translations.en, "home.start": "Begin a visit" };
			translations.fr = { "home.start": "Commencer" };
		});
		const needed = { ...ownership, addOns: ["display_conditions"] };
		expect(diff(base, target, needed)).toEqual([]);
		const addOn = edited((app) => {
			(app.add_ons as Record<string, boolean>).advanced_itemsets = false;
			(app.add_ons as Record<string, boolean>).menu_mode = true;
		});
		expect(diff(base, addOn, needed)).toEqual([]);
		const languageName = edited((app) => {
			(app.translations as Record<string, Record<string, string>>).en.en =
				"Anglais";
		});
		expect(diff(base, languageName, needed)).toEqual([{ kind: "text" }]);
	});

	it("reads no language name on an app Nova brought in, whose names the project space keeps", () => {
		const needed = { ...ownership, addOns: ["display_conditions"] };
		const renamed = edited((app) => {
			(app.translations as Record<string, Record<string, string>>).en.en =
				"Anglais";
		});
		expect(diff(base, renamed, needed, { languageNames: "target" })).toEqual(
			[],
		);
		expect(diff(base, renamed, needed, { languageNames: "nova" })).toEqual([
			{ kind: "text" },
		]);
		/* A generated key is still Nova's there. */
		const generated = edited((app) => {
			(app.translations as Record<string, Record<string, string>>).en[
				"modules.m0"
			] = "Visits, renamed";
		});
		expect(diff(base, generated, needed, { languageNames: "target" })).toEqual([
			{ kind: "text" },
		]);
	});

	/* HQ's build writes a key stripped and on one line, so a key with a space
	 * before a generated string's name, or one that splits its line, sets
	 * another string there: no publish carries it, and one added is a change. */
	it("reads a key that sets another string than its own name as Nova's part", () => {
		const needed = { ...ownership, addOns: ["display_conditions"] };
		for (const key of [" modules.m0", "x=y\nmodules.m0", "a#b"]) {
			const smuggled = edited((app) => {
				(app.translations as Record<string, Record<string, string>>).en[key] =
					"Smuggled";
			});
			for (const languageNames of ["nova", "target"] as const)
				expect(
					diff(base, smuggled, needed, { languageNames }),
					JSON.stringify(key),
				).toEqual([{ kind: "text" }]);
		}
	});

	it("reads add-ons and profile keys only under the baseline's ownership", () => {
		const properties = (app: Source) =>
			(app.profile as { properties: Record<string, string> }).properties;
		const changed = edited((app) => {
			(app.add_ons as Record<string, boolean>).not_nova_s = true;
			properties(app)["cc-foreign"] = "yes";
			app.last_modified = "2030-01-01T00:00:00.000000Z";
		});
		expect(diff(base, changed, ownership)).toEqual([]);
		expect(
			diff(base, changed, {
				...ownership,
				profileProperties: [...ownership.profileProperties, "cc-foreign"],
			}),
		).toEqual([{ kind: "settings" }]);
		const owned = edited((app) => {
			properties(app)["cc-show-saved"] = "yes";
		});
		expect(diff(base, owned, ownership)).toEqual([{ kind: "settings" }]);
		const addOn = edited((app) => {
			(app.add_ons as Record<string, boolean>).advanced_itemsets = true;
		});
		expect(diff(base, addOn, ownership)).toEqual([]);
		expect(
			diff(base, addOn, { ...ownership, addOns: ["advanced_itemsets"] }),
		).toEqual([{ kind: "settings" }]);
	});

	it("leaves the Web App setting to the Web Apps question", () => {
		/* One question covers who moved it (`webApps.ts::webAppsChange`), so
		 * the drift check never asks about the same value a second time. */
		const flipped = edited((app) => {
			app.cloudcare_enabled = !app.cloudcare_enabled;
		});
		expect(diff(base, flipped, ownership)).toEqual([]);
	});
});

describe("a baseline an app brought in from CommCare HQ is born with", () => {
	/** The `read` baseline of the retained source, as an adoption writes it, over the document the reader gives. */
	async function adoptedBaseline() {
		const body = retainedRead(NAVIGATION_BASE);
		const source = await sourceFromBody(body);
		const input = readerInput(source);
		const outcome = await readHqApp({
			...input,
			recordDialect: () => undefined,
		});
		if (outcome.kind !== "read") {
			throw new Error(
				`The retained source did not read: ${outcome.findings.map((finding) => finding.code).join(", ")}`,
			);
		}
		const rows = adoptedIdentityRows(outcome.draft.identities, input.modules);
		if (!rows.ok) throw new Error(`No identity row for ${rows.at}.`);
		const write = adoptedAppBaselineWrite({
			remoteAppId: "hq-app",
			source,
			prepared: {
				doc: outcome.draft.doc,
				assets: new Map(),
				attachmentTarget: null,
			},
			target: { server: "india", domain: "clinic" },
			identity: targetWireIdentity(rows.rows),
			novaRevision: 0,
			mediaFiles: {},
			observedAt: "2026-11-10T09:00:00.000Z",
			firstPublish: { ids: [], touchesWorkers: false, of: "first-publish" },
		});
		const stored = JSON.parse(
			gunzipSync(write.sourceGzip ?? Buffer.alloc(0)).toString("utf8"),
		) as unknown;
		if (write.ownership === null)
			throw new Error("A read baseline holds the ownership it was born with.");
		return { stored, ownership: write.ownership };
	}

	function compared(
		baseline: Awaited<ReturnType<typeof adoptedBaseline>>,
		current: unknown,
	): readonly AppChangePart[] {
		return diffHqAppSource({
			baseline: baseline.stored,
			current: normalized(current).normalized,
			ownership: baseline.ownership,
			shell: false,
			languageNames: "target",
		});
	}

	it("finds no change on the app as CommCare HQ still holds it, and names the one form whose attachment changed", async () => {
		const baseline = await adoptedBaseline();
		expect(compared(baseline, retainedRead(NAVIGATION_BASE))).toEqual([]);
		const changed = edited((app) => {
			const visit = app.modules[0]?.forms[0];
			const attachments = app._attachments as Record<string, string>;
			const key = `${String(visit?.unique_id)}.xml`;
			attachments[key] = `${attachments[key]} `;
		});
		expect(compared(baseline, changed)).toEqual([
			{ kind: "form", menu: 0, form: 0, name: "Visit", menuName: "Patients" },
		]);
	});
});

describe("the schema-growth rule", () => {
	const base = retainedRead(NAVIGATION_BASE);
	const ownership = retainedOwnership(NAVIGATION_BASE_OWNERSHIP);
	/* `Module.comment` (a declared StringProperty whose default is "") stands
	 * in for a property a later HQ adds: the baseline is the read with the
	 * key taken out, as a read made before HQ declared it would be. */
	const older = edited((app) => {
		for (const module of app.modules) delete module.comment;
	});

	it("reads a key added at its manifest default as no change, and at another value as one", () => {
		expect(base.modules[0]?.comment).toBe("");
		expect(schemaPropertyDefault("Module", "comment")).toEqual({
			known: true,
			default: "",
			isMap: false,
		});
		expect(diff(older, base, ownership)).toEqual([]);
		const set = edited((app) => {
			const module = app.modules[0];
			if (module !== undefined) module.comment = "Set in HQ";
		});
		expect(diff(older, set, ownership)).toEqual([
			{ kind: "menu", menu: 0, name: "Patients" },
		]);
	});

	it("reads a detail pair added as a read serves it, with its two details named, as no change", () => {
		/* `Module.ref_details` stands in for a property a later HQ adds whose
		 * default holds a `DetailPair`. The class declares each detail's
		 * `display` null; every read names them `short` and `long`
		 * (`models/modules.py::DetailPair.wrap`), so that is the value a later
		 * read carries. */
		const declared = schemaPropertyDefault("Module", "ref_details");
		const pair = structuredClone(declared.default) as Record<
			string,
			Record<string, unknown>
		>;
		expect(pair.doc_type).toBe("DetailPair");
		expect([pair.short?.display, pair.long?.display]).toEqual([null, null]);
		const served = structuredClone(pair);
		served.short = { ...served.short, display: "short" };
		served.long = { ...served.long, display: "long" };
		const holding = (value: unknown) =>
			edited((app) => {
				const module = app.modules[0];
				if (module !== undefined) module.ref_details = value;
			});
		const without = edited((app) => {
			delete app.modules[0]?.ref_details;
		});
		expect(diff(without, holding(served), ownership)).toEqual([]);
		expect(diff(holding(served), without, ownership)).toEqual([]);
		const withColumn = structuredClone(served);
		withColumn.short = {
			...withColumn.short,
			columns: [{ doc_type: "DetailColumn", field: "village" }],
		};
		expect(diff(without, holding(withColumn), ownership)).toEqual([
			{ kind: "menu", menu: 0, name: "Patients" },
		]);
	});

	it("reads a key the manifest does not list as no change only while it is empty", () => {
		const added = (value: unknown) =>
			edited((app) => {
				const module = app.modules[0];
				if (module !== undefined) module.a_key_no_pin_declares = value;
			});
		expect(diff(base, added(null), ownership)).toEqual([]);
		expect(diff(base, added([]), ownership)).toEqual([]);
		expect(diff(base, added("set"), ownership)).toEqual([
			{ kind: "menu", menu: 0, name: "Patients" },
		]);
	});

	it("reads every key of a map property as content", () => {
		const added = edited((app) => {
			const module = app.modules[0];
			if (module !== undefined) module.name = { en: "Patients", fr: "" };
		});
		expect(diff(base, added, ownership)).toEqual([
			{ kind: "menu", menu: 0, name: "Patients" },
		]);
	});
});

describe("a shell", () => {
	const shell = retainedRead("publish/source-shell.json");
	const ownership: AppOwnership = {
		addOns: Object.keys(shell.add_ons as Record<string, unknown>),
		profileProperties: [],
		profileCustomProperties: [],
		autoGpsCapture: true,
	};

	it("compares only its menus, so a raised version, a new name and a new profile proceed", () => {
		const settled = structuredClone(shell);
		(settled.build_spec as Record<string, unknown>).version = "2.60.0";
		settled.name = "Renamed in HQ";
		settled.profile = { properties: { "cc-foreign": "yes" } };
		expect(diff(shell, settled, ownership, { shell: true })).toEqual([]);
		expect(diff(shell, settled, ownership)).not.toEqual([]);
	});

	it("stops on a menu given to it, as the list of menus", () => {
		const withMenu = structuredClone(shell);
		withMenu.modules = structuredClone(retainedRead(NAVIGATION_BASE).modules);
		expect(diff(shell, withMenu, ownership, { shell: true })).toEqual([
			{ kind: "menu-list" },
		]);
	});
});

/*
 * The lane's retained reads for the drift comparator, written by
 * `proof/hq/test_retained_reads.py` and `proof/editors/test_retained_reads.py`,
 * each compared under the ownership the publish HQ answered returned.
 */
describe("HQ's reads after its own saves", () => {
	const DOCUMENTS = [
		"navigation-base",
		"search-registration-link",
		"case-list-inline",
		"targeted-hq-side-state",
		"targeted-hq-side-lookup",
	] as const;

	it.each(DOCUMENTS)(
		"gives two reads of unchanged %s one text and one digest",
		(document) => {
			const first = retainedRead(`${document}/app-source.json`);
			const again = retainedRead(`${document}/app-source-again.json`);
			/* HQ mints fresh form ids and attachment keys on each read. */
			expect(first).not.toEqual(again);
			expect(normalized(again).text).toBe(normalized(first).text);
			expect(normalized(again).digest).toBe(normalized(first).digest);
			expect(
				diff(first, again, retainedOwnership(`${document}/ownership.json`)),
			).toEqual([]);
		},
	);

	it("gives the HQ-built pair, with all four reference paths and two report configs, one digest", () => {
		const first = retainedRead("hq-built/app-source.json");
		const again = retainedRead("hq-built/app-source-again.json");
		expect(normalized(again).text).toBe(normalized(first).text);
		expect(
			diff(first, again, retainedOwnership("navigation-base/ownership.json")),
		).toEqual([]);
	});

	it("reads the media upload as no change", () => {
		const ownership = retainedOwnership("case-list-inline/ownership.json");
		expect(
			diff(
				retainedRead("case-list-inline/app-source.json"),
				retainedRead("case-list-inline/app-source-after-media.json"),
				ownership,
			),
		).toEqual([]);
	});

	/* Decision 7's table, row by row: each page of HQ saved with nothing
	 * changed, over `navigation-base` (one menu holding `Visit`, then
	 * `Register`). The app needs no add-on, so its publish carries no
	 * `add_ons` and owns none, and the Add-ons save, which stores every slug
	 * as `false`, changes nothing it owns. Neither form holds a preload, and
	 * the Case Management page saves an empty `case_preload` with condition
	 * `always` over the `never` the publish holds, so a save of either form's
	 * page changes it. */
	const SAVES: readonly [string, readonly AppChangePart["kind"][]][] = [
		["app-settings", []],
		["ui-translations", []],
		["case-management-visit", ["form"]],
		["case-management-register", ["form"]],
		["add-ons", []],
		["menu-settings", ["menu"]],
		["case-list", ["menu"]],
		["case-detail", ["menu"]],
		["form-settings", ["form"]],
		["form-builder", ["form"]],
	];
	it.each(SAVES)(
		"reads a save of %s with nothing changed as %j",
		(page, kinds) => {
			const ownership = retainedOwnership("navigation-base/ownership.json");
			const before = retainedRead("navigation-base/app-source.json");
			const after = retainedRead(
				`navigation-base/app-source-after-${page}-save.json`,
			);
			expect(diff(before, after, ownership).map((part) => part.kind)).toEqual(
				kinds,
			);
			if (kinds.length === 0) {
				expect(normalized(after).digest).not.toBe(normalized(before).digest);
			}
		},
	);

	/* Each save a document's `hq-side.json` names, made over Nova's first
	 * publish in a fork of its own: a UI translation is the target's own key,
	 * which the next publish carries back; the location capture on an app that
	 * is not a Connect app, two add-ons the app does not need and a profile
	 * setting Nova does not own are HQ's, which the publish leaves as they are;
	 * and a build profile and a lookup table's upload touch nothing of the app
	 * Nova compares. */
	const HQ_SIDE_SAVES: readonly [
		string,
		string,
		readonly AppChangePart["kind"][],
	][] = [
		["targeted-hq-side-state", "uiTranslations", []],
		["targeted-hq-side-state", "appAttributes", []],
		["targeted-hq-side-state", "buildProfiles", []],
		["targeted-hq-side-state", "addOns", []],
		["targeted-hq-side-state", "profileProperties", []],
		["targeted-hq-side-lookup", "lookupTable", []],
	];
	it.each(HQ_SIDE_SAVES)(
		"reads %s after its %s save as %j",
		(document, save, kinds) => {
			const before = retainedRead(`${document}/app-source.json`);
			const after = retainedRead(`${document}/app-source-after-${save}.json`);
			expect(
				diff(
					before,
					after,
					retainedOwnership(`${document}/ownership.json`),
				).map((part) => part.kind),
			).toEqual(kinds);
		},
	);

	it("compares a shell with itself after an App Settings save, and against a menu", () => {
		const ownership = retainedOwnership("shell/ownership.json");
		const shell = retainedRead("shell/app-source.json");
		expect(
			diff(
				shell,
				retainedRead("shell/app-source-after-app-settings-save.json"),
				ownership,
				{ shell: true },
			),
		).toEqual([]);
		expect(
			diff(
				shell,
				retainedRead("shell/app-source-with-a-menu.json"),
				ownership,
				{
					shell: true,
				},
			),
		).toEqual([{ kind: "menu-list" }]);
	});
});
