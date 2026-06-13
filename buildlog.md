# Triggeryze — Build Log

---

## 2026-06-13 — sideCall live-apply

### The insight

`postMessage` as a stage label conflates two separate concerns:

1. **When to start the computation** — already solved: the prefetch fires the LLM dispatch the moment the trigger keyword appears in the stream.
2. **When to apply the result** — currently hardcoded to postMessage.

These are not the same thing. Once the LLM promise settles, the result is a string — and applying a string replacement to the display is structurally identical to what the synchronous `replace` action does. The synchronous `replace` works perfectly: keyword disappears live with no flicker. A settled sideCall result should behave exactly the same way.

### What truly requires the committed message

| Dependency | Requires postMessage? |
|---|---|
| `{{keyword}}`, `{{up-to}}`, `{{history}}`, `{{char}}`, `{{user}}` | No — resolved at trigger time |
| `{{paragraph}}` | No — paragraph bounds are deterministic from stream text once keyword is seen |
| `{{message}}` | Yes — requires the full final message text |
| `replaceKeyword` display update | No — just a string substitution |
| `replaceParagraph` display update | No — paragraph bounds are fixed once `\n` follows the match |
| `appendToMessage`, `insertMessage` | Yes — depend on final message structure |
| `saveChat()` | Yes — must not be called mid-stream |
| `MESSAGE_UPDATED` event | Yes — must fire after message is committed |
| Write to `msg.mes` (authoritative) | Yes — ST overwrites `msg.mes` on each token; only stable at postMessage |

### The fix (2026-06-13)

When a prefetch promise settles mid-stream:
- Apply the result to the **display** immediately via the live-patch mechanism (same path as synchronous `replace`)
- Remove the pending highlight for that key
- Store the settled result in `_liveResults` so subsequent tokens keep showing it

`sideCall.execute` at postMessage is unchanged — it still writes to `msg.mes`, calls `saveChat()`, and emits `MESSAGE_UPDATED`. The display just stops waiting for postMessage to show the text.

**Paragraph edge case**: if the LLM result arrives before a `\n` has been seen after the matched keyword (paragraph still streaming), the live display apply is skipped — postMessage handles it. In practice, LLM latency makes this case rare.

**Stream-ended guard**: the live apply checks `_patchObserverMsgId === streamingMessageId`. If the observer has been stopped (streaming ended), the promise settled too late for a live patch — postMessage already handled it, so no action is needed.

### Data flow before this fix

```
keyword seen → prefetch fires LLM call
    [streaming continues — pending highlight shown]
                                         → postMessage → await settled promise → patch display → save
```

### Data flow after this fix

```
keyword seen → prefetch fires LLM call
    [streaming continues — pending highlight shown]
    promise settles → patch display immediately → _liveResults entry
    [streaming continues — result already showing]
                                         → postMessage → apply to msg.mes → save
```

---

## 2026-06-13 — multi-step vars + compose action

### What was built

**`vars` map in `execCtx`** — created fresh in `executeActions` per rule firing, shared across all actions in that execution, discarded after. No cross-rule or cross-turn leakage.

**`outputVar` field** on `sideCall`, `imageGen`, and `compose` — when set, the action writes its result into `vars[outputVar]`.

**`interpolate()` extension** — third argument `ruleVars = {}` looks up `{{varName}}` in the rule-produced vars map. System vars (second argument) always take precedence.

**`compose` action** — new action type. No LLM call. Interpolates a template string from system vars + prior step vars and writes the result to `vars[outputVar]`. Useful for building complex prompt strings from multiple upstream results before passing them to imageGen or a further sideCall.

**`replace` action** — replacement string now also runs through `interpolate`, so `{{varName}}` from a prior step can be used as the replacement text.

**Variable legend** — every action's `renderConfig` shows a row of click-to-inject chips above its prompt/template input. Gray chips are system vars (always available). Amber chips are `outputVar`s declared by prior actions in the same rule. Clicking injects `{{varName}}` at the cursor. Wired via `ctx.priorActions` passed from `renderIngredient`.

---

## 2026-06-13 — automapping: dataflow execution + safe prefetch

### The insight

Rather than explicit step numbers, actions declare what vars they produce (`outputVar`) and the engine infers the execution order from `{{varName}}` references in each action's config. This is a dataflow model: everything that can run in parallel does, and dependent actions wait only for exactly what they need.

### What was built

**`getVarDeps(config, knownVars)`** — scans all string fields of an action's config for `{{varName}}` tokens and returns those that belong to the known set of inter-action outputVars. Used by both `executeActions` and `applyPrefetch`.

**`executeActions` rewrite** — replaced the sequential for-loop with a `Promise.all` over per-action async tasks. Each task (`runOne`) first awaits the deferred promises for its dependencies, then runs. When it finishes, it resolves its own outputVar's deferred. A `finally` block always resolves — so an upstream error never permanently blocks downstream actions. Independent actions (no shared deps) run truly in parallel.

**`applyPrefetch` guard** — before prefetching a sideCall during streaming, check if its prompt references any outputVar produced by another action in the same rule. If it does, skip the early prefetch. The sideCall will be dispatched at postMessage via `executeActions` when its upstream var is ready. Firing it early with an empty var would produce a wrong prompt silently.

### Data flow for a two-step chain

```
postMessage stage starts
    Action A (compose/sideCall) — no deps → starts immediately
    Action B (sideCall) — depends on {{A.outputVar}} → awaits A's deferred

    A resolves → writes vars['x'] → resolves deferred for 'x'
    B unblocks → reads vars['x'] from interpolation → runs with correct prompt
```

### What was skipped

Mid-stream chained prefetch: firing step 2 during streaming once step 1's promise settles in `_liveResults`. The correctness is already guaranteed by the postMessage path above. This optimisation (reducing step 2 latency by the streaming-tail duration) can be added later if the postMessage delay becomes perceptible.

### No user-facing change

No configuration. No step numbers. The engine reads the declared `outputVar`s and `{{varName}}` references and figures it out. Parallel where possible, sequential where necessary.

---

## 2026-06-13 — imageGen fire-and-forget

### Problem

`imageGen.execute` was `await`ed inside `executeActions`, which is `await`ed by `onMessageReceived`. Pollinations and other image sources take 10–30 seconds. That entire duration was blocking `onMessageReceived` from returning, which kept ST's send button disabled until the image arrived.

### Fix

Wrapped the `generateAndUpload` call and all subsequent DOM/save work in a detached `(async () => { ... })()` IIFE. `imageGen.execute` now returns immediately — `executeActions` and `onMessageReceived` complete at normal speed, and ST re-enables the send button right away.

All closure state (prompt, config, messageId, stCtx, isCurrentGeneration, vars) is captured at call time. The swipe guard (`isCurrentGeneration()`) still fires inside the IIFE to abort stale results if the user swipes before the image comes back.

The one trade-off: if downstream actions (declared after imageGen in the same rule) were depending on `{{imageGen.outputVar}}` to chain further work, they would no longer wait for the image path. In practice, image paths are end-of-chain outputs with no consumers, so this is safe. If a future rule needs to chain on an image path, a design note will be needed.

---

## 2026-06-13 — Loggeryze integration

### Findings from CNZ audit

Canonize (`generation-hook.js`) is the reference for how to instrument correctly. Key observations:

1. `window.loggeryze?.time/timeEnd` belong at the **call site**, not inside the shared dispatch function. The dispatch function doesn't know whether it's running inside an active turn.
2. The label format is `'Extension: what [blocking|non-blocking]'`. Blocking = main generation path is waiting. Non-blocking = runs concurrently with something else (streaming, ST pipeline).
3. For async work, `time()` is called synchronously before firing the promise; `timeEnd()` is chained in both `.then()` and `.catch()` — not in `finally`, because that would require converting to async or storing the promise.
4. `time/timeEnd` are no-ops when no turn is active — safe to call unconditionally, but only capture to the chart when called inside an active generation turn.

### What Loggeryze captures automatically

Loggeryze's fetch interceptor taps every `/api/backends/` call. `generateQuietPrompt` routes through there, so **cost** (tokens in/out, model, estimated $) from sideCall dispatches lands in `st_bg_costs.json` without any changes to Triggeryze.

### What Triggeryze needs to instrument explicitly

| Work | Turn active? | Mechanism |
|---|---|---|
| `prefetchSideCall` dispatch — fires during streaming, non-blocking | yes | `window.loggeryze?.time/timeEnd('Triggeryze: sideCall [non-blocking]')` |
| `sideCall.execute` dispatch — fires at postMessage, after GENERATION_ENDED | no | chart timer silently discarded; cost already in bg_costs |
| `imageGen` generateAndUpload — fire-and-forget, well post-turn | no | `console.info('[SMZ:PERF] imageGen ...')` → Loggeryze console log |
| postMessage rule evaluation overall | no | `console.info('[SMZ:PERF] postMessage ...')` → Loggeryze console log |

### What was built

**`prefetchDispatch(prompt, profileId)`** — thin wrapper around `dispatch()` that adds `time/timeEnd` for the `'Triggeryze: sideCall [non-blocking]'` label. All three `dispatch()` calls inside `prefetchSideCall` now go through this wrapper. Prefetch calls fire during streaming (live turn), so they appear on the Loggeryze waterfall chart as a named row.

**`dispatch()` cleanup** — removed the wrong-level `window.loggeryze` calls that were added during initial integration work. The debug-mode elapsed log now uses an inline `Math.round(performance.now() - tStart)` instead of a stored variable.

**postMessage perf log** — `onMessageReceived` in engine.js logs `[SMZ:PERF] postMessage | rules=N | elapsed=Xms` via `console.info` when at least one rule fires. Loggeryze captures `console.info` at level `INFO`, so this appears in `st_console.log`. The turn is over by the time postMessage runs, so the Loggeryze chart can't be used here.

**imageGen perf log** — inside the fire-and-forget IIFE, a `console.info('[SMZ:PERF] imageGen | source=X | Yms')` fires when `generateAndUpload` resolves. Also captured by Loggeryze in `st_console.log`.
