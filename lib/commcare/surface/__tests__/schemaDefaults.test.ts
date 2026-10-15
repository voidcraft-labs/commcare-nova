/** The manifest's answer for one stored key of one HQ model. Pure, over the generated surface. */
import { expect, it } from "vitest";
import { schemaPropertyDefault } from "../schemaDefaults";

it("answers a declared property with its default", () => {
	expect(schemaPropertyDefault("Application", "auto_gps_capture")).toEqual({
		known: true,
		default: false,
		isMap: false,
	});
	expect(schemaPropertyDefault("Detail", "display")).toEqual({
		known: true,
		default: null,
		isMap: false,
	});
});

it("answers a map property as one whose every key is content", () => {
	expect(schemaPropertyDefault("Application", "add_ons")).toEqual({
		known: true,
		default: {},
		isMap: true,
	});
	expect(schemaPropertyDefault("Module", "name")).toMatchObject({
		known: true,
		isMap: true,
	});
});

it("answers a key the manifest does not list, and a model's undeclared-key rule, as unknown", () => {
	const unknown = { known: false, default: undefined, isMap: false };
	expect(schemaPropertyDefault("Module", "a_key_no_pin_declares")).toEqual(
		unknown,
	);
	expect(schemaPropertyDefault("AdvancedForm", "<undeclared>")).toEqual(
		unknown,
	);
	expect(schemaPropertyDefault("Module", "__proto__")).toEqual(unknown);
});
