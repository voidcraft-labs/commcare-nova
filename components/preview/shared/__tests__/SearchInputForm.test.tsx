// @vitest-environment happy-dom
//
// components/preview/shared/__tests__/SearchInputForm.test.tsx
//
// Pins the running-app search-input form contract. Three orthogonal
// axes get coverage:
//
//   1. Per-input widget dispatch — one widget per `SearchInputDef.type`
//      (text / select / date / date-range / barcode), independent of
//      the arm discriminator (`kind: "simple"` vs `kind: "advanced"`).
//   2. Debounced upward emission — keystroke bursts collapse to one
//      `onChange` after 300 ms. Re-emission of the same map is
//      suppressed so the form doesn't loop after the parent echoes
//      `value` back in.
//   3. Date-range two-key shape — bounds emit under `<name>:from` /
//      `<name>:to` and clear independently while editing; submission
//      requires the complete ordered pair CommCare can represent.
//
// The date / date-range widgets are Popover+Calendar pickers, NOT
// native date inputs. Tests assert against the trigger button's text
// (controlled-prop side) and drive value changes through a mocked
// Calendar that exposes deterministic "pick"/"clear" buttons —
// happy-dom + fake timers + react-day-picker's nested grid is too
// fragile to drive end-to-end, and the value-flow contract doesn't
// depend on the calendar's internals.
//
// Fake timers + `fireEvent.change` for typing bursts — `userEvent.type`
// uses real `setTimeout` internally and hangs under fake timers
// unless wired through `advanceTimers`. Sticking to `fireEvent.change`
// keeps the timing model deterministic.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	advancedSearchInputDef,
	asUuid,
	simpleSearchInputDef,
} from "@/lib/domain";
import { matchAll } from "@/lib/domain/predicate";
import {
	DATE_RANGE_ORDER_MESSAGE,
	DATE_RANGE_PAIR_REQUIRED_MESSAGE,
} from "@/lib/preview/engine/dateRangeInputValidation";
import type { SearchInputValues } from "@/lib/preview/engine/runtimeBindings";

// Mock the shadcn Calendar with a deterministic stub. The real
// component is react-day-picker v10 — fast, accessible, but the
// nested grid makes per-day-button targeting brittle under
// happy-dom + fake timers. The stub exposes two buttons per
// instance: "Pick 2024-01-01" (or whatever `data-test-pick-date`
// resolves to) and "Pick 2024-12-31"; tests that need to drive a
// specific date click the matching button. The stub honors
// `mode="single"` only — the form never renders `mode="range"`.
vi.mock("@/components/shadcn/calendar", () => ({
	Calendar: ({
		selected,
		onSelect,
	}: {
		selected: Date | undefined;
		onSelect: (next: Date | undefined) => void;
	}) => (
		<div data-testid="mock-calendar">
			<span data-testid="mock-calendar-selected">
				{selected === undefined ? "<unset>" : selected.toISOString()}
			</span>
			<button
				type="button"
				onClick={() => onSelect(new Date(2024, 0, 1))}
				data-testid="mock-calendar-pick-jan-1"
			>
				Pick 2024-01-01
			</button>
			<button
				type="button"
				onClick={() => onSelect(new Date(2024, 11, 31))}
				data-testid="mock-calendar-pick-dec-31"
			>
				Pick 2024-12-31
			</button>
		</div>
	),
}));

import { SearchInputForm } from "../SearchInputForm";

const ORIGINAL_MEDIA_DEVICES = Object.getOwnPropertyDescriptor(
	navigator,
	"mediaDevices",
);
const ORIGINAL_SRC_OBJECT = Object.getOwnPropertyDescriptor(
	HTMLMediaElement.prototype,
	"srcObject",
);

// ── Fixtures ────────────────────────────────────────────────────────

const UUID_NAME = asUuid("00000000-0000-0000-0000-000000000001");
const UUID_STATUS = asUuid("00000000-0000-0000-0000-000000000002");
const UUID_DOB = asUuid("00000000-0000-0000-0000-000000000003");
const UUID_REG_RANGE = asUuid("00000000-0000-0000-0000-000000000004");
const UUID_BARCODE = asUuid("00000000-0000-0000-0000-000000000005");
const UUID_ADV_SELECT = asUuid("00000000-0000-0000-0000-000000000006");

const READABLE_DATE_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
	day: "numeric",
	month: "long",
	year: "numeric",
};

function readableDate(year: number, monthIndex: number, day: number): string {
	return new Date(year, monthIndex, day).toLocaleDateString(
		"en-US",
		READABLE_DATE_FORMAT_OPTIONS,
	);
}

/** Case type with one of each property data type that the widgets
 *  dispatch against. `status` carries declared options so the select
 *  widget has a list to render. */
const PATIENT_CASE_TYPE: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "case_name", label: "Case name", data_type: "text" },
		{
			name: "status",
			label: "Status",
			data_type: "single_select",
			options: [
				{ value: "active", label: "Active" },
				{ value: "closed", label: "Closed" },
			],
		},
		{ name: "dob", label: "Date of birth", data_type: "date" },
		{ name: "reg_at", label: "Registered at", data_type: "date" },
		{ name: "barcode", label: "Barcode", data_type: "text" },
	],
};

// ── Test harness ────────────────────────────────────────────────────

/** Sentinel used by `renderForm` to distinguish "key absent" (use
 *  the fixture case type) from "key present and undefined"
 *  (intentional unresolved case-type test). `key in opts` style
 *  detection would survive type-narrowing through `?:` but reads
 *  awkwardly; a unique-symbol sentinel makes the intent explicit at
 *  the call site (`caseType: NO_CASE_TYPE`). */
const NO_CASE_TYPE = Symbol("no-case-type");
type CaseTypeOpt = CaseType | typeof NO_CASE_TYPE;

/** Renders the form against the fixture case type with a fresh
 *  `vi.fn()` for `onChange`. Returns the mock + a re-render helper
 *  so tests can drive parent-side `value` updates and assert the
 *  controlled-prop contract. */
function renderForm(opts: {
	readonly searchInputs: Parameters<typeof SearchInputForm>[0]["searchInputs"];
	readonly value?: SearchInputValues;
	readonly caseType?: CaseTypeOpt;
}) {
	const onChange = vi.fn<(next: SearchInputValues) => void>();
	const initialValue: SearchInputValues = opts.value ?? new Map();
	// `caseType: NO_CASE_TYPE` → pass undefined to the form (tests the
	// fallback-to-text path); absent → use the fixture case type.
	const resolvedCaseType: CaseType | undefined =
		opts.caseType === undefined
			? PATIENT_CASE_TYPE
			: opts.caseType === NO_CASE_TYPE
				? undefined
				: opts.caseType;
	const utils = render(
		<SearchInputForm
			searchInputs={opts.searchInputs}
			caseType={resolvedCaseType}
			value={initialValue}
			onChange={onChange}
		/>,
	);
	const rerender = (nextValue: SearchInputValues) => {
		utils.rerender(
			<SearchInputForm
				searchInputs={opts.searchInputs}
				caseType={resolvedCaseType}
				value={nextValue}
				onChange={onChange}
			/>,
		);
	};
	return { ...utils, onChange, rerender };
}

/** Pulls the most recent emission off the `onChange` mock as a plain
 *  object so tests can assert against a single snapshot in one
 *  expression. Returns `undefined` when nothing has been emitted yet.
 *  The form emits `SearchInputValues` (a `ReadonlyMap`); the helper
 *  flattens to a record for readable assertions. */
function lastEmission(
	mock: Mock<(next: SearchInputValues) => void>,
): Record<string, string> | undefined {
	const calls = mock.mock.calls;
	if (calls.length === 0) return undefined;
	const last = calls[calls.length - 1];
	if (last === undefined) return undefined;
	const emitted = last[0];
	return Object.fromEntries(emitted);
}

async function flushReactMicrotasks(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	if (ORIGINAL_MEDIA_DEVICES === undefined) {
		Reflect.deleteProperty(navigator, "mediaDevices");
	} else {
		Object.defineProperty(navigator, "mediaDevices", ORIGINAL_MEDIA_DEVICES);
	}
	if (ORIGINAL_SRC_OBJECT === undefined) {
		Reflect.deleteProperty(HTMLMediaElement.prototype, "srcObject");
	} else {
		Object.defineProperty(
			HTMLMediaElement.prototype,
			"srcObject",
			ORIGINAL_SRC_OBJECT,
		);
	}
});

interface BarcodeTestEnvironment {
	readonly detect: Mock<() => Promise<ReadonlyArray<{ rawValue: string }>>>;
	readonly getUserMedia: Mock<() => Promise<MediaStream>>;
	readonly stream: MediaStream;
	readonly stop: Mock<() => void>;
	readonly runNextFrame: () => Promise<void>;
}

/** Installs only the browser APIs the production scanner feature-detects.
 * RAF advances through fake time only when `runNextFrame` asks for a scan,
 * so an empty result cannot create an unbounded test loop. */
function installBarcodeScanner(
	detections: ReadonlyArray<{ rawValue: string }> = [],
	formats: ReadonlyArray<string> = ["code_128", "qr_code"],
): BarcodeTestEnvironment {
	const detect = vi
		.fn<() => Promise<ReadonlyArray<{ rawValue: string }>>>()
		.mockResolvedValue(detections);
	class MockBarcodeDetector {
		static getSupportedFormats = vi
			.fn<() => Promise<ReadonlyArray<string>>>()
			.mockResolvedValue(formats);

		readonly detect = detect;
	}
	vi.stubGlobal("BarcodeDetector", MockBarcodeDetector);
	vi.stubGlobal("isSecureContext", true);

	const stop = vi.fn();
	const stream = {
		getTracks: () => [{ stop }],
	} as unknown as MediaStream;
	const getUserMedia = vi
		.fn<() => Promise<MediaStream>>()
		.mockResolvedValue(stream);
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia },
	});
	Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
		configurable: true,
		writable: true,
		value: null,
	});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();

	return {
		detect,
		getUserMedia,
		stream,
		stop,
		runNextFrame: async () => {
			await act(async () => {
				vi.advanceTimersByTime(20);
				await Promise.resolve();
				await Promise.resolve();
			});
		},
	};
}

// ── Per-type widget dispatch ───────────────────────────────────────

describe("widget dispatch", () => {
	it("renders a text input for `type: text` inputs", () => {
		renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_NAME, "name", "Name", "text", "name"),
			],
		});
		const input = screen.getByLabelText("Name");
		// Underlying Base UI Input renders a native <input> with the
		// passed `type`; the shadcn wrapper preserves it.
		expect((input as HTMLInputElement).tagName).toBe("INPUT");
		expect((input as HTMLInputElement).type).toBe("text");
	});

	it("renders a Popover trigger button for `type: date` inputs (not a native date input)", () => {
		renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_DOB, "dob", "Date of birth", "date", "dob"),
			],
		});
		// shadcn DatePicker = Popover trigger Button; `getByLabelText`
		// associates the label with the trigger via `htmlFor`. The
		// fallback "Pick a date" trigger text confirms an empty state.
		const trigger = screen.getByLabelText("Date of birth");
		expect(trigger.tagName).toBe("BUTTON");
		expect(trigger.textContent ?? "").toContain("Pick a date");
	});

	it("keeps manual barcode entry and explains when scanning is unsupported", async () => {
		// Barcode-scanned values are plain strings on the wire; the
		// running-app surface matches that shape with a text input
		// that accepts pasted scanner output.
		renderForm({
			searchInputs: [
				simpleSearchInputDef(
					UUID_BARCODE,
					"barcode",
					"Barcode",
					"barcode",
					"barcode",
				),
			],
		});
		const input = screen.getByLabelText("Barcode");
		expect((input as HTMLInputElement).tagName).toBe("INPUT");
		expect((input as HTMLInputElement).type).toBe("text");
		await flushReactMicrotasks();
		expect(screen.queryByRole("button", { name: "Scan Barcode" })).toBeNull();
		const fallback = screen.getByText(
			"Your browser doesn't support camera scanning. Enter or paste the barcode",
		);
		expect(fallback).toBeDefined();
		expect(input.getAttribute("aria-describedby")).toBe(fallback.id);
	});

	it("renders two Popover trigger buttons for `type: date-range` inputs", () => {
		renderForm({
			searchInputs: [
				simpleSearchInputDef(
					UUID_REG_RANGE,
					"reg",
					"Registered",
					"date-range",
					"reg_at",
				),
			],
		});
		// Each bound is its own labeled trigger — "Registered from"
		// / "Registered to". Surfacing the bound role to assistive
		// tech is more useful than a single ambiguous "Registered"
		// addressing both controls.
		const from = screen.getByLabelText("Registered from");
		const to = screen.getByLabelText("Registered to");
		expect(from.tagName).toBe("BUTTON");
		expect(to.tagName).toBe("BUTTON");
		expect(from).not.toBe(to);
	});
});

describe("barcode scanning", () => {
	it("does not show Scan when the browser reports no usable barcode formats", async () => {
		installBarcodeScanner([], []);
		renderForm({
			searchInputs: [
				simpleSearchInputDef(
					UUID_BARCODE,
					"barcode",
					"Barcode",
					"barcode",
					"barcode",
				),
			],
		});
		await flushReactMicrotasks();

		expect(screen.queryByRole("button", { name: "Scan Barcode" })).toBeNull();
		expect(screen.getByText(/doesn't support camera scanning/i)).toBeDefined();
	});

	it("shows Scan only when BarcodeDetector and camera capture are supported", async () => {
		installBarcodeScanner();
		renderForm({
			searchInputs: [
				simpleSearchInputDef(
					UUID_BARCODE,
					"barcode",
					"Barcode",
					"barcode",
					"barcode",
				),
			],
		});
		await flushReactMicrotasks();

		expect(screen.getByRole("button", { name: "Scan Barcode" })).toBeDefined();
		const manualInput = screen.getByLabelText("Barcode") as HTMLInputElement;
		fireEvent.change(manualInput, { target: { value: "PASTED-17" } });
		expect(manualInput.value).toBe("PASTED-17");
		expect(screen.queryByText(/doesn't support camera scanning/i)).toBeNull();
	});

	it("writes the first detected barcode into the editable text field", async () => {
		const scanner = installBarcodeScanner([{ rawValue: "BC-0042" }]);
		renderForm({
			searchInputs: [
				simpleSearchInputDef(
					UUID_BARCODE,
					"barcode",
					"Barcode",
					"barcode",
					"barcode",
				),
			],
		});
		await flushReactMicrotasks();

		fireEvent.click(screen.getByRole("button", { name: "Scan Barcode" }));
		await flushReactMicrotasks();
		expect(scanner.getUserMedia).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("dialog").textContent ?? "").toContain(
			"Point your camera at the barcode",
		);
		await scanner.runNextFrame();

		expect(scanner.detect).toHaveBeenCalledTimes(1);
		expect((screen.getByLabelText("Barcode") as HTMLInputElement).value).toBe(
			"BC-0042",
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(scanner.stop).toHaveBeenCalledTimes(1);
	});

	it("stops every camera track when the user cancels", async () => {
		const scanner = installBarcodeScanner();
		renderForm({
			searchInputs: [
				simpleSearchInputDef(
					UUID_BARCODE,
					"barcode",
					"Barcode",
					"barcode",
					"barcode",
				),
			],
		});
		await flushReactMicrotasks();

		fireEvent.click(screen.getByRole("button", { name: "Scan Barcode" }));
		await flushReactMicrotasks();
		expect(screen.getByRole("dialog").textContent ?? "").toContain(
			"Point your camera at the barcode",
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(scanner.stop).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("stops a camera that resolves after the dialog has already closed", async () => {
		const scanner = installBarcodeScanner();
		let releaseCamera: ((stream: MediaStream) => void) | undefined;
		scanner.getUserMedia.mockReturnValue(
			new Promise((resolve) => {
				releaseCamera = resolve;
			}),
		);
		renderForm({
			searchInputs: [
				simpleSearchInputDef(
					UUID_BARCODE,
					"barcode",
					"Barcode",
					"barcode",
					"barcode",
				),
			],
		});
		await flushReactMicrotasks();

		fireEvent.click(screen.getByRole("button", { name: "Scan Barcode" }));
		await flushReactMicrotasks();
		expect(screen.getByText("Starting your camera…")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(scanner.stop).not.toHaveBeenCalled();
		const resolveCamera = releaseCamera;
		if (resolveCamera === undefined)
			throw new Error("Camera was not requested");
		await act(async () => {
			resolveCamera(scanner.stream);
			await Promise.resolve();
		});

		expect(scanner.stop).toHaveBeenCalledTimes(1);
	});

	it("explains a denied camera permission and keeps manual entry available", async () => {
		const scanner = installBarcodeScanner();
		scanner.getUserMedia.mockRejectedValue(
			new DOMException("Permission denied", "NotAllowedError"),
		);
		renderForm({
			searchInputs: [
				simpleSearchInputDef(
					UUID_BARCODE,
					"barcode",
					"Barcode",
					"barcode",
					"barcode",
				),
			],
		});
		await flushReactMicrotasks();

		fireEvent.click(screen.getByRole("button", { name: "Scan Barcode" }));
		await flushReactMicrotasks();
		expect(
			screen.getByText("Your browser blocked camera access"),
		).toBeDefined();
		expect(
			screen.getByText(
				"Allow camera access in your browser, then try scanning again or enter the barcode",
			),
		).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.getByLabelText("Barcode")).toBeDefined();
	});
});

// ── Select-arm coverage ────────────────────────────────────────────

describe("select dispatch", () => {
	it("renders Select options from the resolved property's declared options", () => {
		renderForm({
			searchInputs: [
				simpleSearchInputDef(
					UUID_STATUS,
					"status",
					"Status",
					"select",
					"status",
				),
			],
		});
		// shadcn Select trigger is a Base UI button with combobox
		// semantics. Click it to open the popup; options mount under
		// role="option" once visible.
		const trigger = screen.getByRole("combobox", { name: "Status" });
		fireEvent.click(trigger);
		const options = screen.getAllByRole("option");
		const optionLabels = options.map((opt) => opt.textContent?.trim());
		expect(optionLabels).toContain("Active");
		expect(optionLabels).toContain("Closed");
	});

	it("clears only this select through Any and preserves sibling answers", async () => {
		const { onChange } = renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_NAME, "name", "Name", "text", "name"),
				simpleSearchInputDef(
					UUID_STATUS,
					"status",
					"Status",
					"select",
					"status",
				),
			],
			value: new Map([
				["name", "Alice"],
				["status", "active"],
			]),
		});

		fireEvent.click(screen.getByRole("combobox", { name: "Status" }));
		const anyOption = screen.getByRole("option", { name: "Any" });
		// Base UI starts an option press on pointer-down; click alone does not
		// exercise the value-change path in happy-dom.
		fireEvent.pointerDown(anyOption, { pointerType: "mouse" });
		fireEvent.click(anyOption);
		await act(async () => vi.advanceTimersByTime(300));

		expect(lastEmission(onChange)).toEqual({ name: "Alice" });
		expect(
			screen.getByRole("combobox", { name: "Status" }).textContent,
		).toContain("Any");
		expect(screen.queryByText("Choose an option")).toBeNull();
	});

	it("disambiguates the Any default from an authored option with the same label", () => {
		const caseType: CaseType = {
			...PATIENT_CASE_TYPE,
			properties: PATIENT_CASE_TYPE.properties.map((property) =>
				property.name === "status"
					? {
							...property,
							options: [
								{ value: "any", label: "Any" },
								{ value: "closed", label: "Closed" },
							],
						}
					: property,
			),
		};
		renderForm({
			searchInputs: [
				simpleSearchInputDef(
					UUID_STATUS,
					"status",
					"Status",
					"select",
					"status",
				),
			],
			caseType,
		});

		const trigger = screen.getByRole("combobox", { name: "Status" });
		expect(trigger.textContent).toContain("Any status");
		fireEvent.click(trigger);
		expect(screen.getByRole("option", { name: "Any status" })).toBeDefined();
		expect(screen.getByRole("option", { name: "Any" })).toBeDefined();
	});

	it("keeps long spaced and unbroken option labels legible in a narrow pane", () => {
		const longSpacedLabel =
			"Needs an in-person follow-up with the community health team this month";
		const longUnbrokenLabel =
			"ExtremelyLongImportedChoiceWithoutAnyNaturalWordBreaksForTheNarrowSearchPane";
		const caseType: CaseType = {
			...PATIENT_CASE_TYPE,
			properties: PATIENT_CASE_TYPE.properties.map((property) =>
				property.name === "status"
					? {
							...property,
							options: [
								{ value: "follow_up", label: longSpacedLabel },
								{ value: "imported", label: longUnbrokenLabel },
							],
						}
					: property,
			),
		};
		const { rerender } = renderForm({
			searchInputs: [
				simpleSearchInputDef(
					UUID_STATUS,
					"status",
					"Status",
					"select",
					"status",
				),
			],
			caseType,
			value: new Map([["status", "follow_up"]]),
		});

		const trigger = screen.getByRole("combobox", { name: "Status" });
		expect(trigger.textContent).toContain(longSpacedLabel);
		expect(trigger.className).toContain("whitespace-normal");
		expect(trigger.className).toContain("line-clamp-none");
		expect(trigger.className).toContain("[overflow-wrap:anywhere]");
		expect(trigger.className).not.toContain("line-clamp-1");
		expect(trigger.className).not.toContain("data-[size=default]:h-8");
		rerender(new Map([["status", "imported"]]));
		expect(trigger.textContent).toContain(longUnbrokenLabel);
		fireEvent.click(trigger);

		const content = document.querySelector<HTMLElement>(
			'[data-slot="select-content"]',
		);
		expect(content?.className).toContain("max-w-(--available-width)");
		expect(content?.className).toContain(
			"min-w-[min(9rem,var(--available-width))]",
		);
		for (const label of [longSpacedLabel, longUnbrokenLabel]) {
			const option = screen.getByRole("option", { name: label });
			const itemText = option.querySelector<HTMLElement>(
				'[data-slot="select-item-text"]',
			);
			expect(itemText?.className).toContain("min-w-0");
			expect(itemText?.className).toContain("whitespace-normal");
			expect(itemText?.className).toContain("break-words");
			expect(itemText?.className).toContain("[overflow-wrap:anywhere]");
		}
	});

	it("falls back to a text input on advanced-arm `type: select` inputs", () => {
		// Advanced-arm inputs reference a predicate AST whose option-
		// source property is structurally ambiguous — Nova can't infer
		// "the property providing the options" from a free-form
		// predicate. The widget falls back to a text input so the user
		// can still enter values; surfacing a select would lie about
		// where the options come from.
		renderForm({
			searchInputs: [
				advancedSearchInputDef(
					UUID_ADV_SELECT,
					"status_adv",
					"Status (advanced)",
					"select",
					matchAll(),
				),
			],
		});
		const input = screen.getByLabelText("Status (advanced)");
		expect((input as HTMLInputElement).tagName).toBe("INPUT");
		expect((input as HTMLInputElement).type).toBe("text");
		expect(
			screen.queryByRole("combobox", { name: "Status (advanced)" }),
		).toBeNull();
	});

	it("falls back to a text input when the targeted property is missing on the case type", () => {
		// Defends against blueprint state where a search input outlives
		// its property (rename / delete without a sync sweep). Surfacing
		// an empty Select would be a UX dead-end; the text fallback
		// keeps the input usable until the blueprint is corrected.
		renderForm({
			searchInputs: [
				simpleSearchInputDef(
					UUID_STATUS,
					"orphan",
					"Orphan",
					"select",
					"nonexistent_property",
				),
			],
		});
		const input = screen.getByLabelText("Orphan");
		expect((input as HTMLInputElement).tagName).toBe("INPUT");
		expect((input as HTMLInputElement).type).toBe("text");
	});

	it("falls back to a text input when caseType is undefined", () => {
		// A module mid-rename / mid-blueprint-load may not have a
		// resolved CaseType yet. The fallback ensures the form
		// renders something usable rather than crashing or showing
		// an empty Select.
		renderForm({
			searchInputs: [
				simpleSearchInputDef(
					UUID_STATUS,
					"status",
					"Status",
					"select",
					"status",
				),
			],
			caseType: NO_CASE_TYPE,
		});
		const input = screen.getByLabelText("Status");
		expect((input as HTMLInputElement).tagName).toBe("INPUT");
		expect((input as HTMLInputElement).type).toBe("text");
	});
});

// ── Debounce contract ──────────────────────────────────────────────

describe("debounced onChange emission", () => {
	it("fires onChange once per type-burst after 300 ms", () => {
		const { onChange } = renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_NAME, "name", "Name", "text", "name"),
			],
		});
		const input = screen.getByLabelText("Name") as HTMLInputElement;

		// Three keystrokes within the debounce window collapse to one
		// emission. `fireEvent.change` simulates the synthetic React
		// change event without invoking real setTimeout.
		fireEvent.change(input, { target: { value: "A" } });
		vi.advanceTimersByTime(100);
		fireEvent.change(input, { target: { value: "Al" } });
		vi.advanceTimersByTime(100);
		fireEvent.change(input, { target: { value: "Ali" } });
		expect(onChange).not.toHaveBeenCalled();

		vi.advanceTimersByTime(300);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(lastEmission(onChange)).toEqual({ name: "Ali" });
	});

	it("does not re-emit when the parent echoes the same map back through `value`", () => {
		// The classic controlled-component loop: emit → parent state
		// updates → parent re-renders with `value=newMap` → effect
		// sees a new `draft` reference → re-emits. The form guards
		// against this by tracking the last emitted map and skipping
		// scheduling when the incoming `value` matches.
		const { onChange, rerender } = renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_NAME, "name", "Name", "text", "name"),
			],
		});
		const input = screen.getByLabelText("Name") as HTMLInputElement;

		fireEvent.change(input, { target: { value: "Bob" } });
		vi.advanceTimersByTime(300);
		expect(onChange).toHaveBeenCalledTimes(1);

		// Parent now re-renders with the emitted map.
		const emitted = onChange.mock.calls[0]?.[0];
		expect(emitted).toBeDefined();
		if (emitted === undefined) return;
		rerender(emitted);
		vi.advanceTimersByTime(1000);
		// No additional emission — the parent's echo is a no-op for us.
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("does not emit when the parent pushes a fresh value reference", () => {
		// The realistic controlled-prop pattern: parents call
		// `setValues(new Map([...]))` — a fresh Map instance each
		// time. The reference-identity echo guard in the previous
		// test (parent passes the EXACT same Map instance back) is
		// insufficient; the form must also stamp `lastEmittedRef`
		// when an external `value` lands so the debounce effect
		// recognizes the new reference as "already accounted for"
		// and skips scheduling. Without that stamp every parent
		// update would echo back as a synthetic 300 ms emission.
		const { onChange, rerender } = renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_NAME, "name", "Name", "text", "name"),
			],
		});
		rerender(new Map([["name", "Carol"]]));
		vi.advanceTimersByTime(1000);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("clears the key from the emitted map when the user empties the input", () => {
		// Absent keys are semantically identical to empty values at the
		// runtime-bindings layer (both short-circuit to "no clause") so
		// the form normalizes empty inputs to absent keys. Keeps the
		// emitted map tight + makes the "did anything contribute" check
		// at the caller a one-liner.
		const initial: SearchInputValues = new Map([["name", "Bob"]]);
		const { onChange } = renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_NAME, "name", "Name", "text", "name"),
			],
			value: initial,
		});
		const input = screen.getByLabelText("Name") as HTMLInputElement;
		expect(input.value).toBe("Bob");

		fireEvent.change(input, { target: { value: "" } });
		vi.advanceTimersByTime(300);

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(lastEmission(onChange)).toEqual({});
	});
});

// ── Controlled-prop flow ───────────────────────────────────────────

describe("controlled `value` prop flow", () => {
	it("propagates parent value changes through to the rendered text input", () => {
		const { rerender } = renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_NAME, "name", "Name", "text", "name"),
			],
		});
		const input = screen.getByLabelText("Name") as HTMLInputElement;
		expect(input.value).toBe("");

		rerender(new Map([["name", "Carol"]]));
		expect(input.value).toBe("Carol");
	});

	it("renders a readable locale-formatted date while retaining an ISO wire value", () => {
		// The controlled value stays in the runtime binding's ISO shape,
		// but that storage detail should not leak into the running app.
		// `parseISO` lands on local-time midnight, so the locale formatter
		// preserves the authored calendar day in negative UTC offsets.
		const initial: SearchInputValues = new Map([["dob", "1990-05-12"]]);
		renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_DOB, "dob", "Date of birth", "date", "dob"),
			],
			value: initial,
		});
		const trigger = screen.getByLabelText("Date of birth");
		expect(trigger.textContent ?? "").toContain(readableDate(1990, 4, 12));
		expect(trigger.textContent ?? "").not.toContain("1990-05-12");
	});

	it("renders the placeholder when the inbound value is not ISO-shaped", () => {
		// A malformed inbound shape — URL-hydration edge case, typo'd
		// fixture, or a non-date value pushed into a date slot — would
		// pass through `parseISO` as Invalid Date and then crash
		// `format(invalidDate, ...)` with `RangeError: Invalid time
		// value`. The form re-applies the runtime-bindings layer's
		// ISO-pattern gate before handing values to `parseISO` so a
		// malformed value renders the placeholder cleanly.
		const initial: SearchInputValues = new Map([["dob", "garbage"]]);
		renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_DOB, "dob", "Date of birth", "date", "dob"),
			],
			value: initial,
		});
		const trigger = screen.getByLabelText("Date of birth");
		expect(trigger.textContent ?? "").toContain("Pick a date");
	});

	it("renders the placeholder when the inbound value passes the shape gate but is calendar-invalid", () => {
		// `"2024-13-45"` satisfies the regex (digits + dashes in the
		// `YYYY-MM-DD` layout) but `parseISO` produces an Invalid
		// Date — month 13, day 45 are out of range. Without the
		// `isValid` calendar-correctness gate, `format(invalidDate,
		// ...)` would throw `RangeError: Invalid time value` and
		// crash the entire `<search>` subtree. The widget surfaces
		// the placeholder instead, mirroring the regex-only-gate's
		// behavior for shape-invalid values.
		const initial: SearchInputValues = new Map([["dob", "2024-13-45"]]);
		renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_DOB, "dob", "Date of birth", "date", "dob"),
			],
			value: initial,
		});
		const trigger = screen.getByLabelText("Date of birth");
		expect(trigger.textContent ?? "").toContain("Pick a date");
	});

	it("renders readable locale-formatted bounds on both date-range Popover triggers", () => {
		const initial: SearchInputValues = new Map([
			["reg:from", "2024-01-01"],
			["reg:to", "2024-12-31"],
		]);
		renderForm({
			searchInputs: [
				simpleSearchInputDef(
					UUID_REG_RANGE,
					"reg",
					"Registered",
					"date-range",
					"reg_at",
				),
			],
			value: initial,
		});
		expect(
			screen.getByLabelText("Registered from").textContent ?? "",
		).toContain(readableDate(2024, 0, 1));
		expect(screen.getByLabelText("Registered to").textContent ?? "").toContain(
			readableDate(2024, 11, 31),
		);

		const range = document.querySelector("[data-date-range]");
		const fields = document.querySelector("[data-date-range-fields]");
		expect(range).not.toBeNull();
		expect(fields).not.toBeNull();
		expect(range?.className.split(" ")).toEqual(
			expect.arrayContaining(["@container/date-range", "min-w-0"]),
		);
		expect(fields?.className.split(" ")).toEqual(
			expect.arrayContaining([
				"min-w-0",
				"grid-cols-1",
				"@sm/date-range:grid-cols-2",
			]),
		);
		for (const label of ["Registered from", "Registered to"]) {
			const trigger = screen.getByLabelText(label);
			expect(trigger.className.split(" ")).toEqual(
				expect.arrayContaining([
					"min-h-11",
					"min-w-0",
					"whitespace-normal",
					"text-left",
				]),
			);
			expect(trigger.className).not.toContain("overflow-hidden");
			expect(trigger.querySelector("span")?.className).not.toContain(
				"truncate",
			);
		}
	});
});

// ── Date-range key shape ───────────────────────────────────────────

describe("date-range two-key emission", () => {
	it("emits both `:from` and `:to` keys when both bounds are set", () => {
		const { onChange } = renderForm({
			searchInputs: [
				simpleSearchInputDef(
					UUID_REG_RANGE,
					"reg",
					"Registered",
					"date-range",
					"reg_at",
				),
			],
		});

		// Open the "from" popover and pick Jan 1 from the mock
		// Calendar. The mock fires `onSelect(new Date(2024,0,1))`,
		// which the form formats through `date-fns`'s
		// `format(date, "yyyy-MM-dd")` — local time, no UTC
		// drift. The picker auto-closes after the pick (see
		// `DatePopoverField`'s controlled-open contract) so a
		// single calendar is in the DOM at any given moment.
		fireEvent.click(screen.getByLabelText("Registered from"));
		fireEvent.click(screen.getByTestId("mock-calendar-pick-jan-1"));

		// Now open the "to" popover and pick Dec 31. The "from"
		// popover already auto-closed; only the "to" calendar is
		// mounted, so `getByTestId` (single-match) succeeds.
		fireEvent.click(screen.getByLabelText("Registered to"));
		fireEvent.click(screen.getByTestId("mock-calendar-pick-dec-31"));

		vi.advanceTimersByTime(300);
		expect(lastEmission(onChange)).toEqual({
			"reg:from": "2024-01-01",
			"reg:to": "2024-12-31",
		});
	});

	it("leaves the other bound intact when one is cleared", () => {
		// Date-range bounds keep independent draft state — clearing the from
		// bound should not destroy the worker's to-bound selection, even though
		// Search now waits for a complete pair. The form surfaces a "Clear" button
		// inside the popover's footer when a value is set; tests
		// click it rather than driving the Calendar's keyboard.
		const initial: SearchInputValues = new Map([
			["reg:from", "2024-01-01"],
			["reg:to", "2024-12-31"],
		]);
		const { onChange } = renderForm({
			searchInputs: [
				simpleSearchInputDef(
					UUID_REG_RANGE,
					"reg",
					"Registered",
					"date-range",
					"reg_at",
				),
			],
			value: initial,
		});
		fireEvent.click(screen.getByLabelText("Registered from"));
		fireEvent.click(screen.getByRole("button", { name: /clear/i }));
		vi.advanceTimersByTime(300);

		expect(lastEmission(onChange)).toEqual({ "reg:to": "2024-12-31" });
	});
});

// ── Popover auto-close after pick ──────────────────────────────────

describe("popover auto-close after pick", () => {
	it("keeps the calendar within the available viewport height", () => {
		renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_DOB, "dob", "Date of birth", "date", "dob"),
			],
		});
		fireEvent.click(screen.getByLabelText("Date of birth"));

		const content = document.querySelector<HTMLElement>(
			'[data-slot="popover-content"]',
		);
		expect(content?.className).toContain("max-h-[var(--available-height)]");
		expect(content?.className).toContain("overflow-y-auto");
		expect(content?.className).toContain("overscroll-contain");
	});

	it("closes the single-date popover when a day is picked", () => {
		// Base UI's Popover only auto-dismisses on outside-press /
		// escape / close-press / focus-out — none fire when the
		// Calendar updates its own state. Without the controlled-
		// open contract in `DatePopoverField`, the popover would
		// stay open after the user picks, forcing them to click
		// outside before the next interaction. The mounted calendar
		// disappearing from the DOM after a pick is the cleanest
		// proxy for "popover closed".
		renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_DOB, "dob", "Date of birth", "date", "dob"),
			],
		});
		fireEvent.click(screen.getByLabelText("Date of birth"));
		expect(screen.queryByTestId("mock-calendar")).not.toBeNull();
		fireEvent.click(screen.getByTestId("mock-calendar-pick-jan-1"));
		expect(screen.queryByTestId("mock-calendar")).toBeNull();
	});

	it("closes the popover when the Clear button is pressed", () => {
		// Same auto-close contract on the Clear path — the popover
		// footer's clear affordance updates the value through the
		// same controlled-open seam, so the user doesn't have to
		// click outside after clearing.
		const initial: SearchInputValues = new Map([["dob", "1990-05-12"]]);
		renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_DOB, "dob", "Date of birth", "date", "dob"),
			],
			value: initial,
		});
		fireEvent.click(screen.getByLabelText("Date of birth"));
		expect(screen.queryByTestId("mock-calendar")).not.toBeNull();
		const clearButton = screen.getByRole("button", { name: /clear/i });
		expect(clearButton.className.split(" ")).toContain("h-11");
		fireEvent.click(clearButton);
		expect(screen.queryByTestId("mock-calendar")).toBeNull();
	});
});

// ── Multi-input composition ────────────────────────────────────────

describe("multi-input composition", () => {
	it("renders one widget per input and emits a single map carrying every set value", () => {
		const { onChange } = renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_NAME, "name", "Name", "text", "name"),
				simpleSearchInputDef(UUID_DOB, "dob", "Date of birth", "date", "dob"),
			],
		});

		const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
		fireEvent.change(nameInput, { target: { value: "Dee" } });

		// Drive the date via the mocked Calendar's Jan 1 button — the
		// Popover trigger opens the calendar; the mock's click handler
		// fires `onSelect(...)` synchronously, so `draft` updates in
		// the same render tick as the text input.
		fireEvent.click(screen.getByLabelText("Date of birth"));
		fireEvent.click(screen.getByTestId("mock-calendar-pick-jan-1"));

		vi.advanceTimersByTime(300);

		// Both contributions flow through a single emission — the
		// debounce window collapses cross-input bursts into one upward
		// signal, keeping the action-call cadence sane for the
		// running-app case-list reload trigger.
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(lastEmission(onChange)).toEqual({
			name: "Dee",
			dob: "2024-01-01",
		});
	});

	it("scopes the per-input row to its own input element so neighbors don't share state", () => {
		// Defends against a row-keying bug where two inputs of the
		// same type would alias each other's value. Adds an arity
		// check that each labelled input is a distinct DOM node.
		renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_NAME, "name", "Name", "text", "name"),
				simpleSearchInputDef(
					UUID_BARCODE,
					"barcode",
					"Barcode",
					"text",
					"name",
				),
			],
		});
		const nameInput = screen.getByLabelText("Name");
		const barcodeInput = screen.getByLabelText("Barcode");
		expect(nameInput).not.toBe(barcodeInput);
	});
});

// ── Export-parity validation ──────────────────────────────────────

describe("runtime CSQL quote validation", () => {
	it("blocks an explicit-query value after submit and clears live when corrected", () => {
		const explicitInput = simpleSearchInputDef(
			UUID_NAME,
			"name_query",
			"Name",
			"text",
			"case_name",
		);
		const onSubmit = vi.fn<(next: SearchInputValues) => void>();
		render(
			<SearchInputForm
				searchInputs={[explicitInput]}
				caseType={PATIENT_CASE_TYPE}
				value={new Map()}
				onChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		const field = screen.getByLabelText("Name");
		fireEvent.change(field, { target: { value: `it's "quoted"` } });
		expect(screen.queryByRole("alert")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toContain(
			"This search can't use both single and double quotation marks. Remove one kind and try again",
		);
		expect(field.getAttribute("aria-invalid")).toBe("true");

		fireEvent.change(field, { target: { value: "O'Connor" } });
		expect(screen.queryByRole("alert")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(Object.fromEntries(onSubmit.mock.calls[0]?.[0] ?? [])).toEqual({
			name_query: "O'Connor",
		});
	});

	it("does not carry attempted validation feedback into a new module scope", () => {
		const explicitInput = simpleSearchInputDef(
			UUID_NAME,
			"name_query",
			"Name",
			"text",
			"case_name",
		);
		const invalidValue = new Map([["name_query", `it's "quoted"`]]);
		const { rerender } = render(
			<SearchInputForm
				scopeKey="module-one"
				searchInputs={[explicitInput]}
				caseType={PATIENT_CASE_TYPE}
				value={invalidValue}
				onChange={vi.fn()}
				onSubmit={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		expect(screen.getByRole("alert")).toBeDefined();

		rerender(
			<SearchInputForm
				scopeKey="module-two"
				searchInputs={[explicitInput]}
				caseType={PATIENT_CASE_TYPE}
				value={invalidValue}
				onChange={vi.fn()}
				onSubmit={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).not.toBe(
			"true",
		);
	});

	it("allows both quote types on an auto-match-only prompt", () => {
		const autoMatchInput = simpleSearchInputDef(
			UUID_NAME,
			"case_name",
			"Name",
			"text",
			"case_name",
		);
		const onSubmit = vi.fn<(next: SearchInputValues) => void>();
		render(
			<SearchInputForm
				searchInputs={[autoMatchInput]}
				caseType={PATIENT_CASE_TYPE}
				value={new Map()}
				onChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: `it's "quoted"` },
		});
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("date-range submission validation", () => {
	it("keeps a partial pair editable but blocks Search until both dates are chosen", () => {
		const rangeInput = simpleSearchInputDef(
			UUID_REG_RANGE,
			"reg",
			"Registered",
			"date-range",
			"reg_at",
		);
		const onSubmit = vi.fn<(next: SearchInputValues) => void>();
		render(
			<SearchInputForm
				searchInputs={[rangeInput]}
				caseType={PATIENT_CASE_TYPE}
				value={new Map([["reg:from", "2024-01-01"]])}
				onChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		expect(onSubmit).not.toHaveBeenCalled();
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain(DATE_RANGE_PAIR_REQUIRED_MESSAGE);
		for (const label of ["Registered from", "Registered to"]) {
			const trigger = screen.getByLabelText(label);
			expect(trigger.getAttribute("aria-invalid")).toBe("true");
			expect(trigger.getAttribute("aria-describedby")).toBe(alert.id);
		}

		// Partial state stays intact while editing. Completing the missing bound
		// clears the error live, then submits the same two-key draft.
		fireEvent.click(screen.getByLabelText("Registered to"));
		fireEvent.click(screen.getByTestId("mock-calendar-pick-dec-31"));
		expect(screen.queryByRole("alert")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(Object.fromEntries(onSubmit.mock.calls[0]?.[0] ?? [])).toEqual({
			"reg:from": "2024-01-01",
			"reg:to": "2024-12-31",
		});
	});

	it("blocks a reversed pair with an actionable ordering message", () => {
		const onSubmit = vi.fn<(next: SearchInputValues) => void>();
		render(
			<SearchInputForm
				searchInputs={[
					simpleSearchInputDef(
						UUID_REG_RANGE,
						"reg",
						"Registered",
						"date-range",
						"reg_at",
					),
				]}
				caseType={PATIENT_CASE_TYPE}
				value={
					new Map([
						["reg:from", "2024-12-31"],
						["reg:to", "2024-01-01"],
					])
				}
				onChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toContain(
			DATE_RANGE_ORDER_MESSAGE,
		);
	});
});

// ── Layout sanity ──────────────────────────────────────────────────

describe("layout", () => {
	it("renders nothing when there are zero search inputs", () => {
		// The form contract is self-enforcing: a zero-input mount
		// returns `null` rather than a labelled-but-empty `<search>`
		// landmark. A caller that forgets to gate on
		// `searchInputs.length > 0` doesn't surface an assistive-
		// tech-visible no-op region.
		const { container } = renderForm({ searchInputs: [] });
		expect(container.querySelector("search")).toBeNull();
		expect(container.querySelectorAll("input")).toHaveLength(0);
	});

	it("places the form under a single landmark region for screen-reader navigation", () => {
		const { container } = renderForm({
			searchInputs: [
				simpleSearchInputDef(UUID_NAME, "name", "Name", "text", "name"),
			],
		});
		// HTML5 `<search>` is the canonical landmark for filter / search
		// regions — assistive tech maps it to the search landmark via
		// implicit role. happy-dom + aria-query don't expose that
		// implicit role through `getByRole("search")` yet, so the test
		// queries the element directly.
		const region = container.querySelector("search");
		expect(region).not.toBeNull();
		if (region === null) return;
		expect(within(region).getByLabelText("Name")).toBeDefined();
	});
});
