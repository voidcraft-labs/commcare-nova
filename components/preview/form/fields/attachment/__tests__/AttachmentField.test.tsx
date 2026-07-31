// @vitest-environment happy-dom

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { CaptureField } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import type { FieldState } from "@/lib/preview/engine/types";
import { AttachmentField as ProductionAttachmentField } from "../AttachmentField";
import {
	__resetAttachmentCoordinatorForTests,
	type AttachmentEntryAuthoritySnapshot,
	getOwnedStagedAttachment,
	reconcileAttachmentRepeatCompaction,
	registerAttachmentSlotPath,
	rememberOwnedStagedAttachment,
	rememberSignatureDraft,
	runAttachmentTask,
	runFormAttachmentBarrier,
	type StagedAttachment,
	setAttachmentEntryAuthority,
	setAttachmentSlotIssue,
} from "../attachmentClient";

const TEST_AUTHORITY_COORDINATES = {
	formUuid: "22222222-2222-4222-8222-222222222222",
	projectId: "project-attachment-test",
	actorUserId: "actor-attachment-test",
	ownerId: "actor-attachment-test",
} as const;

function installTestAuthority(entryKey: string): void {
	const current = (): AttachmentEntryAuthoritySnapshot => ({
		appId: "app-1",
		entryKey,
		...TEST_AUTHORITY_COORDINATES,
		scopeEpoch: accessState.scopeEpoch,
		accessPhase: accessState.accessPhase,
		canEdit: accessState.canEdit,
	});
	setAttachmentEntryAuthority({
		entryKey,
		snapshot: current(),
		readCurrent: current,
	});
}

type TestAttachmentFieldProps = ComponentProps<
	typeof ProductionAttachmentField
> & {
	readonly onChange: (value: string) => void;
	readonly onBlur: () => void;
};

function AttachmentField({
	onChange,
	onBlur,
	onChangeAt,
	onBlurAt,
	...props
}: TestAttachmentFieldProps) {
	if (props.entryKey !== undefined && props.appId !== undefined) {
		installTestAuthority(props.entryKey);
	}
	// The control spells its accessible name's prose against the document, the
	// way every production render reaches it (through `InteractiveFormRenderer`
	// inside the builder's provider). These fixtures carry literal labels, so an
	// empty document resolves everything they reference.
	return (
		<BlueprintDocProvider appId="app-1">
			<ProductionAttachmentField
				{...props}
				attachmentSlotKey={
					props.attachmentSlotKey ?? props.path ?? props.field.uuid
				}
				onChangeAt={onChangeAt ?? ((_path, value) => onChange(value))}
				onBlurAt={onBlurAt ?? (() => onBlur())}
			/>
		</BlueprintDocProvider>
	);
}

const {
	stageAttachmentMock,
	discardAttachmentMock,
	retargetAttachmentMock,
	scheduleAttachmentCleanupMock,
	accessState,
} = vi.hoisted(() => ({
	stageAttachmentMock: vi.fn(),
	discardAttachmentMock: vi.fn(),
	retargetAttachmentMock: vi.fn(),
	scheduleAttachmentCleanupMock: vi.fn(),
	accessState: {
		canEdit: true,
		accessPhase: "authorized" as "authorized" | "refreshing",
		scopeEpoch: 0,
	},
}));

vi.mock("@/lib/session/hooks", () => ({
	useEditMode: () => "preview" as const,
	useCanEdit: () => accessState.canEdit,
	useAccessPhase: () => accessState.accessPhase,
	useProjectScopeEpoch: () => accessState.scopeEpoch,
}));

vi.mock("../attachmentClient", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../attachmentClient")>();
	return {
		...actual,
		stageAttachment: stageAttachmentMock,
		discardAttachment: discardAttachmentMock,
		retargetAttachment: retargetAttachmentMock,
		scheduleAttachmentCleanup: scheduleAttachmentCleanupMock,
	};
});

const FIELD = {
	uuid: "22222222-2222-4222-8222-222222222222",
	id: "photo",
	kind: "image",
	label: proseText("Photo"),
} as CaptureField;
const SECOND_FIELD = {
	...FIELD,
	uuid: "33333333-3333-4333-8333-333333333333",
	id: "consent",
	label: proseText("Signed consent"),
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
	accessState.canEdit = true;
	accessState.accessPhase = "authorized";
	accessState.scopeEpoch = 0;
	stageAttachmentMock.mockReset();
	discardAttachmentMock.mockReset();
	retargetAttachmentMock.mockReset();
	scheduleAttachmentCleanupMock.mockReset();
	discardAttachmentMock.mockResolvedValue(undefined);
	retargetAttachmentMock.mockResolvedValue(undefined);
	stageAttachmentMock.mockRejectedValue(new Error("network failed"));
});

afterEach(async () => {
	await __resetAttachmentCoordinatorForTests();
	vi.useRealTimers();
	vi.restoreAllMocks();
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

	it("keeps file capture staging, removal, and recovery read-only for Project viewers", async () => {
		accessState.canEdit = false;
		const entryKey = "entry-viewer-file";
		render(
			<AttachmentField
				field={FIELD}
				state={{ ...EMPTY_STATE, value: "existing.png" }}
				path="/data/photo"
				appId="app-1"
				entryKey={entryKey}
				onChange={vi.fn()}
				onBlur={vi.fn()}
			/>,
		);
		const input = screen.getByLabelText(
			/Photo.*Read-only attachment/i,
		) as HTMLInputElement;
		const remove = screen.getByRole("button", {
			name: /Remove attachment for Photo/i,
		}) as HTMLButtonElement;
		expect(input.disabled).toBe(true);
		expect(remove.disabled).toBe(true);
		expect(screen.getByText("Project editors can attach files.")).toBeDefined();

		fireEvent.change(input, {
			target: {
				files: [new File(["png"], "viewer.png", { type: "image/png" })],
			},
		});
		expect(stageAttachmentMock).not.toHaveBeenCalled();

		act(() => {
			setAttachmentSlotIssue({
				appId: "app-1",
				entryKey,
				slotKey: "/data/photo",
				issue: {
					kind: "retarget",
					message: "This attachment needs recovery.",
				},
			});
		});
		const retry = await screen.findByRole("button", {
			name: /Retry attachment for Photo/i,
		});
		expect((retry as HTMLButtonElement).disabled).toBe(true);
		expect(stageAttachmentMock).not.toHaveBeenCalled();
	});

	it("keeps signature drawing, clearing, and retry read-only for Project viewers", async () => {
		accessState.canEdit = false;
		const entryKey = "entry-viewer-signature";
		render(
			<AttachmentField
				field={SIGNATURE_FIELD}
				state={{
					...EMPTY_STATE,
					path: "/data/consent",
					value: "signature.png",
				}}
				path="/data/consent"
				appId="app-1"
				entryKey={entryKey}
				onChange={vi.fn()}
				onBlur={vi.fn()}
			/>,
		);
		const canvas = screen.getByLabelText(/Signed consent.*Signature pad/i);
		const clear = screen.getByRole("button", {
			name: /Clear signature.*Signed consent/i,
		}) as HTMLButtonElement;
		expect(canvas.getAttribute("aria-readonly")).toBe("true");
		expect(clear.disabled).toBe(true);
		expect(
			screen.getByText("Project editors can attach signatures."),
		).toBeDefined();

		fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
		fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
		expect(stageAttachmentMock).not.toHaveBeenCalled();

		act(() => {
			setAttachmentSlotIssue({
				appId: "app-1",
				entryKey,
				slotKey: "/data/consent",
				issue: {
					kind: "retarget",
					message: "This signature needs recovery.",
				},
			});
		});
		const retry = await screen.findByRole("button", {
			name: /Retry signature for Signed consent/i,
		});
		expect((retry as HTMLButtonElement).disabled).toBe(true);
		expect(stageAttachmentMock).not.toHaveBeenCalled();
	});

	it("cancels and fences a file upload when edit authority is lost", async () => {
		const staged = deferred<StagedAttachment>();
		const pickedFile = new File(["png"], "photo.png", {
			type: "image/png",
		});
		stageAttachmentMock
			.mockReturnValueOnce(staged.promise)
			.mockResolvedValueOnce({
				attachmentId: "attachment-after-restoration",
				attachmentName: "attachment-after-restoration.png",
				originalFilename: "photo.png",
				sizeBytes: 3,
			});
		const onChange = vi.fn();
		const props = {
			field: FIELD,
			state: EMPTY_STATE,
			path: "/data/photo",
			appId: "app-1",
			entryKey: "entry-authority-loss",
			onChange,
			onBlur: vi.fn(),
		} as const;
		const view = render(<AttachmentField {...props} />);
		const input = screen.getByLabelText(
			/Photo.*Attach file/i,
		) as HTMLInputElement;
		fireEvent.change(input, {
			target: {
				files: [pickedFile],
			},
		});
		await waitFor(() => expect(stageAttachmentMock).toHaveBeenCalledOnce());

		accessState.canEdit = false;
		view.rerender(<AttachmentField {...props} />);
		expect(screen.getByRole("status").textContent).toContain("photo.png");
		expect(screen.getByRole("alert").textContent).toMatch(/paused/i);
		expect(
			screen.getByRole("button", { name: /Retry attachment for Photo/i }),
		).toBeDefined();
		staged.resolve({
			attachmentId: "attachment-after-revocation",
			attachmentName: "attachment-after-revocation.png",
			originalFilename: "photo.png",
			sizeBytes: 3,
		});
		await waitFor(() =>
			expect(scheduleAttachmentCleanupMock).toHaveBeenCalledWith({
				appId: "app-1",
				attachmentId: "attachment-after-revocation",
			}),
		);
		expect(onChange).not.toHaveBeenCalled();
		await expect(
			runFormAttachmentBarrier(props.entryKey, async () => "must not submit"),
		).rejects.toMatchObject({
			name: "AttachmentNotReadyError",
		});

		accessState.canEdit = true;
		view.rerender(<AttachmentField {...props} />);
		fireEvent.click(
			screen.getByRole("button", { name: /Retry attachment for Photo/i }),
		);
		await waitFor(() => expect(stageAttachmentMock).toHaveBeenCalledTimes(2));
		expect(stageAttachmentMock.mock.calls[1]?.[0].file).toBe(pickedFile);
		await waitFor(() =>
			expect(onChange).toHaveBeenCalledWith("attachment-after-restoration.png"),
		);
	});

	it("cleans a just-confirmed row when the controller rotates before passive entry cleanup", async () => {
		const entryKey = "entry-controller-rotation-before-cleanup";
		const nextEntryKey = "entry-controller-rotation-successor";
		let liveEntryKey = entryKey;
		const currentAuthority = (): AttachmentEntryAuthoritySnapshot => ({
			appId: "app-1",
			entryKey: liveEntryKey,
			...TEST_AUTHORITY_COORDINATES,
			scopeEpoch: 0,
			accessPhase: "authorized",
			canEdit: true,
		});
		setAttachmentEntryAuthority({
			entryKey,
			snapshot: currentAuthority(),
			readCurrent: currentAuthority,
		});
		const confirmed = deferred<StagedAttachment>();
		stageAttachmentMock.mockReturnValue(confirmed.promise);
		const onChange = vi.fn();
		render(
			<BlueprintDocProvider appId="app-1">
				<ProductionAttachmentField
					field={FIELD}
					state={EMPTY_STATE}
					path="/data/photo"
					appId="app-1"
					entryKey={entryKey}
					attachmentSlotKey="photo:controller-rotation"
					onChangeAt={(_path, value) => onChange(value)}
					onBlurAt={vi.fn()}
				/>
			</BlueprintDocProvider>,
		);
		fireEvent.change(screen.getByLabelText(/Photo.*Attach file/i), {
			target: {
				files: [new File(["png"], "rotating.png", { type: "image/png" })],
			},
		});
		await waitFor(() => expect(stageAttachmentMock).toHaveBeenCalledOnce());

		// EngineController has synchronously installed its successor entry, but
		// FormScreen's passive cleanup has not retired the old coordinator yet.
		liveEntryKey = nextEntryKey;
		setAttachmentEntryAuthority({
			entryKey: nextEntryKey,
			snapshot: currentAuthority(),
			readCurrent: currentAuthority,
		});
		confirmed.resolve({
			attachmentId: "attachment-confirmed-during-controller-rotation",
			attachmentName: "attachment-confirmed-during-controller-rotation.png",
			originalFilename: "rotating.png",
			sizeBytes: 3,
		});

		await waitFor(() =>
			expect(scheduleAttachmentCleanupMock).toHaveBeenCalledWith({
				appId: "app-1",
				attachmentId: "attachment-confirmed-during-controller-rotation",
			}),
		);
		expect(onChange).not.toHaveBeenCalled();
		expect(
			getOwnedStagedAttachment({
				appId: "app-1",
				entryKey,
				slotKey: "photo:controller-rotation",
			}),
		).toBeUndefined();
	});

	it("retains the exact replacement file and previous owner across authority loss", async () => {
		const entryKey = "entry-replacement-authority-loss";
		const slotKey = "photo:replacement-authority";
		const previous = {
			attachmentId: "attachment-before-refresh",
			attachmentName: "attachment-before-refresh.png",
			originalFilename: "old.png",
			sizeBytes: 3,
		};
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/photo",
			fieldUuid: FIELD.uuid,
			captureKind: "image",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/photo",
			attachment: previous,
		});
		const firstAttempt = deferred<StagedAttachment>();
		const pickedFile = new File(["new"], "replacement.png", {
			type: "image/png",
		});
		stageAttachmentMock
			.mockReturnValueOnce(firstAttempt.promise)
			.mockResolvedValueOnce({
				attachmentId: "attachment-after-refresh",
				attachmentName: "attachment-after-refresh.png",
				originalFilename: "replacement.png",
				sizeBytes: 3,
			});
		const onChange = vi.fn();
		const props = {
			field: FIELD,
			state: { ...EMPTY_STATE, value: previous.attachmentName },
			path: "/data/photo",
			appId: "app-1",
			entryKey,
			attachmentSlotKey: slotKey,
			onChange,
			onBlur: vi.fn(),
		} as const;
		const view = render(<AttachmentField {...props} />);
		fireEvent.change(screen.getByLabelText(/Photo.*Replace file/i), {
			target: { files: [pickedFile] },
		});
		await waitFor(() => expect(stageAttachmentMock).toHaveBeenCalledOnce());

		accessState.accessPhase = "refreshing";
		view.rerender(<AttachmentField {...props} />);
		await waitFor(() =>
			expect(screen.getByRole("status").textContent).toContain(
				"replacement.png",
			),
		);
		expect(
			getOwnedStagedAttachment({ appId: "app-1", entryKey, slotKey }),
		)?.toEqual(previous);
		firstAttempt.resolve({
			attachmentId: "attachment-late-replacement",
			attachmentName: "attachment-late-replacement.png",
			originalFilename: "replacement.png",
			sizeBytes: 3,
		});
		await waitFor(() =>
			expect(scheduleAttachmentCleanupMock).toHaveBeenCalledWith({
				appId: "app-1",
				attachmentId: "attachment-late-replacement",
			}),
		);
		await expect(
			runFormAttachmentBarrier(entryKey, async () => "must not submit"),
		).rejects.toMatchObject({ name: "AttachmentNotReadyError" });

		accessState.accessPhase = "authorized";
		view.rerender(<AttachmentField {...props} />);
		fireEvent.click(
			screen.getByRole("button", { name: /Retry attachment for Photo/i }),
		);
		await waitFor(() => expect(stageAttachmentMock).toHaveBeenCalledTimes(2));
		expect(stageAttachmentMock.mock.calls[1]?.[0].file).toBe(pickedFile);
		await waitFor(() =>
			expect(
				getOwnedStagedAttachment({ appId: "app-1", entryKey, slotKey }),
			)?.toMatchObject({ attachmentId: "attachment-after-refresh" }),
		);
		expect(onChange).toHaveBeenCalledWith("attachment-after-refresh.png");
	});

	it("cancels a queued Clear without dropping ownership when edit authority is lost", async () => {
		const entryKey = "entry-clear-authority-loss";
		const slotKey = "/data/photo";
		installTestAuthority(entryKey);
		const blockerStarted = deferred<void>();
		const blockerRelease = deferred<void>();
		const blocker = runAttachmentTask({
			entryKey,
			slotKey: "other-slot",
			task: async () => {
				blockerStarted.resolve();
				await blockerRelease.promise;
			},
		});
		const blockerResult = blocker.catch((error: unknown) => error);
		await blockerStarted.promise;
		const owned = {
			attachmentId: "attachment-before-revocation",
			attachmentName: "attachment-before-revocation.png",
			originalFilename: "photo.png",
			sizeBytes: 3,
		};
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			fieldUuid: FIELD.uuid,
			instancePath: "/data/photo",
			captureKind: "image",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/photo",
			attachment: owned,
		});
		const onChange = vi.fn();
		const props = {
			field: FIELD,
			state: { ...EMPTY_STATE, value: owned.attachmentName },
			path: "/data/photo",
			appId: "app-1",
			entryKey,
			onChange,
			onBlur: vi.fn(),
		} as const;
		const view = render(<AttachmentField {...props} />);
		fireEvent.click(
			screen.getByRole("button", {
				name: /Remove attachment for Photo/i,
			}),
		);

		await act(async () => {
			accessState.canEdit = false;
			view.rerender(<AttachmentField {...props} />);
			blockerRelease.resolve();
			expect(await blockerResult).toMatchObject({ name: "AbortError" });
			await Promise.resolve();
		});

		expect(onChange).not.toHaveBeenCalled();
		expect(scheduleAttachmentCleanupMock).not.toHaveBeenCalled();
		expect(
			getOwnedStagedAttachment({ appId: "app-1", entryKey, slotKey }),
		).toEqual(owned);
	});

	it("names failed recovery actions by their question and keeps one signature removal action", async () => {
		const entryKey = "entry-distinct-recovery-actions";
		render(
			<>
				<AttachmentField
					field={FIELD}
					state={{ ...EMPTY_STATE, value: "photo-old.png" }}
					path="/data/photo"
					appId="app-1"
					entryKey={entryKey}
					onChange={vi.fn()}
					onBlur={vi.fn()}
				/>
				<AttachmentField
					field={SIGNATURE_FIELD}
					state={{
						...EMPTY_STATE,
						path: "/data/consent",
						value: "signature-old.png",
					}}
					path="/data/consent"
					appId="app-1"
					entryKey={entryKey}
					onChange={vi.fn()}
					onBlur={vi.fn()}
				/>
			</>,
		);

		act(() => {
			setAttachmentSlotIssue({
				appId: "app-1",
				entryKey,
				slotKey: "/data/photo",
				issue: {
					kind: "retarget",
					message:
						"This attachment could not move to the question's current location. Retry now, attach a replacement, or remove it.",
				},
			});
			setAttachmentSlotIssue({
				appId: "app-1",
				entryKey,
				slotKey: "/data/consent",
				issue: {
					kind: "retarget",
					message:
						"This signature could not move to the question's current location. Retry now, draw it again, or use Clear signature.",
				},
			});
		});

		expect(
			await screen.findByRole("button", { name: /Retry.*Photo/i }),
		).toBeDefined();
		expect(
			screen.getByRole("button", { name: /Retry.*Signed consent/i }),
		).toBeDefined();
		expect(
			screen.getByRole("button", { name: /Remove attachment.*Photo/i }),
		).toBeDefined();
		expect(
			screen.getAllByRole("button", {
				name: /(?:Remove|Clear) signature.*Signed consent/i,
			}),
		).toHaveLength(1);
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
		installTestAuthority(entryKey);
		const blockerStarted = deferred<void>();
		const releaseBlocker = deferred<void>();
		const blocker = runAttachmentTask({
			entryKey,
			slotKey: "/data/other",
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

	it.each([
		{
			name: "file Remove",
			field: FIELD,
			path: "/data/photo",
			value: "existing.png",
			action: /Remove attachment for Photo/i,
		},
		{
			name: "signature Clear",
			field: SIGNATURE_FIELD,
			path: "/data/consent",
			value: "existing-signature.png",
			action: /Clear signature.*Signed consent/i,
		},
	])(
		"keeps an active $name ahead of Submit under its real slot target",
		async ({ field, path, value, action }) => {
			const entryKey = `entry-clear-submit-${field.kind}`;
			installTestAuthority(entryKey);
			const blockerStarted = deferred<void>();
			const releaseBlocker = deferred<void>();
			const order: string[] = [];
			const blocker = runAttachmentTask({
				entryKey,
				slotKey: "/data/other",
				task: async () => {
					blockerStarted.resolve();
					await releaseBlocker.promise;
					order.push("blocker");
				},
			});
			await blockerStarted.promise;
			const onChange = vi.fn((_value: string) => order.push("answer-cleared"));
			render(
				<AttachmentField
					field={field}
					state={{ ...EMPTY_STATE, path, value }}
					path={path}
					appId="app-1"
					entryKey={entryKey}
					onChange={onChange}
					onBlur={vi.fn()}
					onChangeAt={(_path, value) => onChange(value)}
					onBlurAt={vi.fn()}
				/>,
			);

			fireEvent.click(screen.getByRole("button", { name: action }));
			const barrier = runFormAttachmentBarrier(
				entryKey,
				async () => {
					order.push("submitted");
				},
				{
					classifySlot: ({ instancePath }) =>
						instancePath.startsWith("/data/") ? "active" : "removed",
				},
			);
			await act(async () => {
				releaseBlocker.resolve();
				await Promise.all([blocker, barrier]);
			});

			expect(order).toEqual(["blocker", "answer-cleared", "submitted"]);
			expect(onChange).toHaveBeenCalledWith("");
		},
	);

	it("publishes queued upload intent before waiting behind another field", async () => {
		const entryKey = "entry-queued-upload-intent";
		installTestAuthority(entryKey);
		const blockerStarted = deferred<void>();
		const releaseBlocker = deferred<void>();
		const blocker = runAttachmentTask({
			entryKey,
			slotKey: "/data/other",
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

	it("cancels a replacement generation without losing the prior confirmed answer", async () => {
		const entryKey = "entry-cancel-replacement";
		const slotKey = "/data/photo";
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/photo",
			attachment: {
				attachmentId: "attachment-old",
				attachmentName: "attachment-old.png",
				originalFilename: "old.png",
				sizeBytes: 3,
			},
		});
		const replacement = deferred<{
			attachmentId: string;
			attachmentName: string;
			originalFilename: string;
			sizeBytes: number;
		}>();
		stageAttachmentMock.mockReturnValue(replacement.promise);
		const onChange = vi.fn();
		render(
			<AttachmentField
				field={FIELD}
				state={{ ...EMPTY_STATE, value: "attachment-old.png" }}
				path="/data/photo"
				appId="app-1"
				entryKey={entryKey}
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);

		fireEvent.change(screen.getByLabelText(/Photo.*Replace file/i), {
			target: {
				files: [new File(["new"], "new.png", { type: "image/png" })],
			},
		});
		await waitFor(() => expect(stageAttachmentMock).toHaveBeenCalledTimes(1));
		fireEvent.click(
			screen.getByRole("button", { name: /Cancel attachment.*Photo/i }),
		);

		await act(async () => {
			replacement.resolve({
				attachmentId: "attachment-late",
				attachmentName: "attachment-late.png",
				originalFilename: "new.png",
				sizeBytes: 3,
			});
			await replacement.promise;
			await Promise.resolve();
		});

		expect(onChange).not.toHaveBeenCalled();
		expect(
			getOwnedStagedAttachment({ appId: "app-1", entryKey, slotKey }),
		)?.toMatchObject({ attachmentId: "attachment-old" });
		expect(scheduleAttachmentCleanupMock).toHaveBeenCalledWith({
			appId: "app-1",
			attachmentId: "attachment-late",
		});
		expect(screen.getByText("old.png")).toBeDefined();
		expect(screen.getByRole("alert").textContent).toMatch(
			/existing attachment is still attached/i,
		);
	});

	it("restores a picked file and Cancel after the question really unmounts mid-upload", async () => {
		const entryKey = "entry-active-upload-remount";
		stageAttachmentMock.mockImplementation(
			({ signal }: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
		);
		const props = {
			field: FIELD,
			state: EMPTY_STATE,
			path: "/data/photo",
			appId: "app-1",
			entryKey,
			onChange: vi.fn(),
			onBlur: vi.fn(),
		} as const;
		const view = render(<AttachmentField {...props} />);
		fireEvent.change(screen.getByLabelText(/Photo.*Attach file/i), {
			target: {
				files: [new File(["png"], "field-photo.png", { type: "image/png" })],
			},
		});
		await waitFor(() => expect(stageAttachmentMock).toHaveBeenCalledTimes(1));

		view.unmount();
		render(<AttachmentField {...props} />);

		expect(
			screen.getByRole("button", { name: /Cancel attachment.*Photo/i }),
		).toBeDefined();
		expect(screen.getByRole("status").textContent).toContain("field-photo.png");
		expect(
			(screen.getByLabelText(/Photo.*Attaching/i) as HTMLInputElement).disabled,
		).toBe(true);

		fireEvent.click(
			screen.getByRole("button", { name: /Cancel attachment.*Photo/i }),
		);
		await waitFor(() =>
			expect(
				screen.queryByRole("button", {
					name: /Cancel attachment.*Photo/i,
				}),
			).toBeNull(),
		);
	});

	it("publishes a confirmed replacement to the remounted control", async () => {
		const entryKey = "entry-replacement-completes-after-remount";
		const slotKey = "photo:replacement-slot";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/photo",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/photo",
			attachment: {
				attachmentId: "attachment-old",
				attachmentName: "attachment-old.png",
				originalFilename: "old.png",
				sizeBytes: 3,
			},
		});
		const replacement = deferred<StagedAttachment>();
		stageAttachmentMock.mockReturnValue(replacement.promise);
		const onChange = vi.fn();
		const props = {
			field: FIELD,
			state: { ...EMPTY_STATE, value: "attachment-old.png" },
			path: "/data/photo",
			appId: "app-1",
			entryKey,
			attachmentSlotKey: slotKey,
			onChange,
			onBlur: vi.fn(),
		} as const;
		const first = render(<AttachmentField {...props} />);
		fireEvent.change(screen.getByLabelText(/Photo.*Replace file/i), {
			target: {
				files: [new File(["new"], "new.png", { type: "image/png" })],
			},
		});
		await waitFor(() => expect(stageAttachmentMock).toHaveBeenCalledTimes(1));

		first.unmount();
		render(<AttachmentField {...props} />);
		expect(
			screen.getByRole("button", { name: /Cancel attachment.*Photo/i }),
		).toBeDefined();

		replacement.resolve({
			attachmentId: "attachment-new",
			attachmentName: "attachment-new.png",
			originalFilename: "new.png",
			sizeBytes: 4,
		});
		await waitFor(() =>
			expect(screen.getByRole("status").textContent).toBe("new.png"),
		);
		expect(
			screen.queryByRole("button", { name: /Cancel attachment.*Photo/i }),
		).toBeNull();
		expect(onChange).toHaveBeenCalledWith("attachment-new.png");
	});

	it("returns from a failed Submit with a dormant picked-file draft and blocker intact", async () => {
		const entryKey = "entry-dormant-upload-failed-submit";
		const slotKey = "photo:conditional-slot";
		stageAttachmentMock.mockImplementation(
			({ signal }: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
		);
		const props = {
			field: FIELD,
			state: EMPTY_STATE,
			path: "/data/photo",
			appId: "app-1",
			entryKey,
			attachmentSlotKey: slotKey,
			onChange: vi.fn(),
			onBlur: vi.fn(),
		} as const;
		const view = render(<AttachmentField {...props} />);
		fireEvent.change(screen.getByLabelText(/Photo.*Attach file/i), {
			target: {
				files: [
					new File(["png"], "conditional-photo.png", { type: "image/png" }),
				],
			},
		});
		await waitFor(() => expect(stageAttachmentMock).toHaveBeenCalledTimes(1));

		// A display condition hides the real control, then Submit classifies
		// its stable slot as dormant. The server attempt fails and returns the
		// worker to the same entry before the condition shows the question again.
		view.unmount();
		await expect(
			runFormAttachmentBarrier(
				entryKey,
				async () => {
					throw new Error("submission failed");
				},
				{ classifySlot: () => "dormant" },
			),
		).rejects.toThrow("submission failed");

		render(<AttachmentField {...props} />);
		expect(screen.getByRole("status").textContent).toContain(
			"conditional-photo.png",
		);
		expect(screen.getByRole("alert").textContent).toMatch(
			/couldn't be saved|could not be saved/i,
		);
		expect(
			screen.getByRole("button", {
				name: /Retry attachment.*Photo/i,
			}),
		).toBeDefined();
		await expect(
			runFormAttachmentBarrier(entryKey, async () => undefined, {
				classifySlot: () => "active",
			}),
		).rejects.toMatchObject({
			name: "AttachmentNotReadyError",
			slotKey,
		});
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
		function Harness() {
			const [value, setValue] = useState(oldAttachmentName);
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
			expect(scheduleAttachmentCleanupMock).toHaveBeenCalledWith({
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
				slotKey: "/data/photo",
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
		expect(
			screen.queryByRole("button", {
				name: /Cancel attachment.*Photo/i,
			}),
		).toBeNull();
		expect(
			(screen.getByLabelText(/Photo.*Replace file/i) as HTMLInputElement)
				.disabled,
		).toBe(false);
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

		await __resetAttachmentCoordinatorForTests();
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

	it("fails closed when the form attachment lane is unavailable", () => {
		render(
			<AttachmentField
				field={FIELD}
				state={EMPTY_STATE}
				path="/data/photo"
				appId={undefined}
				entryKey="entry-unavailable"
				onChange={vi.fn()}
				onBlur={vi.fn()}
			/>,
		);
		expect(
			screen.getByText(/This attachment question is not ready yet/i),
		).toBeDefined();
		expect(screen.queryByLabelText(/Photo.*Attach file/i)).toBeNull();
		expect(stageAttachmentMock).not.toHaveBeenCalled();
	});

	it("finishes a confirmed replacement without waiting for a hung cleanup DELETE", async () => {
		const entryKey = "entry-hung-replacement-cleanup";
		const slotKey = "/data/photo";
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/photo",
			attachment: {
				attachmentId: "attachment-old",
				attachmentName: "attachment-old.png",
				originalFilename: "old.png",
				sizeBytes: 3,
			},
		});
		stageAttachmentMock.mockResolvedValue({
			attachmentId: "attachment-new",
			attachmentName: "attachment-new.png",
			originalFilename: "new.png",
			sizeBytes: 4,
		});
		const onChange = vi.fn();
		render(
			<AttachmentField
				field={FIELD}
				state={{ ...EMPTY_STATE, value: "attachment-old.png" }}
				path="/data/photo"
				appId="app-1"
				entryKey={entryKey}
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);

		const input = screen.getByLabelText(
			/Photo.*Replace file/i,
		) as HTMLInputElement;
		fireEvent.change(input, {
			target: {
				files: [new File(["new"], "new.png", { type: "image/png" })],
			},
		});

		await waitFor(() =>
			expect(onChange).toHaveBeenCalledWith("attachment-new.png"),
		);
		await waitFor(() => expect(input.disabled).toBe(false));
		expect(await screen.findByText("new.png")).toBeDefined();
		expect(scheduleAttachmentCleanupMock).toHaveBeenCalledWith({
			appId: "app-1",
			attachmentId: "attachment-old",
		});
	});

	it("keeps a failed repeat retarget actionable across remount and clears it with a replacement", async () => {
		const entryKey = "entry-retarget-remount";
		const slotKey = "photo:stable-row-2";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/photo",
			captureKind: "image",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/photo",
			attachment: {
				attachmentId: "attachment-old",
				attachmentName: "attachment-old.png",
				originalFilename: "old.png",
				sizeBytes: 3,
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, status: 409 }),
		);
		const onChange = vi.fn();
		const props = {
			field: FIELD,
			state: {
				...EMPTY_STATE,
				path: "/data/visits[1]/photo",
				value: "attachment-old.png",
			},
			path: "/data/visits[1]/photo",
			appId: "app-1",
			entryKey,
			attachmentSlotKey: slotKey,
			onChange,
			onBlur: vi.fn(),
		} as const;
		const view = render(<AttachmentField {...props} />);
		await act(async () => {
			await reconcileAttachmentRepeatCompaction({
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
			});
		});

		expect((await screen.findByRole("alert")).textContent).toContain(
			"This attachment could not move to the question's current location. Retry now, attach a replacement, or remove it.",
		);
		expect(
			screen.getByRole("button", { name: /retry attachment.*Photo/i }),
		).toBeDefined();
		expect(
			screen.getByRole("button", { name: /remove attachment/i }),
		).toBeDefined();

		view.unmount();
		render(<AttachmentField {...props} />);
		expect((await screen.findByRole("alert")).textContent).toMatch(
			/attach a replacement, or remove it/i,
		);

		stageAttachmentMock.mockResolvedValue({
			attachmentId: "attachment-new",
			attachmentName: "attachment-new.png",
			originalFilename: "new.png",
			sizeBytes: 4,
		});
		fireEvent.change(screen.getByLabelText(/Photo.*Replace file/i), {
			target: {
				files: [new File(["new"], "new.png", { type: "image/png" })],
			},
		});
		await waitFor(() =>
			expect(
				getOwnedStagedAttachment({ appId: "app-1", entryKey, slotKey }),
			)?.toMatchObject({ attachmentId: "attachment-new" }),
		);
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});

	it("keeps a failed picked-file diagnostic actionable across remount", async () => {
		const props = {
			field: FIELD,
			state: EMPTY_STATE,
			path: "/data/photo",
			appId: "app-1",
			entryKey: "entry-file-save-remount",
			attachmentSlotKey: "photo:stable-slot",
			onChange: vi.fn(),
			onBlur: vi.fn(),
		} as const;
		const view = render(<AttachmentField {...props} />);
		fireEvent.change(screen.getByLabelText(/Photo.*Attach file/i), {
			target: {
				files: [new File(["png"], "photo.png", { type: "image/png" })],
			},
		});

		expect((await screen.findByRole("alert")).textContent).toMatch(
			/couldn't be saved/i,
		);
		view.unmount();
		render(<AttachmentField {...props} />);

		expect((await screen.findByRole("alert")).textContent).toMatch(
			/couldn't be saved/i,
		);
		expect(
			screen.getByRole("button", { name: /retry attachment.*Photo/i })
				.textContent,
		).toMatch(/retry/i);
	});

	it("retains failed signature ink and offers Retry and Remove after remount", async () => {
		const entryKey = "entry-signature-retarget-remount";
		const slotKey = "signature:stable-row-2";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/consent",
			captureKind: "signature",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/consent",
			attachment: {
				attachmentId: "signature-old",
				attachmentName: "signature-old.png",
				originalFilename: "signature.png",
				sizeBytes: 3,
			},
		});
		rememberSignatureDraft(entryKey, slotKey, [[{ x: 0.2, y: 0.3 }]], false);
		const canvasContext = {
			setTransform: vi.fn(),
			clearRect: vi.fn(),
			beginPath: vi.fn(),
			moveTo: vi.fn(),
			lineTo: vi.fn(),
			stroke: vi.fn(),
			lineWidth: 0,
			lineCap: "round",
			lineJoin: "round",
			strokeStyle: "",
		} as unknown as CanvasRenderingContext2D;
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
			canvasContext,
		);
		let offline = true;
		vi.stubGlobal(
			"fetch",
			vi.fn((_url, init?: RequestInit) =>
				Promise.resolve({
					ok: init?.method === "PATCH" ? !offline : true,
					status: init?.method === "PATCH" && offline ? 409 : 200,
				}),
			),
		);
		const onChange = vi.fn();
		const props = {
			field: SIGNATURE_FIELD,
			state: {
				...EMPTY_STATE,
				path: "/data/visits[1]/consent",
				value: "signature-old.png",
			},
			path: "/data/visits[1]/consent",
			appId: "app-1",
			entryKey,
			attachmentSlotKey: slotKey,
			onChange,
			onBlur: vi.fn(),
		} as const;
		const view = render(<AttachmentField {...props} />);
		await act(async () => {
			await reconcileAttachmentRepeatCompaction({
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
			});
		});
		expect((await screen.findByRole("alert")).textContent).toContain(
			"This signature could not move to the question's current location. Retry now, draw it again, or use Clear signature.",
		);
		expect(canvasContext.stroke).toHaveBeenCalled();

		view.unmount();
		render(<AttachmentField {...props} />);
		expect((await screen.findByRole("alert")).textContent).toMatch(
			/retry now, draw it again, or use clear signature/i,
		);
		expect(
			(
				screen.getByRole("button", {
					name: /clear signature.*Signed consent/i,
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
		expect(
			screen.getAllByRole("button", {
				name: /(?:remove|clear) signature.*Signed consent/i,
			}),
		).toHaveLength(1);

		offline = false;
		fireEvent.click(
			screen.getByRole("button", {
				name: /retry signature.*Signed consent/i,
			}),
		);
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});

	it("cancels an active signature upload and commits one clear transition", async () => {
		vi.useFakeTimers();
		const canvasContext = {
			setTransform: vi.fn(),
			clearRect: vi.fn(),
			beginPath: vi.fn(),
			moveTo: vi.fn(),
			lineTo: vi.fn(),
			stroke: vi.fn(),
			lineWidth: 0,
			lineCap: "round",
			lineJoin: "round",
			strokeStyle: "",
		} as unknown as CanvasRenderingContext2D;
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
			canvasContext,
		);
		vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
			(callback) => callback(new Blob(["ink"], { type: "image/png" })),
		);
		stageAttachmentMock.mockImplementation(
			({ signal }: { signal: AbortSignal }) =>
				new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
		);
		const onChange = vi.fn();
		render(
			<AttachmentField
				field={SIGNATURE_FIELD}
				state={{ ...EMPTY_STATE, path: "/data/consent" }}
				path="/data/consent"
				appId="app-1"
				entryKey="entry-active-signature-clear"
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);
		const canvas = screen.getByLabelText(/Signature pad/i);
		Object.assign(canvas, {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
		});
		fireEvent.pointerDown(canvas, {
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		});
		fireEvent.pointerUp(canvas, {
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(700);
		});
		expect(stageAttachmentMock).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: /clear signature/i }));
		await act(async () => {
			for (let index = 0; index < 5; index++) await Promise.resolve();
		});
		expect(onChange).toHaveBeenCalledWith("");
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("lets signature Clear supersede a queued retarget instead of becoming a no-op", async () => {
		const entryKey = "entry-signature-clear-retarget";
		const slotKey = "signature:stable-row";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[0]/consent",
			captureKind: "signature",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/consent",
			attachment: {
				attachmentId: "signature-retargeting",
				attachmentName: "signature-retargeting.png",
				originalFilename: "signature.png",
				sizeBytes: 3,
			},
		});
		setAttachmentSlotIssue({
			appId: "app-1",
			entryKey,
			slotKey,
			issue: {
				kind: "retarget",
				message:
					"This signature could not move to the question's current location. Retry now, draw it again, or use Clear signature.",
			},
		});
		const fetchMock = vi.fn(
			(_url, init?: RequestInit) =>
				new Promise<never>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{ once: true },
					);
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const onChange = vi.fn();
		render(
			<AttachmentField
				field={SIGNATURE_FIELD}
				state={{
					...EMPTY_STATE,
					path: "/data/visits[0]/consent",
					value: "signature-retargeting.png",
				}}
				path="/data/visits[0]/consent"
				appId="app-1"
				entryKey={entryKey}
				attachmentSlotKey={slotKey}
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: /retry signature.*Signed consent/i,
			}),
		);
		await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		const clear = screen.getByRole("button", {
			name: /clear signature.*Signed consent/i,
		}) as HTMLButtonElement;
		expect(clear.disabled).toBe(false);
		fireEvent.click(clear);

		await waitFor(() => expect(onChange).toHaveBeenCalledWith(""));
	});

	it("persists a failed signature save with retained ink and retries it after remount", async () => {
		vi.useFakeTimers();
		const canvasContext = {
			setTransform: vi.fn(),
			clearRect: vi.fn(),
			beginPath: vi.fn(),
			moveTo: vi.fn(),
			lineTo: vi.fn(),
			stroke: vi.fn(),
			lineWidth: 0,
			lineCap: "round",
			lineJoin: "round",
			strokeStyle: "",
		} as unknown as CanvasRenderingContext2D;
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
			canvasContext,
		);
		let encodedBlob: Blob | null = null;
		vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
			(callback) => callback(encodedBlob),
		);
		stageAttachmentMock.mockResolvedValue({
			attachmentId: "signature-retry",
			attachmentName: "signature-retry.png",
			originalFilename: "signature.png",
			sizeBytes: 3,
		});
		const onChange = vi.fn();
		const props = {
			field: SIGNATURE_FIELD,
			state: { ...EMPTY_STATE, path: "/data/consent" },
			path: "/data/consent",
			appId: "app-1",
			entryKey: "entry-signature-save-remount",
			onChange,
			onBlur: vi.fn(),
		} as const;
		const view = render(<AttachmentField {...props} />);
		const canvas = screen.getByLabelText(/Signature pad/i);
		Object.assign(canvas, {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
		});
		fireEvent.pointerDown(canvas, {
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		});
		fireEvent.pointerUp(canvas, {
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(700);
		});
		expect(screen.getByRole("alert").textContent).toContain(
			"This signature could not be saved. Retry now or use Clear signature.",
		);

		view.unmount();
		await act(async () => {
			render(<AttachmentField {...props} />);
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(screen.getByRole("alert").textContent).toMatch(
			/retry now or use clear signature/i,
		);
		expect(canvasContext.stroke).toHaveBeenCalled();

		encodedBlob = new Blob(["ink"], { type: "image/png" });
		fireEvent.click(
			screen.getByRole("button", {
				name: /retry signature.*Signed consent/i,
			}),
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
			for (let index = 0; index < 5; index++) await Promise.resolve();
		});
		expect(onChange).toHaveBeenCalledWith("signature-retry.png");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("wraps narrow attachment actions and breaks a 255-character filename", async () => {
		const longFilename = `${"a".repeat(251)}.png`;
		stageAttachmentMock.mockResolvedValue({
			attachmentId: "attachment-long-name",
			attachmentName: "attachment-long-name.png",
			originalFilename: longFilename,
			sizeBytes: 3,
		});
		const onChange = vi.fn();
		const view = render(
			<AttachmentField
				field={FIELD}
				state={EMPTY_STATE}
				path="/data/photo"
				appId="app-1"
				entryKey="entry-long-filename"
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);
		const input = screen.getByLabelText(/Photo.*Attach file/i);
		fireEvent.change(input, {
			target: {
				files: [new File(["png"], longFilename, { type: "image/png" })],
			},
		});
		await waitFor(() => expect(onChange).toHaveBeenCalled());
		view.rerender(
			<AttachmentField
				field={FIELD}
				state={{ ...EMPTY_STATE, value: "attachment-long-name.png" }}
				path="/data/photo"
				appId="app-1"
				entryKey="entry-long-filename"
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);
		const status = await screen.findByRole("status");
		expect(status.textContent).toBe(longFilename);
		expect(status.className).toContain("[overflow-wrap:anywhere]");
		expect(input.closest("div")?.className).toContain("flex-wrap");
	});
});
