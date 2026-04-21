# Phase I — Marketplace

**Goal:** A Nova-owned Claude Code marketplace that points at the plugin repo, so users can install with `/plugin marketplace add dimagi/nova-marketplace` followed by `/plugin install nova@nova-marketplace`.

**Dependencies:** Phase H — plugin must be published to GitHub first.

**Where this work lives:** Separate repo at `github.com/dimagi/nova-marketplace`.

---

## Task I1: Marketplace repo

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `README.md`
- Create: `.gitignore`

- [ ] **Step 1: Create the repo**

```bash
mkdir -p ~/work/personal/code/nova-marketplace
cd ~/work/personal/code/nova-marketplace
git init
```

- [ ] **Step 2: Write `.claude-plugin/marketplace.json`**

```json
{
  "name": "nova-marketplace",
  "description": "Dimagi's marketplace for Nova-related Claude Code plugins",
  "owner": {
    "name": "Dimagi",
    "homepage": "https://docs.commcare.app"
  },
  "plugins": [
    {
      "name": "nova",
      "source": {
        "type": "github",
        "repo": "dimagi/nova-plugin",
        "branch": "main"
      }
    }
  ]
}
```

- [ ] **Step 3: Write `README.md`**

```markdown
# Nova marketplace

Add this marketplace to Claude Code:

    /plugin marketplace add dimagi/nova-marketplace

Then install plugins from it:

    /plugin install nova@nova-marketplace
```

- [ ] **Step 4: Write `.gitignore`**

```
.DS_Store
```

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "chore: initial marketplace with nova plugin"
```

---

## Task I2: Publish both repos to GitHub

- [ ] **Step 1: Push plugin repo**

```bash
cd ~/work/personal/code/nova-plugin
gh repo create dimagi/nova-plugin --public --source=. --push
```

- [ ] **Step 2: Push marketplace repo**

```bash
cd ~/work/personal/code/nova-marketplace
gh repo create dimagi/nova-marketplace --public --source=. --push
```

- [ ] **Step 3: End-to-end install from published marketplace**

In a fresh Claude Code session:

```
/plugin marketplace add dimagi/nova-marketplace
/plugin install nova@nova-marketplace
/nova:list
```

Expected: full flow works from the published marketplace. Auth prompts (first run), lists apps.

- [ ] **Step 4: Record in main repo infra notes**

```bash
cd ~/work/personal/code/commcare-nova/.worktrees/feature-mcp
```

Append to `docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md`:

```markdown
## Marketplace published (YYYY-MM-DD)

- Plugin repo: https://github.com/dimagi/nova-plugin
- Marketplace repo: https://github.com/dimagi/nova-marketplace
- Install: /plugin marketplace add dimagi/nova-marketplace && /plugin install nova@nova-marketplace
```

Commit:

```bash
git add docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md
git commit -m "docs(mcp): record marketplace publication"
```
