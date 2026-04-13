/**
 * Tests for the pure validation helper extracted from the build page's
 * RSC handler (`app/build/[id]/page.tsx`).
 *
 * The handler previously had inline parse/recover logic — this pulled
 * the decision out into `validateAndRecover`, a pure function that
 * returns either `{ kind: "ok" }` or `{ kind: "redirect"; location }`
 * so the handler just decides whether to call `redirect()`.
 *
 * By testing the helper directly, we cover every branch of the
 * validation logic without spinning up a Next.js RSC harness (which
 * would require async-params polyfills, session mocks, and Firestore
 * stubs for what is essentially a two-line decision).
 */

import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/doc/types";
import type { LocationDoc } from "@/lib/routing/location";
import { validateAndRecover } from "@/lib/routing/validateSearchParams";

const MOD = asUuid("mod-1");
const FORM = asUuid("form-1");
const Q = asUuid("q-1");

/*
 * Hand-built LocationDoc — keys matter, entity shapes don't.
 * `as never` skips the entity type requirements that the Pick
 * inherits from `BlueprintDoc`.
 */
const doc: LocationDoc = {
	modules: { [MOD]: { uuid: MOD, name: "M" } as never },
	forms: { [FORM]: { uuid: FORM, name: "F" } as never },
	questions: { [Q]: { uuid: Q, id: "one" } as never },
};

const emptyDoc: LocationDoc = {
	modules: {},
	forms: {},
	questions: {},
};

describe("validateAndRecover", () => {
	it("home URL against empty doc → ok", () => {
		const result = validateAndRecover(new URLSearchParams(), emptyDoc);
		expect(result).toEqual({ kind: "ok" });
	});

	it("valid form URL → ok", () => {
		const sp = new URLSearchParams(`s=f&m=${MOD}&f=${FORM}`);
		expect(validateAndRecover(sp, doc)).toEqual({ kind: "ok" });
	});

	it("valid form URL with valid selection → ok", () => {
		const sp = new URLSearchParams(`s=f&m=${MOD}&f=${FORM}&sel=${Q}`);
		expect(validateAndRecover(sp, doc)).toEqual({ kind: "ok" });
	});

	it("form URL with stale selected → redirect to form without selection", () => {
		const sp = new URLSearchParams(`s=f&m=${MOD}&f=${FORM}&sel=missing-q`);
		expect(validateAndRecover(sp, doc)).toEqual({
			kind: "redirect",
			location: { kind: "form", moduleUuid: MOD, formUuid: FORM },
		});
	});

	it("form URL with stale form → redirect to module", () => {
		const sp = new URLSearchParams(`s=f&m=${MOD}&f=missing-form`);
		expect(validateAndRecover(sp, doc)).toEqual({
			kind: "redirect",
			location: { kind: "module", moduleUuid: MOD },
		});
	});

	it("form URL with stale module → redirect to home", () => {
		const sp = new URLSearchParams(`s=f&m=missing-mod&f=${FORM}`);
		expect(validateAndRecover(sp, doc)).toEqual({
			kind: "redirect",
			location: { kind: "home" },
		});
	});

	it("malformed URL that parses to home → ok (no redirect)", () => {
		/* `s=bogus` → parseLocation degrades to `{ kind: "home" }`, which
		 * is always valid against any doc. The RSC handler should render
		 * the app home without redirecting — redirecting would loop
		 * because the target URL would serialize away the bogus param and
		 * differ from the incoming URL only by that stripped key. */
		const sp = new URLSearchParams("s=bogus&m=whatever");
		expect(validateAndRecover(sp, emptyDoc)).toEqual({ kind: "ok" });
	});

	it("form URL missing required `f=` → ok (parses to home, always valid)", () => {
		/* Missing `f=` degrades to home during parse, same as above.
		 * This explicitly documents that the "degrade to home" rule in
		 * parseLocation lives at the parse layer, so validateAndRecover
		 * never sees the malformed form shape. */
		const sp = new URLSearchParams(`s=f&m=${MOD}`);
		expect(validateAndRecover(sp, doc)).toEqual({ kind: "ok" });
	});

	it("module URL with valid module → ok", () => {
		const sp = new URLSearchParams(`s=m&m=${MOD}`);
		expect(validateAndRecover(sp, doc)).toEqual({ kind: "ok" });
	});

	it("cases URL with valid module → ok", () => {
		const sp = new URLSearchParams(`s=cases&m=${MOD}&case=abc123`);
		expect(validateAndRecover(sp, doc)).toEqual({ kind: "ok" });
	});

	it("cases URL with stale module → redirect to home", () => {
		const sp = new URLSearchParams("s=cases&m=missing-mod&case=abc");
		expect(validateAndRecover(sp, doc)).toEqual({
			kind: "redirect",
			location: { kind: "home" },
		});
	});
});
