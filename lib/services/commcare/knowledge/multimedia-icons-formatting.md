# Multimedia, Icons & Text Formatting

## Static Multimedia in Forms

### Supported Media by Platform

| Type | Android | Feature Phones |
|------|---------|----------------|
| Images | Yes | Yes |
| Audio | Yes | Yes |
| Video (mp4) | Yes | No |
| Video (3gp) | Yes | Yes |
| Documents | Yes (2.57+) | No |

### Image Sizing (Android, Forms Only)

Three auto-resize modes (configured at app level):
- **Full Resize** — fills all available screen space
- **Horizontal Resize** — fills horizontal space, maintains aspect ratio
- **Half Resize** — half of Full Resize dimensions

**Constraint**: Auto-Resize and Image Compatibility for Multiple Device Models are mutually exclusive. Enabling both produces unpredictable behavior. Pick one.

### Audio Design Guidance
- Add 0.5–1 sec silence at start of each clip (prevents accidental replay-pause)
- Amplify +10 dB for field use; allow clipping — field workers can reduce volume but cannot increase it
- Audio prompts should be directed at the mobile worker, not the beneficiary: "How many children does the client have?" not "How many children do you have?"

### Video Guidance
- MP4 preferred on Android; 3GP for broader compatibility
- Keep duration to 2–5 minutes maximum; longer videos reduce navigation flexibility
- CommCare auto-resizes videos exceeding screen dimensions

---

## Media Capture Questions

### Question Types

| Type | Notes |
|------|-------|
| Image | Camera + file picker by default |
| Audio | Built-in widget (CommCare 2.50+) |
| Video | Record + file picker; includes playback review |
| Document | File picker (CommCare 2.57+); non-image/audio/video files |

### Appearance: Acquire Only

Setting `appearance="acquire"` on any media capture question removes the file picker, requiring live capture only. Use when data integrity requires in-person capture.

### Image Capture Size Settings

| Setting | Resolution |
|---------|-----------|
| Small | 0.1 megapixels |
| Medium | 0.2 megapixels |
| Large | 0.5 megapixels |

**Critical**: Images >1 MB cause slow sync and submission failures in low-connectivity environments. Always enforce size limits. VGA resolution works well.

### Audio Capture Constraints
- Android grants exclusive audio focus to one app at a time — background apps or Bluetooth devices can interrupt recording
- For recordings >15–20 minutes: use third-party recording app + file upload workflow
  - Set `appearance="legacy"` on audio question to use external recording app
- Enable Airplane Mode for extended recordings if third-party workflow unavailable

### Web Apps Constraint
Limit to **8 multimedia questions per form** in Web Apps. Exceeding this causes slow submission processing.

---

## Icons

### Module/Form List Icons
Icons appear on module and form tiles in home screen navigation.

**Best practices**:
- Single, clear concept per icon
- Consistent style, color weight, line weight across the icon set
- High contrast between icon and background
- Sources: The Noun Project (prefer public domain), Font Awesome, Flaticon, Material.io

### Icons in Case List / Case Detail

Requires **"Icons in Case List"** feature preview to be enabled.

Add a property column to the case list, set format to Icon, then configure conditions.

#### Calculation Field Syntax

- **`.`** (period) — references the current property value being configured for this column
- **`#case/property_name`** — references other case properties

```xpath
# Simple: show icon when value equals "yes"
. = "yes"

# Date-based priority triage:
. < today()          → Red icon (overdue)
. <= (today() + 2)   → Yellow icon (due soon)
. > (today() - 2)    → Green icon (on track)
```

**Order matters**: Conditions are evaluated top-to-bottom; **first match wins**. Arrange from most specific to least specific.

#### Set Path Field
Each condition row maps to a media asset path. Reference an existing app media asset by its path string.

---

## Custom Icon Badges

**Availability**: Advanced plans and above.

Displays a count or label on module or form tiles on the home screen, visible before the user opens them.

### Badge Content Options

- **Static text** — max 3 characters displayed; truncated beyond that
- **XPath expression** — dynamic calculated value

```xpath
# Count open cases of a specific type
count(instance('casedb')/casedb/case[@case_type="TYPE"])

# Values >999 display as "999+"
```

**Constraint**: Keep badge expressions lightweight. Complex XPath in badges impacts app performance at home screen load.

---

## Text Formatting (Markdown)

Supported in **form labels** and **case detail screens** on Android (CommCare 2.20+) and Web Apps.

### Supported Syntax

| Syntax | Result |
|--------|--------|
| `*text*` | *italics* |
| `**text**` | **bold** |
| `***text***` | ***bold italics*** |
| `~~text~~` | ~~strikethrough~~ |
| `[link text](http://example.com)` | Clickable link (must include `http://` or `https://`) |
| `[+1-800-888-8888](tel:+1-800-888-8888)` | Clickable phone number |
| `# Header 1` through `###### Header 6` | Headers |
| `1. Item` | Ordered list |
| `* Item` | Unordered list |
| `\| Col1 \| Col2 \|` | Tables (CommCare 2.50+) |

### Constraints
- **Not supported** in hint text fields
- CommCare versions <2.20 render raw markup symbols
- Doubly nested lists not supported
- Tables require CommCare 2.50+
- Formatting can be disabled per-question or per-form to display literal markup characters

---

## Accessibility and Low-Literacy Design

### Multimedia Substitution Patterns

| Challenge | Blueprint Solution |
|-----------|-------------------|
| Text labels unreadable | Add audio prompts for every question label |
| Navigation confusion | Add icons to all modules and forms |
| Long case lists hard to scan | Add icon columns with status indicators |
| Text questions impossible for user | Replace with select-one, numeric, or image capture questions |
| Multi-answer questions confusing | Break into sequential yes/no questions |

### Audio Prompt Framing
Record prompts directed at the **mobile worker** (not beneficiary) for data collection contexts. Workers can use headphones to hear prompts privately during interviews.

### App Simplification
- Disable "Saved Forms" and "Incomplete Forms" menu entries to reduce cognitive load on the home screen
- Keep case lists short; use numeric identifiers rather than names when users are numerate but not literate
- Case tiles (alternative case list display) provide more visual layout control than standard case list rows

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Image >1 MB in capture questions | Enforce Small/Medium size setting |
| No amplification on audio files | Apply +10 dB with clipping allowed |
| Auto-Resize + Multi-Device Compatibility both enabled | Mutually exclusive; pick one |
| `acquire` appearance omitted when live capture required | Set `appearance="acquire"` explicitly |
| Icon badge with complex XPath | Use only lightweight expressions like `count()` |
| >8 multimedia questions in Web App form | Split across forms or reduce media questions |
| Using `.` wrong in case list icon calc | `.` = current configured property; `#case/prop` = other properties |
| Recording audio >15 min in built-in widget | Use `appearance="legacy"` for external app; or Airplane Mode |
| Icon badge text >3 characters | Design badge content ≤3 characters; longer is silently truncated |
| Badge value >999 | Displays as "999+" — design around this |
| Tables in markdown on CommCare <2.50 | Raw markup displayed; tables require 2.50+ |