import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { PreviewHeldCaseListMenu } from "@/lib/preview/menuProjection";
import {
	createNavigateActions,
	createSelectAction,
	type NavigationPort,
} from "../navigation";

function fixture() {
	const doc = buildDoc({
		appId: "app-1",
		modules: [
			{
				uuid: "module",
				name: "Visits",
				forms: [
					{
						uuid: "form",
						name: "Visit",
						type: "survey",
						fields: [f({ uuid: "field", kind: "text", id: "name" })],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	const fieldUuid = doc.fieldOrder[formUuid][0];
	let pathname = `/build/new/${fieldUuid}`;
	const writes: {
		url: string;
		replace: boolean;
		heldMenu?: PreviewHeldCaseListMenu;
	}[] = [];
	const reopened: { url: string; heldMenu: PreviewHeldCaseListMenu }[] = [];
	let back = 0;
	const port: NavigationPort = {
		getDoc: () => doc,
		getPathname: () => pathname,
		getSegments: () => pathname.split("/").filter(Boolean).slice(2),
		write: (url, replace = false, heldMenu) => {
			writes.push({ url, replace, ...(heldMenu && { heldMenu }) });
			pathname = url;
		},
		reopenHeldMenu: (url, heldMenu) => {
			reopened.push({ url, heldMenu });
		},
		back: () => {
			back += 1;
		},
	};
	return {
		doc,
		moduleUuid,
		formUuid,
		fieldUuid,
		port,
		writes,
		reopened,
		setPath: (value: string) => {
			pathname = value;
		},
		getBack: () => back,
	};
}

describe("navigation actions", () => {
	it("reads a newly materialized app prefix and the current selection at each action", () => {
		const h = fixture();
		const { up, openForm, back } = createNavigateActions(h.port);
		h.setPath(`/build/created/${h.fieldUuid}`);
		up();
		up();
		up();
		up();
		expect(h.writes).toEqual([
			{ url: `/build/created/${h.formUuid}`, replace: false },
			{ url: `/build/created/${h.moduleUuid}`, replace: false },
			{ url: "/build/created", replace: false },
		]);
		openForm(h.moduleUuid, h.formUuid, h.fieldUuid);
		expect(h.writes.at(-1)).toEqual({
			url: `/build/created/${h.fieldUuid}`,
			replace: false,
		});
		back();
		expect(h.getBack()).toBe(1);
	});

	it("writes workspace destinations, opaque case ids, and explicit replacements", () => {
		const h = fixture();
		const nav = createNavigateActions(h.port);
		nav.openSearchConfig(h.moduleUuid);
		nav.openCaseList(h.moduleUuid);
		nav.openDetailConfig(h.moduleUuid);
		nav.openCaseDetail(h.moduleUuid, "patient/a %:1");
		nav.replace({ kind: "home" });
		nav.push({ kind: "module", moduleUuid: h.moduleUuid }, { replace: true });
		expect(h.writes).toEqual([
			{ url: `/build/new/${h.moduleUuid}/search`, replace: false },
			{ url: `/build/new/${h.moduleUuid}/results`, replace: false },
			{ url: `/build/new/${h.moduleUuid}/details`, replace: false },
			{
				url: `/build/new/${h.moduleUuid}/cases/patient%2Fa%20%25%3A1`,
				replace: false,
			},
			{ url: "/build/new", replace: true },
			{ url: `/build/new/${h.moduleUuid}`, replace: true },
		]);
	});

	it("holds a case list's form menu on an entry at the list's URL, after the list or in place of a case's details", () => {
		const h = fixture();
		const nav = createNavigateActions(h.port);
		const held = {
			moduleUuid: h.moduleUuid,
			cases: [{ caseId: "ana" }],
			session: "worker",
		};
		nav.holdPreviewMenu(held);
		nav.holdPreviewMenu(held, { replace: true });
		nav.reopenPreviewHeldMenu(held);
		// Reopening reaches the same list's URL, through the port's own
		// history decision (`previewHeldMenu.ts::previewHeldMenuIsPrevious`).
		expect(h.reopened).toEqual([
			{ url: `/build/new/${h.moduleUuid}/results`, heldMenu: held },
		]);
		expect(h.writes).toEqual([
			{
				url: `/build/new/${h.moduleUuid}/results`,
				replace: false,
				heldMenu: held,
			},
			{
				url: `/build/new/${h.moduleUuid}/results`,
				replace: true,
				heldMenu: held,
			},
		]);
	});

	it("limits selected deep links to their setup section", () => {
		const h = fixture();
		const nav = createNavigateActions(h.port);
		const entry = testUuid("entry");
		nav.openAppSetup("deep-links", entry);
		nav.openAppSetup("users", entry);
		nav.openAppSetup();
		expect(h.writes).toEqual([
			{ url: `/build/new/setup/deep-links/${entry}`, replace: false },
			{ url: "/build/new/setup/users", replace: false },
			{ url: "/build/new/setup/users", replace: false },
		]);
	});

	it("blocks selection before clearing focus, then replaces selection and deselection", () => {
		const h = fixture();
		let allowed = false;
		const effects: string[] = [];
		const select = createSelectAction(
			h.port,
			() => {
				effects.push("guard");
				return allowed;
			},
			() => {
				effects.push("clear");
			},
		);
		select(undefined);
		expect(effects).toEqual(["guard"]);
		expect(h.writes).toEqual([]);
		allowed = true;
		select(undefined);
		select(h.fieldUuid);
		expect(effects).toEqual(["guard", "guard", "clear", "guard", "clear"]);
		expect(h.writes).toEqual([
			{ url: `/build/new/${h.formUuid}`, replace: true },
			{ url: `/build/new/${h.fieldUuid}`, replace: true },
		]);
		h.setPath(`/build/new/${h.moduleUuid}`);
		select(h.fieldUuid);
		expect(h.writes).toHaveLength(2);
	});

	it("uses the captured form context after deletion makes the selected URL unresolvable", () => {
		const h = fixture();
		const select = createSelectAction(
			h.port,
			() => true,
			() => {},
		);
		delete h.doc.fields[h.fieldUuid];
		h.doc.fieldOrder[h.formUuid] = [];
		select(undefined);
		expect(h.writes).toEqual([]);
		select(undefined, {
			kind: "form",
			moduleUuid: h.moduleUuid,
			formUuid: h.formUuid,
			selectedUuid: h.fieldUuid,
		});
		expect(h.writes).toEqual([
			{ url: `/build/new/${h.formUuid}`, replace: true },
		]);
	});
});
