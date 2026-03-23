# Chat Components

## ChatSidebar

Message list + input. Accepts `mode: 'centered' | 'sidebar' | 'sidebar-embedded'`, optional `readOnly` (hides input, for log replay).

- **Centered mode**: Below hero Logo, no header/border, uniform `gap-6` spacing. Uses `layout` + `layoutId="chat-panel"` for animated transition to sidebar.
- **Sidebar mode**: 320px (`w-80`) standalone overlay with own header. Used for standalone left-panel rendering outside of LeftPanel.
- **Sidebar-embedded mode**: Just messages + input, no outer chrome (header/border/shadow). Used inside `LeftPanel`'s Chat tab — the parent provides the shell.

After generation, chat lives inside LeftPanel's Chat tab (embedded mode). Auto-hides in preview mode when LeftPanel collapses. Reads `builder.phase` to suppress thinking indicator when builder is active.

**Scroll management** — Smart auto-scroll via `scrollRef` callback:
- **Near-bottom tracking**: Only auto-scrolls on new content (MutationObserver + ResizeObserver) when user was within 50px of bottom. Scrolling up "detaches" from auto-follow.
- **User hold detection**: `mousedown` on scroll container suppresses all auto-scroll; `mouseup` re-enables.
- **Cross-instance persistence**: Module-level `chatScrollPinned` + `chatScrollTop` survive center→sidebar transitions and panel close/reopen.
- **Animation-aware pinning**: 600ms rAF loop on mount keeps pinning to bottom during layout animation, catching post-reflow height changes.
- **Question card auto-scroll**: Detects new `input-available` askQuestions parts and `scrollIntoView({ block: 'nearest' })` unless user is holding scrollbar.

## ChatMessage

Iterates `message.parts`:
- `text` parts → text bubbles (assistant: `renderMarkdown()`, user: plain `whitespace-pre-wrap`)
- `tool-askQuestions` parts → `QuestionCard`
- All other tool/data parts → ignored (handled by `onData` in BuilderLayout)

## QuestionCard

Animated stepper with local state. Shows questions one at a time with option buttons. Answered questions display as checkmark + answer. Calls `addToolOutput` when all answered. Outer div carries `data-question-card` attribute (`'waiting'` | `'done'` | `'loading'`) for scroll targeting by ChatSidebar.

**`pendingAnswerRef`** — when user types while a question is waiting, ChatSidebar routes through this ref instead of sending a chat message. Typed answers prefixed with `"User Responded: "` so the SA knows it's free-form text.

## ThinkingIndicator

Orbital violet dot animation. Shown when `status === 'submitted'|'streaming'` AND `builder.phase === Idle` AND scaffold is not in-flight.
