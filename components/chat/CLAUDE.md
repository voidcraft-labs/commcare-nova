# Chat Components

## ChatSidebar

Message list + input. Accepts `mode: 'centered' | 'sidebar' | 'sidebar-embedded'`, optional `readOnly` (hides input, for log replay).

- **Centered mode**: Below hero Logo, no header/border, uniform `gap-6` spacing. Uses `layout` + `layoutId="chat-panel"` for animated transition to sidebar.
- **Sidebar mode**: 320px (`w-80`) standalone overlay with own header. Used for standalone left-panel rendering outside of LeftPanel.
- **Sidebar-embedded mode**: Just messages + input, no outer chrome (header/border/shadow). Used inside `LeftPanel`'s Chat tab — the parent provides the shell.

After generation, chat lives inside LeftPanel's Chat tab (embedded mode). Auto-hides in preview mode when LeftPanel collapses. Reads `builder.phase` to suppress thinking indicator when builder is active. Auto-scroll to bottom via MutationObserver ref callback on the messages container.

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
