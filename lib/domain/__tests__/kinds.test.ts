import type { IconifyIcon } from "@iconify/react/offline";
import { describe, expect, it } from "vitest";
import { fieldKinds, fieldRegistry } from "../fields";

describe("fieldRegistry", () => {
	it.each(
		fieldKinds,
	)("kind %s carries an IconifyIcon (object, not string)", (kind) => {
		const meta = fieldRegistry[kind];
		expect(meta).toBeDefined();
		// IconifyIcon is an object literal { body: string; width?: number; ... }.
		// Phase 1 stored icons as iconify ID strings; Phase 5 stores the imported
		// data so consumers don't need a parallel fieldKindIcons map.
		expect(typeof meta.icon).toBe("object");
		expect(meta.icon).not.toBeNull();
		expect(typeof (meta.icon as IconifyIcon).body).toBe("string");
	});

	it.each(
		fieldKinds,
	)("kind %s carries a non-empty human-readable label", (kind) => {
		const meta = fieldRegistry[kind];
		expect(typeof meta.label).toBe("string");
		expect(meta.label.length).toBeGreaterThan(0);
	});
});
