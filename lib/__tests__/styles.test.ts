import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	FLOATING_LAYER_CLS,
	MENU_POSITIONER_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
	POPOVER_POSITIONER_ELEVATED_CLS,
	POPOVER_POSITIONER_GLASS_CLS,
} from "@/lib/styles";

const SURFACES = {
	MENU_POSITIONER_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
	POPOVER_POSITIONER_GLASS_CLS,
	POPOVER_POSITIONER_ELEVATED_CLS,
};

/** Any `z-*` utility, excluding the `z-index` custom-property name itself. */
const Z_UTILITY = /(?:^|\s)(z-[a-z0-9-]+)/g;

describe("floating chrome — surface and plane are separate axes", () => {
	it.each(Object.entries(SURFACES))(
		"%s describes a surface and declares no stacking tier",
		(_name, surface) => {
			// A tier folded back in here would force every call site that wants a
			// different plane to append a second `z-*` and leave tailwind-merge to
			// arbitrate the pair — the shape that shipped a Select popup at
			// `z-popover-top` behind the dialog that opened it.
			expect([...surface.matchAll(Z_UTILITY)].map((m) => m[1])).toEqual([]);
		},
	);

	it("states the shared plane as exactly one token", () => {
		expect(FLOATING_LAYER_CLS.trim().split(/\s+/)).toEqual(["z-modal"]);
	});
});

/* ── The forget-guard ──────────────────────────────────────────────────────
 * Base UI positioners portal to `document.body`, so they stack in the ROOT
 * context against dialogs. One that declares no plane does not fall back to
 * anything sensible: it paints by DOM order and loses to every positioned
 * ancestor-free element above it, which reads as "the menu opened but nothing
 * appeared". Seven glass popovers were one edit away from exactly that.
 *
 * Reading source is the only way to catch it — the failure is a MISSING class,
 * so there is no runtime value to assert and no component to mount. */

function tsxFilesUnder(...roots: string[]): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".tsx")) found.push(full);
		}
	};
	for (const root of roots) walk(path.join(process.cwd(), root));
	return found;
}

/** The JSX opening tag starting at `line`, up to its closing angle bracket. */
function openingTagAt(lines: string[], line: number): string | null {
	if (/\/?>\s*$/.test(lines[line] ?? "")) return lines[line] ?? null;
	const parts: string[] = [lines[line] ?? ""];
	for (let i = line + 1; i < lines.length; i++) {
		parts.push(lines[i]);
		if (/^\/?>$/.test(lines[i].trim())) return parts.join("\n");
		if (/^<\//.test(lines[i].trim())) return null;
	}
	return null;
}

describe("every Base UI positioner declares a stacking plane", () => {
	const sites = tsxFilesUnder("components", "app").flatMap((file) => {
		const lines = readFileSync(file, "utf8").split("\n");
		return lines.flatMap((line, index) =>
			/<\w+\.Positioner\b/.test(line)
				? [{ file: path.relative(process.cwd(), file), index, lines }]
				: [],
		);
	});

	it("finds the positioners to check", () => {
		// A silent zero here would turn every assertion below into a no-op.
		expect(sites.length).toBeGreaterThan(15);
	});

	it.each(sites.map((s) => [`${s.file}:${s.index + 1}`, s] as const))(
		"%s",
		(where, site) => {
			const tag = openingTagAt(site.lines, site.index);
			// A tag this helper cannot delimit is a fail, not a skip — otherwise a
			// reformat quietly drops a positioner out of the sweep.
			expect(tag, `could not read the opening tag at ${where}`).not.toBeNull();
			const declaresPlane =
				(tag ?? "").includes("FLOATING_LAYER_CLS") ||
				/\bz-[a-z][a-z-]*\b/.test(tag ?? "");
			expect(
				declaresPlane,
				`${where} portals to document.body but declares no stacking plane. ` +
					"Compose FLOATING_LAYER_CLS (lib/styles.ts) — or an explicit z-* " +
					"token if this surface genuinely belongs on another plane, the way " +
					"a tooltip sits above modals.",
			).toBe(true);
		},
	);
});
