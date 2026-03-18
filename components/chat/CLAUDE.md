# Chat Components

## ChatSidebar

Message list + input. Accepts `mode: 'centered' | 'sidebar'`, optional `readOnly` (hides input, for log replay).

- **Centered mode**: Below hero Logo, no header/border, uniform `gap-6` spacing.
- **Sidebar mode**: 380px docked panel, `p-4` messages, `border-t` input.

Uses `layout` + `layoutId` for animated transition between modes. Reads `builder.phase` to suppress thinking indicator when builder is active. Auto-scroll to bottom via MutationObserver ref callback on the messages container.

## ChatMessage

Iterates `message.parts`:
- `text` parts → text bubbles (assistant: `renderMarkdown()`, user: plain `whitespace-pre-wrap`)
- `tool-askQuestions` parts → `QuestionCard`
- All other tool/data parts → ignored (handled by `onData` in BuilderLayout)

## QuestionCard

Animated stepper with local state. Shows questions one at a time with option buttons. Answered questions display as checkmark + answer. Calls `addToolOutput` when all answered.

**`pendingAnswerRef`** — when user types while a question is waiting, ChatSidebar routes through this ref instead of sending a chat message. Typed answers prefixed with `"User Responded: "` so the SA knows it's free-form text.

## ThinkingIndicator

Orbital violet dot animation. Shown when `status === 'submitted'|'streaming'` AND `builder.phase === Idle` AND scaffold is not in-flight.
