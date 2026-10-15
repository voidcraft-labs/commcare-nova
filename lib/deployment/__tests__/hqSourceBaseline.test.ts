/**
 * The app comparison over CommCare HQ's own answers. Every input is a read
 * HQ gave (`proof/hq-reads/`), whole or with the one edit a case names, so
 * the normalization and the comparison are held to what HQ actually serves
 * and never to a hand-written app source.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type SchemaDefaultReader,
	schemaPropertyDefault,
} from "@/lib/commcare/surface/schemaDefaults";
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
	options: { shell?: boolean; schemaDefault?: SchemaDefaultReader } = {},
): readonly AppChangePart[] {
	return diffHqAppSource({
		baseline: normalized(baseline).normalized,
		current: normalized(current).normalized,
		ownership,
		shell: options.shell ?? false,
		schemaDefault: options.schemaDefault ?? schemaPropertyDefault,
	});
}

/** What the cutover's legacy body wrote inside the overlay keys, read off the read. */
function legacyOwnership(source: Source): AppOwnership {
	return {
		addOns: Object.keys(source.add_ons as Record<string, unknown>),
		profileProperties: [],
		profileCustomProperties: [],
		autoGpsCapture: true,
	};
}

/** `navigation-base` as HQ served it after the cutover's create, one menu holding `Visit` and `Register`. */
const NAVIGATION_BASE = "cutover/navigation-base/after-create/app-source.json";

function edited(edit: (source: Source) => void): Source {
	const source = retainedRead(NAVIGATION_BASE);
	edit(source);
	return source;
}

describe("normalizing a read", () => {
	/* Every document the cutover's lane read twice with nothing between:
	 * HQ mints fresh form ids and attachment keys on each read. */
	const pairs = readdirSync(path.join(READS, "cutover"), {
		withFileTypes: true,
	})
		.filter((entry) => entry.isDirectory() && entry.name !== "answers")
		.map((entry) => entry.name);

	it.each(pairs)(
		"gives two reads of unchanged %s one text and one digest",
		(document) => {
			const first = retainedRead(
				`cutover/${document}/after-create/app-source.json`,
			);
			const again = retainedRead(
				`cutover/${document}/after-create/app-source-again.json`,
			);
			expect(first).not.toEqual(again);
			expect(normalized(again).text).toBe(normalized(first).text);
			expect(normalized(again).digest).toBe(normalized(first).digest);
			expect(diff(first, again, legacyOwnership(first))).toEqual([]);
		},
	);

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
	const ownership = legacyOwnership(base);

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
			app.translations = { en: { "homescreen.title": "Changed" } };
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

	it("reads add-ons and profile keys only under the baseline's ownership", () => {
		const changed = edited((app) => {
			(app.add_ons as Record<string, boolean>).not_nova_s = false;
			app.profile = { properties: { "cc-foreign": "yes" } };
			app.cloudcare_enabled = !app.cloudcare_enabled;
			app.last_modified = "2030-01-01T00:00:00.000000Z";
		});
		expect(diff(base, changed, ownership)).toEqual([]);
		const owned = edited((app) => {
			app.profile = { properties: { "cc-foreign": "yes" } };
		});
		expect(
			diff(base, owned, { ...ownership, profileProperties: ["cc-foreign"] }),
		).toEqual([{ kind: "settings" }]);
		const addOn = edited((app) => {
			(app.add_ons as Record<string, boolean>).advanced_itemsets = false;
		});
		expect(diff(base, addOn, ownership)).toEqual([{ kind: "settings" }]);
	});
});

describe("the schema-growth rule", () => {
	const base = retainedRead(NAVIGATION_BASE);
	const ownership = legacyOwnership(base);
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
 * `proof/hq/test_retained_reads.py` and `proof/editors/test_retained_reads.py`
 * (part 02, The retained HQ reads), each compared under the ownership the
 * publish HQ answered returned.
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
	 * `Register`). */
	const SAVES: readonly [string, readonly AppChangePart["kind"][]][] = [
		["app-settings", []],
		["ui-translations", []],
		["case-management-visit", []],
		["case-management-register", ["form"]],
		["add-ons", ["settings"]],
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
	 * publish in a fork of its own: a UI translation is text Nova writes, the
	 * location capture a setting it writes, and a build profile and a lookup
	 * table's upload touch nothing of the app Nova compares. */
	const HQ_SIDE_SAVES: readonly [
		string,
		string,
		readonly AppChangePart["kind"][],
	][] = [
		["targeted-hq-side-state", "uiTranslations", ["text"]],
		["targeted-hq-side-state", "appAttributes", ["settings"]],
		["targeted-hq-side-state", "buildProfiles", []],
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
