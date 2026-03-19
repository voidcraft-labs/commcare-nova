# Chat Components

## ChatSidebar

Message list + input. Accepts `mode: 'centered' | 'sidebar'`, optional `readOnly` (hides input, for log replay).

- **Centered mode**: Below hero Logo, no header/border, uniform `gap-6` spacing. Uses `layout` + `layoutId="chat-panel"` for animated transition to sidebar.
- **Sidebar mode**: 320px (`w-80`) absolutely positioned overlay on the left (`z-20`). Slides in/out via `translateX` animation (`x: -320 → 0`). Styled as a pullout: `rounded-r-xl m-2 ml-0 border border-nova-border-bright border-l-0 shadow-[0_2px_12px_rgba(0,0,0,0.4)]` — mirroring DetailPanel on the opposite side. Header shows collapse chevron (left) + "Chat" label (right, `text-sm`). Collapse always visible including replay mode.

Auto-hides in preview mode (derived `chatOpen = viewMode === 'preview' ? false : chatUserPref`). Restores user preference when switching back to tree/design. Reads `builder.phase` to suppress thinking indicator when builder is active. Auto-scroll to bottom via MutationObserver ref callback on the messages container.

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
