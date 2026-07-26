// @vitest-environment happy-dom

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureField } from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { AttachmentField } from "../AttachmentField";
import {
	__resetAttachmentCoordinatorForTests,
	getOwnedStagedAttachment,
	reconcileAttachmentRepeatCompaction,
	registerAttachmentSlotPath,
	rememberOwnedStagedAttachment,
	runAttachmentTask,
} from "../attachmentClient";

const { stageAttachmentMock, discardAttachmentMock, retargetAttachmentMock } =
	vi.hoisted(() => ({
		stageAttachmentMock: vi.fn(),
		discardAttachmentMock: vi.fn(),
		retargetAttachmentMock: vi.fn(),
	}));

vi.mock("@/lib/session/hooks", () => ({
	useEditMode: () => "preview" as const,
}));

vi.mock("../attachmentClient", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../attachmentClient")>();
	return {
		...actual,
		stageAttachment: stageAttachmentMock,
		discardAttachment: discardAttachmentMock,
		retargetAttachment: retargetAttachmentMock,
	};
});

const FIELD = {
	uuid: "22222222-2222-4222-8222-222222222222",
	id: "photo",
	kind: "image",
	label: "Photo",
} as CaptureField;
const SECOND_FIELD = {
	...FIELD,
	uuid: "33333333-3333-4333-8333-333333333333",
	id: "consent",
	label: "Signed consent",
} as CaptureField;
const SIGNATURE_FIELD = {
	...SECOND_FIELD,
	kind: "signature",
} as CaptureField;

const EMPTY_STATE: FieldState = {
	path: "/data/photo",
	value: "",
	visible: true,
	required: false,
	valid: true,
	touched: false,
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

beforeEach(() => {
	stageAttachmentMock.mockReset();
	discardAttachmentMock.mockReset();
	retargetAttachmentMock.mockReset();
	discardAttachmentMock.mockResolvedValue(undefined);
	retargetAttachmentMock.mockResolvedValue(undefined);
	stageAttachmentMock.mockRejectedValue(new Error("network failed"));
});

afterEach(() => {
	__resetAttachmentCoordinatorForTests();
});

describe("AttachmentField", () => {
	it("gives two capture questions distinct accessible control names", () => {
		render(
			<>
				<AttachmentField
					field={FIELD}
					state={EMPTY_STATE}
					path="/data/photo"
					appId="app-1"
					entryKey="11111111-1111-4111-8111-111111111111"
					onChange={vi.fn()}
					onBlur={vi.fn()}
				/>
				<AttachmentField
					field={SECOND_FIELD}
					state={{ ...EMPTY_STATE, path: "/data/consent" }}
					path="/data/consent"
					appId="app-1"
					entryKey="11111111-1111-4111-8111-111111111111"
					onChange={vi.fn()}
					onBlur={vi.fn()}
				/>
			</>,
		);

		expect(screen.getByLabelText(/Photo.*Attach file/i)).toBeDefined();
		expect(screen.getByLabelText(/Signed consent.*Attach file/i)).toBeDefined();
	});

	it("carries required, invalid, section, help, and status semantics across capture kinds", () => {
		render(
			<>
				<span id="section-one">Section 1. Visit.</span>
				<span id="question-photo">Question 1. Photo. Required.</span>
				<span id="photo-help">Attach a clear photo.</span>
				<AttachmentField
					field={FIELD}
					state={{
						...EMPTY_STATE,
						required: true,
						valid: false,
						touched: true,
						errorMessage: "Photo is required.",
					}}
					path="/data/photo"
					appId="app-1"
					entryKey="entry-capture-semantics"
					questionLabelledBy="section-one question-photo"
					questionDescriptionIds="photo-help"
					onChange={vi.fn()}
					onBlur={vi.fn()}
				/>
				<span id="section-two">Section 2. Visit.</span>
				<span id="question-signature">
					Question 1. Signed consent. Required.
				</span>
				<span id="signature-help">Ask the participant to sign.</span>
				<AttachmentField
					field={SIGNATURE_FIELD}
					state={{
						...EMPTY_STATE,
						path: "/data/consent",
						required: true,
						valid: false,
						touched: true,
						errorMessage: "Signature is required.",
					}}
					path="/data/consent"
					appId="app-1"
					entryKey="entry-capture-semantics"
					questionLabelledBy="section-two question-signature"
					questionDescriptionIds="signature-help"
					onChange={vi.fn()}
					onBlur={vi.fn()}
				/>
			</>,
		);

		const file = screen.getByLabelText(
			/Section 1.*Visit.*Question 1.*Photo.*Required.*Attach file/i,
		);
		const canvas = screen.getByLabelText(
			/Section 2.*Visit.*Question 1.*Signed consent.*Required.*Signature pad/i,
		);
		expect((file as HTMLInputElement).required).toBe(true);
		expect(canvas.getAttribute("aria-required")).toBe("true");
		for (const control of [file, canvas]) {
			expect(control.getAttribute("aria-invalid")).toBe("true");
			expect(control.getAttribute("aria-describedby")).toBeTruthy();
		}
		expect(file.getAttribute("aria-describedby")).toContain("photo-help");
		expect(canvas.getAttribute("aria-describedby")).toContain("signature-help");
		expect(screen.getAllByRole("status")).toHaveLength(2);
		expect(
			screen
				.getByRole("button", {
					name: /Clear signature.*Section 2.*Visit.*Question 1.*Signed consent/i,
				})
				.getAttribute("aria-describedby"),
		).toContain("signature-help");
	});

	it("resets the native input immediately so the same rejected file can retry", async () => {
		render(
			<AttachmentField
				field={FIELD}
				state={EMPTY_STATE}
				path="/data/photo"
				appId="app-1"
				entryKey="11111111-1111-4111-8111-111111111111"
				onChange={vi.fn()}
				onBlur={vi.fn()}
			/>,
		);
		const input = screen.getByLabelText(
			/Photo.*Attach file/i,
		) as HTMLInputElement;
		const file = new File(["png"], "photo.png", { type: "image/png" });

		Object.defineProperty(input, "value", {
			configurable: true,
			writable: true,
			value: "C:\\fakepath\\photo.png",
		});
		fireEvent.change(input, {
			target: { files: [file] },
		});
		expect(input.value).toBe("");
		await waitFor(() => expect(stageAttachmentMock).toHaveBeenCalledTimes(1));
		await screen.findByText(/couldn't be saved/i);

		input.value = "C:\\fakepath\\photo.png";
		fireEvent.change(input, {
			target: { files: [file] },
		});
		expect(input.value).toBe("");
		await waitFor(() => expect(stageAttachmentMock).toHaveBeenCalledTimes(2));
	});

	it("serializes Clear behind earlier work anywhere in the form entry", async () => {
		const entryKey = "33333333-3333-4333-8333-333333333333";
		const blockerStarted = deferred<void>();
		const releaseBlocker = deferred<void>();
		const blocker = runAttachmentTask({
			entryKey,
			instancePath: "/data/other",
			task: async () => {
				blockerStarted.resolve();
				await releaseBlocker.promise;
			},
		});
		await blockerStarted.promise;
		const onChange = vi.fn();
		render(
			<AttachmentField
				field={FIELD}
				state={{ ...EMPTY_STATE, value: "existing.png" }}
				path="/data/photo"
				appId="app-1"
				entryKey={entryKey}
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);

		const remove = screen.getByRole("button", {
			name: /Remove attachment for Photo/i,
		}) as HTMLButtonElement;
		fireEvent.click(remove);
		fireEvent.click(remove);
		expect(onChange).not.toHaveBeenCalled();
		expect(remove.disabled).toBe(true);
		expect(screen.getByRole("status").textContent).toMatch(
			/waiting to remove/i,
		);

		releaseBlocker.resolve();
		await blocker;
		await waitFor(() => expect(onChange).toHaveBeenCalledWith(""));
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("publishes queued upload intent before waiting behind another field", async () => {
		const entryKey = "entry-queued-upload-intent";
		const blockerStarted = deferred<void>();
		const releaseBlocker = deferred<void>();
		const blocker = runAttachmentTask({
			entryKey,
			instancePath: "/data/other",
			task: async () => {
				blockerStarted.resolve();
				await releaseBlocker.promise;
			},
		});
		await blockerStarted.promise;
		stageAttachmentMock.mockResolvedValue({
			attachmentId: "attachment-new",
			attachmentName: "attachment-new.png",
			originalFilename: "new.png",
			sizeBytes: 3,
		});
		render(
			<AttachmentField
				field={FIELD}
				state={EMPTY_STATE}
				path="/data/photo"
				appId="app-1"
				entryKey={entryKey}
				onChange={vi.fn()}
				onBlur={vi.fn()}
			/>,
		);
		const input = screen.getByLabelText(
			/Photo.*Attach file/i,
		) as HTMLInputElement;
		const file = new File(["png"], "new.png", { type: "image/png" });

		fireEvent.change(input, { target: { files: [file] } });
		fireEvent.change(input, { target: { files: [file] } });

		expect(input.disabled).toBe(true);
		expect(screen.getByRole("status").textContent).toMatch(
			/waiting to attach/i,
		);
		expect(stageAttachmentMock).not.toHaveBeenCalled();

		await act(async () => {
			releaseBlocker.resolve();
			await blocker;
		});
		await waitFor(() => expect(stageAttachmentMock).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(input.disabled).toBe(false));
	});

	it("keeps staged UI on the stable slot while its concrete path compacts", async () => {
		stageAttachmentMock.mockResolvedValue({
			attachmentId: "44444444-4444-4444-8444-444444444444",
			attachmentName: "44444444-4444-4444-8444-444444444444.png",
			originalFilename: "photo.png",
			sizeBytes: 3,
		});
		const onChange = vi.fn();
		const { rerender } = render(
			<AttachmentField
				field={FIELD}
				state={{ ...EMPTY_STATE, path: "/data/visits[1]/photo" }}
				path="/data/visits[1]/photo"
				appId="app-1"
				entryKey="55555555-5555-4555-8555-555555555555"
				attachmentSlotKey="photo:stable-row-2"
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);
		const input = screen.getByLabelText(
			/Photo.*Attach file/i,
		) as HTMLInputElement;
		fireEvent.change(input, {
			target: {
				files: [new File(["png"], "photo.png", { type: "image/png" })],
			},
		});
		await waitFor(() =>
			expect(onChange).toHaveBeenCalledWith(
				"44444444-4444-4444-8444-444444444444.png",
			),
		);

		rerender(
			<AttachmentField
				field={FIELD}
				state={{
					...EMPTY_STATE,
					path: "/data/visits[0]/photo",
					value: "44444444-4444-4444-8444-444444444444.png",
				}}
				path="/data/visits[0]/photo"
				appId="app-1"
				entryKey="55555555-5555-4555-8555-555555555555"
				attachmentSlotKey="photo:stable-row-2"
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);

		expect(await screen.findByText("photo.png")).toBeDefined();
		expect(retargetAttachmentMock).not.toHaveBeenCalled();
		expect(discardAttachmentMock).not.toHaveBeenCalled();
	});

	it("does not let an old retarget failure cancel a newer queued replacement", async () => {
		const entryKey = "entry-retarget-latest-wins";
		const slotKey = "photo:stable-row-2";
		const oldAttachmentName = "attachment-old.png";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/photo",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/photo",
			attachment: {
				attachmentId: "attachment-old",
				attachmentName: oldAttachmentName,
				originalFilename: "old.png",
				sizeBytes: 3,
			},
		});
		const patchResponse = deferred<{ ok: boolean; status: number }>();
		vi.stubGlobal(
			"fetch",
			vi.fn((_url, init?: RequestInit) =>
				init?.method === "PATCH"
					? patchResponse.promise
					: Promise.resolve({ ok: true, status: 200 }),
			),
		);
		stageAttachmentMock.mockResolvedValue({
			attachmentId: "attachment-new",
			attachmentName: "attachment-new.png",
			originalFilename: "new.png",
			sizeBytes: 4,
		});
		let setAnswer!: (value: string) => void;
		function Harness() {
			const [value, setValue] = useState(oldAttachmentName);
			setAnswer = setValue;
			return (
				<AttachmentField
					field={FIELD}
					state={{
						...EMPTY_STATE,
						path: "/data/visits[1]/photo",
						value,
					}}
					path="/data/visits[1]/photo"
					appId="app-1"
					entryKey={entryKey}
					attachmentSlotKey={slotKey}
					onChange={setValue}
					onBlur={vi.fn()}
					onChangeAt={(_path, next) => setValue(next)}
				/>
			);
		}
		render(<Harness />);

		const maintenance = reconcileAttachmentRepeatCompaction({
			appId: "app-1",
			entryKey,
			compaction: {
				removedPrefix: "/data/visits[0]",
				moves: [
					{
						fromPrefix: "/data/visits[1]",
						toPrefix: "/data/visits[0]",
					},
				],
			},
			onRetargetFailure: () => setAnswer(""),
		});
		await waitFor(() =>
			expect(vi.mocked(fetch)).toHaveBeenCalledWith(
				expect.stringContaining("attachment-old"),
				expect.objectContaining({ method: "PATCH" }),
			),
		);
		const input = screen.getByLabelText(
			/Photo.*Replace file/i,
		) as HTMLInputElement;
		fireEvent.change(input, {
			target: {
				files: [new File(["new"], "new.png", { type: "image/png" })],
			},
		});
		expect(input.disabled).toBe(true);

		await act(async () => {
			patchResponse.resolve({ ok: false, status: 409 });
			await maintenance;
		});
		await waitFor(() => expect(stageAttachmentMock).toHaveBeenCalledTimes(1));
		expect(await screen.findByText("new.png")).toBeDefined();
		expect(
			getOwnedStagedAttachment({
				appId: "app-1",
				entryKey,
				slotKey,
			}),
		)?.toMatchObject({ attachmentId: "attachment-new" });
	});

	it("drops local capture UI state when the engine clears the form externally", async () => {
		stageAttachmentMock.mockResolvedValue({
			attachmentId: "66666666-6666-4666-8666-666666666666",
			attachmentName: "66666666-6666-4666-8666-666666666666.png",
			originalFilename: "photo.png",
			sizeBytes: 3,
		});
		const onChange = vi.fn();
		const { rerender } = render(
			<AttachmentField
				field={FIELD}
				state={EMPTY_STATE}
				path="/data/photo"
				appId="app-1"
				entryKey="77777777-7777-4777-8777-777777777777"
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);
		fireEvent.change(screen.getByLabelText(/Photo.*Attach file/i), {
			target: {
				files: [new File(["png"], "photo.png", { type: "image/png" })],
			},
		});
		await waitFor(() =>
			expect(onChange).toHaveBeenCalledWith(
				"66666666-6666-4666-8666-666666666666.png",
			),
		);

		rerender(
			<AttachmentField
				field={FIELD}
				state={{
					...EMPTY_STATE,
					value: "66666666-6666-4666-8666-666666666666.png",
				}}
				path="/data/photo"
				appId="app-1"
				entryKey="77777777-7777-4777-8777-777777777777"
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);
		await screen.findByText("photo.png");
		rerender(
			<AttachmentField
				field={FIELD}
				state={EMPTY_STATE}
				path="/data/photo"
				appId="app-1"
				entryKey="77777777-7777-4777-8777-777777777777"
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);

		await screen.findByText("No file attached.");
		await waitFor(() =>
			expect(discardAttachmentMock).toHaveBeenCalledWith({
				appId: "app-1",
				attachmentId: "66666666-6666-4666-8666-666666666666",
			}),
		);
	});

	it("keeps a confirmed answer through relevance or Preview/Edit remounts", async () => {
		const entryKey = "88888888-8888-4888-8888-888888888888";
		const attachmentName = "99999999-9999-4999-8999-999999999999.png";
		stageAttachmentMock.mockResolvedValue({
			attachmentId: "99999999-9999-4999-8999-999999999999",
			attachmentName,
			originalFilename: "visit-photo.png",
			sizeBytes: 3,
		});
		const onChange = vi.fn();
		const mounted = render(
			<AttachmentField
				field={FIELD}
				state={EMPTY_STATE}
				path="/data/photo"
				appId="app-1"
				entryKey={entryKey}
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);
		fireEvent.change(screen.getByLabelText(/Photo.*Attach file/i), {
			target: {
				files: [new File(["png"], "visit-photo.png", { type: "image/png" })],
			},
		});
		await waitFor(() => expect(onChange).toHaveBeenCalledWith(attachmentName));
		mounted.rerender(
			<AttachmentField
				field={FIELD}
				state={{ ...EMPTY_STATE, value: attachmentName }}
				path="/data/photo"
				appId="app-1"
				entryKey={entryKey}
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);
		await screen.findByText("visit-photo.png");

		mounted.unmount();

		expect(discardAttachmentMock).not.toHaveBeenCalled();
		expect(
			getOwnedStagedAttachment({
				appId: "app-1",
				entryKey,
				instancePath: "/data/photo",
			}),
		).toMatchObject({ attachmentName, originalFilename: "visit-photo.png" });

		render(
			<AttachmentField
				field={FIELD}
				state={{ ...EMPTY_STATE, value: attachmentName }}
				path="/data/photo"
				appId="app-1"
				entryKey={entryKey}
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);
		expect(await screen.findByText("visit-photo.png")).toBeDefined();
		expect(discardAttachmentMock).not.toHaveBeenCalled();
	});

	it("exposes a focusable picker, honest disabled state, and described async feedback", async () => {
		stageAttachmentMock.mockImplementation(
			({ signal }: { signal: AbortSignal }) =>
				new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
		);
		render(
			<AttachmentField
				field={FIELD}
				state={EMPTY_STATE}
				path="/data/photo"
				appId="app-1"
				entryKey="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
				onChange={vi.fn()}
				onBlur={vi.fn()}
			/>,
		);
		const input = screen.getByLabelText(
			/Photo.*Attach file/i,
		) as HTMLInputElement;
		const label = input.closest("label");
		expect(label).not.toBeNull();
		input.focus();
		expect(document.activeElement).toBe(input);
		expect(input.getAttribute("aria-describedby")).toContain(
			screen.getByRole("status").id,
		);

		fireEvent.change(input, {
			target: {
				files: [new File(["png"], "photo.png", { type: "image/png" })],
			},
		});
		await waitFor(() => expect(input.disabled).toBe(true));
		expect(label?.getAttribute("aria-disabled")).toBe("true");
		expect(label?.className).toContain("opacity-40");
		expect(screen.getByRole("status").textContent).toMatch(/attaching/i);

		__resetAttachmentCoordinatorForTests();
	});

	it("announces attachment failures and associates them with the picker", async () => {
		render(
			<AttachmentField
				field={FIELD}
				state={EMPTY_STATE}
				path="/data/photo"
				appId="app-1"
				entryKey="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
				onChange={vi.fn()}
				onBlur={vi.fn()}
			/>,
		);
		const input = screen.getByLabelText(
			/Photo.*Attach file/i,
		) as HTMLInputElement;
		fireEvent.change(input, {
			target: {
				files: [new File(["png"], "photo.png", { type: "image/png" })],
			},
		});
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(/couldn't be saved/i);
		expect(input.getAttribute("aria-describedby")).toContain(alert.id);
	});
});
