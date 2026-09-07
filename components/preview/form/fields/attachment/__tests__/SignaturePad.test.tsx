// @vitest-environment happy-dom

import { act, cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetAttachmentCoordinatorForTests,
	type AttachmentEntryAuthoritySnapshot,
	hasAttachmentEntryWriteAuthority,
	rememberSignatureDraft,
	runFormAttachmentBarrier,
	setAttachmentEntryAuthority,
} from "../attachmentClient";
import { SignaturePad as ProductionSignaturePad } from "../SignaturePad";

const TEST_AUTHORITY_COORDINATES = {
	formUuid: "22222222-2222-4222-8222-222222222222",
	projectId: "project-attachment-test",
	actorUserId: "actor-attachment-test",
	ownerId: "actor-attachment-test",
} as const;

function installDefaultAuthority(entryKey: string): void {
	if (hasAttachmentEntryWriteAuthority(entryKey)) return;
	const snapshot: AttachmentEntryAuthoritySnapshot = {
		appId: "app-1",
		entryKey,
		...TEST_AUTHORITY_COORDINATES,
		scopeEpoch: 1,
		accessPhase: "authorized",
		canEdit: true,
	};
	setAttachmentEntryAuthority({
		entryKey,
		snapshot,
		readCurrent: () => snapshot,
	});
}

type TestSignaturePadProps = Omit<
	ComponentProps<typeof ProductionSignaturePad>,
	"slotKey" | "hasWriteAuthority"
> &
	Partial<
		Pick<
			ComponentProps<typeof ProductionSignaturePad>,
			"slotKey" | "hasWriteAuthority"
		>
	>;

function SignaturePad({
	slotKey,
	hasWriteAuthority,
	...props
}: TestSignaturePadProps) {
	if (hasWriteAuthority === undefined) installDefaultAuthority(props.entryKey);
	return (
		<ProductionSignaturePad
			{...props}
			slotKey={slotKey ?? props.instancePath}
			hasWriteAuthority={
				hasWriteAuthority ??
				(() => hasAttachmentEntryWriteAuthority(props.entryKey))
			}
		/>
	);
}

const context = {
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

// Canvas encoding is an explicit controllable boundary here. Native pointer,
// bitmap and PNG-byte evidence lives in preview-attachments-audit.spec.ts.
let blobCallbacks: BlobCallback[] = [];
const pendingEncodings = new Set<BlobCallback>();

beforeEach(() => {
	blobCallbacks = [];
	vi.useFakeTimers();
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
	vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
		(callback) => {
			const complete: BlobCallback = (blob) => {
				pendingEncodings.delete(complete);
				callback(blob);
			};
			pendingEncodings.add(complete);
			blobCallbacks.push(complete);
		},
	);
});
afterEach(async () => {
	await act(async () => {
		cleanup();
		await __resetAttachmentCoordinatorForTests();
		for (const complete of pendingEncodings) complete(null);
	});
	expect(vi.getTimerCount()).toBe(0);
	vi.useRealTimers();
	vi.restoreAllMocks();
});
const SLOT = "/data/signature";
function seed(entryKey: string) {
	installDefaultAuthority(entryKey);
	rememberSignatureDraft(entryKey, SLOT, [
		[
			{ x: 0.2, y: 0.3 },
			{ x: 0.7, y: 0.8 },
		],
	]);
}
async function advanceEncoding() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(800);
	});
	expect(blobCallbacks.length).toBeGreaterThan(0);
}
function props(entryKey: string) {
	return {
		entryKey,
		instancePath: SLOT,
		uploading: false,
		hasAnswer: false,
		onDrawn: vi.fn().mockResolvedValue("committed" as const),
		onClear: vi.fn().mockResolvedValue("committed" as const),
	};
}
describe("SignaturePad encoding lifetime adapter", () => {
	it("discards a held encoder callback after its entry prop changes", async () => {
		seed("entry-a");
		const first = props("entry-a");
		const view = render(<SignaturePad {...first} />);
		await advanceEncoding();
		const encode = blobCallbacks[0];
		const second = props("entry-b");
		view.rerender(<SignaturePad {...second} />);
		await act(async () => {
			encode(new Blob(["old PNG"], { type: "image/png" }));
		});
		expect(first.onDrawn).not.toHaveBeenCalled();
		expect(second.onDrawn).not.toHaveBeenCalled();
	});
	it("restarts retained dirty ink after remount and ignores the abandoned encoder", async () => {
		seed("entry-remount");
		const first = props("entry-remount");
		const view = render(<SignaturePad {...first} />);
		await advanceEncoding();
		const abandoned = blobCallbacks[0];
		view.unmount();
		const next = props("entry-remount");
		render(<SignaturePad {...next} />);
		await advanceEncoding();
		const resumed = blobCallbacks.at(-1);
		expect(resumed).not.toBe(abandoned);
		await act(async () => {
			abandoned(new Blob(["old PNG"], { type: "image/png" }));
			resumed?.(new Blob(["new PNG"], { type: "image/png" }));
		});
		expect(first.onDrawn).not.toHaveBeenCalled();
		expect(next.onDrawn).toHaveBeenCalledTimes(1);
		await expect(
			runFormAttachmentBarrier("entry-remount", async () => "ready"),
		).resolves.toBe("ready");
	});
	it("keeps submission blocked when the native encoder cannot produce a blob", async () => {
		seed("entry-null");
		const onEncodingError = vi.fn();
		render(
			<SignaturePad
				{...props("entry-null")}
				onEncodingError={onEncodingError}
			/>,
		);
		await advanceEncoding();
		await act(async () => {
			blobCallbacks[0](null);
		});
		expect(onEncodingError).toHaveBeenCalledWith(
			expect.stringMatching(/couldn't be saved/i),
		);
		await expect(
			runFormAttachmentBarrier("entry-null", async () => "submitted"),
		).rejects.toThrow(/signature/i);
	});
});
