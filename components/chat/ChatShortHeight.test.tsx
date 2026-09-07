import { describe, expect, it } from "vitest";
import {
	chatComposerIsDisabled,
	shouldShowShortChatFallback,
} from "@/components/chat/chatComposer";

describe("short-height chat", () => {
	it("uses the fallback only for an expanded standalone chat", () => {
		expect(
			shouldShowShortChatFallback({
				centered: false,
				docked: false,
				veryShortViewport: true,
			}),
		).toBe(true);
		expect(
			shouldShowShortChatFallback({
				centered: true,
				docked: false,
				veryShortViewport: true,
			}),
		).toBe(false);
		expect(
			shouldShowShortChatFallback({
				centered: false,
				docked: true,
				veryShortViewport: true,
			}),
		).toBe(false);
		expect(
			shouldShowShortChatFallback({
				centered: false,
				docked: false,
				veryShortViewport: false,
			}),
		).toBe(false);
	});
});

describe("composer activity state", () => {
	it("keeps a stopped accepted build locked except for a persisted question or typed-input pause", () => {
		const base = {
			isLoading: false,
			isGenerating: false,
			initialBuildLocked: true,
			awaitingTypedInput: false,
			activeQuestionCount: 0,
			composerBusy: false,
			readOnly: false,
			authorized: true,
		};
		expect(chatComposerIsDisabled(base)).toBe(true);
		expect(chatComposerIsDisabled({ ...base, activeQuestionCount: 1 })).toBe(
			false,
		);
		expect(chatComposerIsDisabled({ ...base, awaitingTypedInput: true })).toBe(
			false,
		);
		expect(chatComposerIsDisabled({ ...base, initialBuildLocked: false })).toBe(
			false,
		);
	});
});
