// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import type {
	ButtonHTMLAttributes,
	FormHTMLAttributes,
	ReactElement,
	ReactNode,
	TextareaHTMLAttributes,
} from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput } from "@/components/chat/ChatInput";

const builder = vi.hoisted(() => ({ ready: false }));

vi.mock("@/lib/session/hooks", () => ({
	useAppId: () => null,
	useBuilderIsReady: () => builder.ready,
}));

vi.mock("@/lib/credits/useCreditBalance", () => ({
	useCreditBalance: () => ({ summary: null }),
}));

vi.mock("@/components/ai-elements/prompt-input", () => ({
	PromptInput: ({
		children,
		...props
	}: FormHTMLAttributes<HTMLFormElement>) => <form {...props}>{children}</form>,
	PromptInputBody: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	PromptInputFooter: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	PromptInputSubmit: ({
		status: _status,
		...props
	}: ButtonHTMLAttributes<HTMLButtonElement> & { status?: string }) => (
		<button type="submit" {...props}>
			Send
		</button>
	),
	PromptInputTextarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
		<textarea {...props} />
	),
	PromptInputTools: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
}));

vi.mock("@/components/builder/media/AssetPreviewDialog", () => ({
	AssetPreviewDialog: () => null,
}));

vi.mock("@/components/builder/media/MediaPickerDialog", () => ({
	MediaPickerDialog: () => null,
}));

vi.mock("@/components/chat/ChatAttachmentBar", () => ({
	ChatAttachmentBar: () => null,
}));

vi.mock("@/components/ui/CreditAmount", () => ({
	CreditAmount: ({ value }: { value: number }) => <span>{value} credits</span>,
}));

vi.mock("@/components/shadcn/tooltip", () => ({
	Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
	TooltipContent: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	TooltipTrigger: ({
		render,
		children,
	}: {
		render?: ReactElement;
		children?: ReactNode;
	}) => render ?? children,
}));

describe("ChatInput", () => {
	beforeEach(() => {
		builder.ready = false;
	});

	it("uses real, action-oriented placeholders without decorative ellipses", () => {
		const { rerender } = render(<ChatInput openingPrompt onSend={vi.fn()} />);
		expect(
			screen.getByPlaceholderText("Describe the app you want to build"),
		).toBeDefined();

		rerender(<ChatInput openingPrompt={false} onSend={vi.fn()} />);
		expect(screen.getByPlaceholderText("Describe a change")).toBeDefined();
		expect(document.querySelector('textarea[placeholder*="..."]')).toBeNull();
	});

	it("uses a full-size shadcn attachment action", () => {
		render(<ChatInput onSend={vi.fn()} />);
		const attach = screen.getByRole("button", { name: "Attach a file" });
		expect(attach.getAttribute("data-slot")).toBe("button");
		expect(attach.className).toContain("size-11");
	});

	it("separates edit cost and clarification guidance into scannable sentences", () => {
		builder.ready = true;
		render(<ChatInput onSend={vi.fn()} />);
		expect(
			screen.getByText(
				/Edits use \d+ credits\. Clarifying questions are free\./,
			),
		).toBeDefined();
	});
});
