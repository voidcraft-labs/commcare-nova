# Chat Components

## ChatSidebar

Message list + input. Accepts `mode: 'centered' | 'sidebar' | 'sidebar-embedded'`, optional `readOnly` (hides input, for log replay).

- **Centered mode**: Below hero Logo, no header/border, uniform `gap-6` spacing. Uses `layout` + `layoutId="chat-panel"` for animated transition to sidebar.
- **Sidebar mode**: 320px (`w-80`) standalone overlay with own header. Used for standalone left-panel rendering outside of LeftPanel.
- **Sidebar-embedded mode**: Just messages + input, no outer chrome (header/border/shadow). Used inside `LeftPanel`'s Chat tab — the parent provides the shell.

After generation, chat lives inside LeftPanel's Chat tab (embedded mode). Auto-hides in preview mode when LeftPanel collapses.

**Layout**: scrollable messages → SignalGrid (permanent, `shrink-0`) → ChatInput (`shrink-0`). The SignalGrid panel sits between messages and input in all modes, never scrolls.

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

## SignalGrid (Nova Panel)

Permanent sci-fi neural activity panel — a recessed hardware enclosure with an LED pixel grid. Always mounted between the scroll container and the chat input (`shrink-0`), never scrolls, never hides. Cells are physical LEDs that exist even when unlit.

**Modes** — derived in ChatSidebar from builder + useChat state:
- `idle` — gentle violet twinkle clusters on a dark grid. Nova is alive but resting.
- `sending` — upward wave (bottom→top, left→right). Forced for 1s minimum via `forceSending` state in ChatSidebar so the user always sees it.
- `reasoning` — random neural firing correlated with reasoning token reception. Tracks `reasoning` + `text` part deltas on the last assistant message → `builder.injectEnergy(delta)`. Ambient firing speed scales with energy level.
- `building` — rhythmic column sweep + data-part bursts (module/form completions flash bright cyan).

**Architecture** — two-layer: `SignalGridController` (imperative class in `lib/signalGridController.ts`) owns cell state and the rAF animation loop, writes directly to DOM via `style.cssText`. `SignalGrid` (React component) creates/destroys the controller via a stable ref callback, forwards mode changes via `useEffect`, and tracks message content deltas.

**Energy pipeline** — `builder.injectEnergy(amount)` / `builder.drainEnergy()` are non-versioned (no React re-renders). Energy injected from: message content deltas (reasoning tokens), `applyDataPart()` bursts, and the intro sequence. Controller reads via `consumeEnergy()` each animation frame.

**Panel chrome** — top bezel (corner notches, groove lines, status LED), recessed display well, bottom bezel with etched label. Label shows "SYS:NEURAL" when idle, phase-specific text when active. CSS in `globals.css` under `.nova-panel*`.

**Intro sequence** — on page load, ChatSidebar's `WelcomeIntro` component temporarily sets mode to `reasoning` and injects energy bursts timed with the staggered welcome text fade-in.

**Density scaling** — all per-frame activation counts scale with `cellCount / 93` (reference: sidebar at 280px) so narrow and wide grids have the same visual density.
