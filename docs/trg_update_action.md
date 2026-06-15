# Triggeryze — Update Action: Change Scope

*Design and migration plan for replacing `lbWrite` with a unified `update` action.*

---

## What is changing

- `lbWrite` action type is replaced by a new `update` action with a **target** toggle (lorebook / text).
- `call LLM` gets one label fix: "silent (discard)" → "silent". No structural changes.
- A per-rule clobbering warning is added to the rule card UI.

## What is NOT changing

Everything else. `call LLM`, `compose`, `replace`, `stop`, `stopContinue`, `slashCmd` — no changes. All trigger types — no changes. Variable system — no changes.

---

## The `update` action

Replaces `lbWrite`. A target toggle determines which fields are shown and what the action writes to.

### Target: lorebook

Fields: lorebook name, entry title, keys (comma-separated), content.

Behaviour: identical to current `lbWrite`. Creates the entry if the title does not exist; updates content and merges keys if it does. All fields support `{{variable}}` interpolation.

### Target: text

Fields: mode, value.

| Mode | What it writes |
|---|---|
| replace keyword | Replaces all instances of the matched trigger keyword in the message with value |
| replace paragraph | Replaces the paragraph containing the keyword with value |
| append to message | Appends value to the end of the message |
| insert as message | Inserts value as a new message after the current one |

Value is a template string — supports `{{varName}}`, `{{keyword}}`, `{{highlighted}}`, `{{message}}`, and all other system variables. When a badge fires with text selected, `{{highlighted}}` carries that text and can be used in value just like any other variable.

---

## Clobbering warning

When two actions in the same rule write to the same target within the same stage, a notice appears at the bottom of the rule card:

> Two actions in this rule may write to the same location (replace keyword). The last to run wins. This may be intentional.

Conditions that trigger the warning:
- `call LLM` has a non-silent output mode **and** an `update` (text) action has the same mode — both in the same stage.
- Two `update` actions target the same mode or the same lorebook entry title — both in the same stage.

Warning is informational only. No action is blocked or reordered.

---

## Breaking change: `lbWrite` → `update`

Existing rules using `lbWrite` will stop working. The action type key changes; migration must run on settings load.

### Migration — automatic, lossless

On settings load, scan all rule actions for `type: 'lbWrite'`. Convert each:

```json
// Before
{
  "type": "lbWrite",
  "config": { "lorebook": "World", "title": "Elara", "keys": "elara", "content": "...", "outputVar": "" }
}

// After
{
  "type": "update",
  "config": { "target": "lorebook", "lorebook": "World", "title": "Elara", "keys": "elara", "content": "...", "outputVar": "" }
}
```

Only `type` changes and `target: "lorebook"` is added. All config fields carry over unchanged. Save the migrated settings immediately so the conversion is permanent.

Log on completion:

```
[triggeryze] migrated N lbWrite action(s) to update
```

---

## New capabilities unlocked

- **Compose → text**: `compose` a variable from a template, then feed it to an `update` (text) action. Text replacement without an LLM call — not currently possible without a slash command workaround.
- **One call, two targets**: `call LLM` → `{{result}}` → `update` (lorebook) and `update` (text append) in the same rule chain. Currently requires two separate LLM dispatches.

---

## Gaps doc updates

- **A1 (call LLM doing too much)**: partially closed. Lorebook output moves out of `call LLM` entirely. Text output remains in `call LLM` as a convenience shortcut, acknowledged as intentional overlap with `update` (text). Clobbering warning is the guardrail.
- **B1 (lorebook action coverage)**: `update` covers create and update. Delete, list, and create-new-lorebook remain unimplemented — this change does not address them.
