# Triggeryze — Gaps

*Discrepancies between [trg_principles.md](trg_principles.md) and the current implementation. Each entry names the gap, the conflict, and what needs to happen to close it.*

---

## A. Code contradicts or exceeds a principle

These require either a code change to match the principle, or a deliberate update to the principle to acknowledge the real design.

---

### A1. sideCall conflates two responsibilities

**Principle 11:** Each action does exactly one thing.

**Code:** `sideCall` (actions.js) dispatches an LLM call *and* decides what to do with the result — five output modes in one action: replace keyword, replace paragraph, append to message, insert as message, or discard. The call and the output handling are baked into the same config form and execute function.

**Resolution:** Split into two actions. `call LLM` always stores its result to an output variable (silent by default). A new `update text` action reads a variable and applies it to the message in the user's chosen mode. This matches how `lbWrite` already works — the LLM result feeds in via a variable, and the write action owns the mutation.

---

### A2. Live-patch writes directly to the DOM

**Principle 7:** Replace never bypasses the host's rendering layer.

**Code:** `engine.js` uses a MutationObserver to stamp precomputed `innerHTML` directly into `.mes_text` during streaming. This is an intentional direct DOM write — the fastest path for streaming preview.

**Context:** The authoritative replace still uses ST's save-and-notify pipeline at postMessage stage. The live patch is visual-only and does not touch `msg.mes`. It is not wrong — but it is a deliberate exception to the principle as written.

**Resolution:** Update Principle 7 to acknowledge the exception: the streaming live-patch is a DOM-only visual preview and is not subject to the host-pipeline rule. PostMessage is always the authoritative write.

---

### A3. Verbose logging does not match the principle

**Principle 10:** When verbose is enabled, every rule evaluation produces a log entry covering what keyword was tested, whether it matched, what action was taken or skipped, and why. This must be sufficient to reconstruct the full decision path from the log alone.

**Code:** Global verbose (`settings.verbose`) only emits `log('action', ...)` on action dispatch. It does not log: rules that did not match, rules skipped by dedup, or what keyword was tested. A per-rule `devMode` flag exists that produces richer output (match, unblock, done events), but that is a debugging aid, not the principle's described verbose mode.

**Resolution:** Either implement fuller logging under global verbose to match the principle's description, or update Principle 10 to document the two-level reality: global verbose for high-level dispatch traces, per-rule devMode for full decision reconstruction.

---

## B. Principles define scope not yet implemented

These are implementation debts — the principles now describe them as in scope, but the code has not caught up.

---

### B1. Lorebook action coverage is incomplete

**Principle 8:** Reading entries, creating entries, updating entries, deleting entries, and listing what exists in a lorebook are all in scope.

**Code:** `lbWrite` (actions.js) handles create and update (with key merging). Missing:
- Delete entry
- List entries in a lorebook
- Read a single entry into a variable as a standalone action (currently only accessible via the `{{getLBcontent}}` template token inside prompts, not as an explicit action step)
- Create a new lorebook (not just entries within an existing one)

**Resolution:** Implement the missing lorebook actions as registry entries.

---

## C. Significant implementation behavior with no covering principle

These do not violate anything — the code is correct — but the behavior is undocumented at the principles level, which creates a gap for future maintainers.

---

### C1. Actions within a rule run in parallel; variable dependencies serialize them

**Code:** `executeActions` (engine.js) runs all stage-matching actions with `Promise.all`. When an action declares an `outputVar`, a deferred promise is created. Downstream actions that reference that variable in their config are automatically awaited before they run. Independent actions run concurrently.

**Resolution:** Add a note to Principle 5 (Turn Variables): actions within a rule execution run in parallel by default; a variable dependency between actions is the only serialization mechanism.

---

### C2. Turn variables are shared across rules — intentional, needs documenting in principles

**Principle 5** implies variables flow "between steps" within a chain. The text says "subsequent actions in the same rule chain."

**Code:** `setTurnVar` publishes to the module-level `_turnVars` store, which the `varMatch` trigger reads during rule evaluation. The postMessage evaluation loop runs until stable — it repeats the full rule list until a complete pass fires nothing new. This means Rule A can write a variable on pass 1, and Rule B (which missed because the variable didn't exist yet) catches it on pass 2, regardless of their order in the list. Cross-rule reactive chains are the intended use case, not a side effect.

**Resolution:** Update Principle 5 to explicitly describe cross-rule variable sharing and the fixed-point evaluation model. This is architecture, not a gap — it just needs a principle.

---

### C3. stopContinue has no principle

**Principle 6** covers stop (halts stream, does not clean up). Nothing covers stop+continue.

**Code:** `stopContinue` (actions.js) stops the stream and schedules a "continue" generation via `generate('continue')`. The intent is to let newly-triggered lorebook entries activate before generation resumes — a meaningfully different semantic from plain stop.

**Resolution:** Add to Principle 6: stopContinue is the correct pattern when the goal is lorebook activation catch-up. It is not stop with cleanup appended — cleanup remains a separate replace action.

---

### C4. Image generation is fire-and-forget; the action returns before its work is done

**Code:** `imageGen.execute` (actions.js) fires its async work in a closure and returns immediately. The image is attached to the message and saved when the generation completes, which may be several seconds later. A swipe guard (`isCurrentGeneration`) aborts stale results.

**Resolution:** Add a note to Principle 9 (Actions Route to Capabilities They Do Not Own): actions that wrap async media generation must return immediately and must not block the rule execution pipeline. Staleness is handled by the generation ID guard, not by the action.

---

### C5. Badge trigger interaction model is undocumented

**Code:** `badge.js` renders buttons on messages. On click, text currently selected in the DOM is captured and passed into the execution context as `highlighted`. The `{{highlighted}}` variable carries this into action prompts and templates.

**Principle 3** names badge button click as a trigger type but says nothing about how it works.

**Resolution:** Add a note to Principle 3: badge triggers fire at the user's initiative, not during generation. `{{highlighted}}` carries the text selected in the message at click time and may be empty.
