/**
 * @file engine/turn-state.js
 * @stamp {"utc":"2026-06-30T00:00:00.000Z"}
 * @architectural-role IO — per-turn reactive state store
 * @description
 * Unified store for all per-turn state: event flags, turn variables, fired-rule dedup,
 * and current text. Exposes a pub/sub surface so rule evaluators react automatically
 * when any state they depend on changes. Flags persist for the full turn once set —
 * a rule whose var dependency resolves seconds after an event flag was set will still
 * see the flag as true and fire correctly.
 *
 * Cleared at the first token of each new generation (streaming), or at MESSAGE_RECEIVED
 * for non-streaming turns. The generationId increments on every clear, allowing
 * in-flight async actions to detect that a new turn has started and bail out.
 *
 * Variable scoping mirrors the former turn-vars.js: names prefixed with $ are global;
 * all others are scoped to their ruleset.
 *
 * @api-declaration
 * clearTurnState()                       — clears all flags, vars, dedup, text; bumps generationId
 * bumpGenerationId()                     — bumps generationId only; used by cancelCurrentOperations
 * getGenerationId()                      → number
 * setFlag(name)                          — sets an event flag; notifies subscribers of flag:<name>
 * hasFlag(name)                          → boolean
 * setTurnVar(name, value, rulesetId?)    — sets a scoped turn variable; notifies subscribers of var:<name>
 * getTurnVar(name, rulesetId?)           → value | undefined
 * getTurnVarsSnapshot(rulesetId?)        → plain object of all visible vars
 * getAllTurnVarNames()                   → sorted string[]
 * hasFired(dedupKey)                     → boolean — true if ruleId:stage has fired this turn
 * markFired(dedupKey)                    — records that ruleId:stage has fired
 * updateStreamText(text, messageId)      — updates accumulated stream text; notifies text:stream
 * updateMessageText(text, messageId)     — sets committed message text; notifies text:message
 * getStreamText()                        → string
 * getMessageText()                       → string
 * getMessageId()                         → number
 * subscribe(keys, fn)                    — register fn to be called when any listed key changes
 * unsubscribe(keys, fn)                  — deregister fn from all listed keys
 *
 * @contract
 *   assertions:
 *     purity:          no external IO; pure in-memory state
 *     state_ownership: [_generationId, _flags, _globalVars, _scopedVars, _firedKeys, _streamText, _messageText, _messageId, _subscribers]
 *     external_io:     none
 */

let _generationId = 0;
const _flags      = new Set();
const _globalVars = new Map();
const _scopedVars = new Map(); // rulesetId → Map<name, value>
const _firedKeys  = new Set(); // "ruleId:stage" dedup
let _streamText   = '';
let _messageText  = '';
let _messageId    = -1;

const _subscribers = new Map(); // key → Set<fn>

// ── Generation lifecycle ───────────────────────────────────────────────────

export function clearTurnState() {
    _generationId++;
    _flags.clear();
    _globalVars.clear();
    _scopedVars.clear();
    _firedKeys.clear();
    _streamText  = '';
    _messageText = '';
    _messageId   = -1;
}

export function bumpGenerationId() { _generationId++; }
export function getGenerationId()  { return _generationId; }

// ── Event flags ────────────────────────────────────────────────────────────

export function setFlag(name) {
    if (_flags.has(name)) return;
    _flags.add(name);
    _notify(`flag:${name}`);
}

export function hasFlag(name) { return _flags.has(name); }

// ── Turn variables ─────────────────────────────────────────────────────────

export function setTurnVar(name, value, rulesetId) {
    if (!rulesetId || name.startsWith('$')) {
        _globalVars.set(name, value);
    } else {
        if (!_scopedVars.has(rulesetId)) _scopedVars.set(rulesetId, new Map());
        _scopedVars.get(rulesetId).set(name, value);
    }
    _notify(`var:${name}`);
}

export function getTurnVar(name, rulesetId) {
    if (!rulesetId || name.startsWith('$')) return _globalVars.get(name);
    return _scopedVars.get(rulesetId)?.get(name) ?? _globalVars.get(name);
}

export function getTurnVarsSnapshot(rulesetId) {
    return {
        ...Object.fromEntries(_globalVars),
        ...(rulesetId ? Object.fromEntries(_scopedVars.get(rulesetId) ?? []) : {}),
    };
}

export function getAllTurnVarNames() {
    const names = new Set(_globalVars.keys());
    for (const scope of _scopedVars.values())
        for (const k of scope.keys()) names.add(k);
    return [...names].sort();
}

// ── Dedup ──────────────────────────────────────────────────────────────────

export function hasFired(dedupKey)  { return _firedKeys.has(dedupKey); }
export function markFired(dedupKey) { _firedKeys.add(dedupKey); }

// ── Text ───────────────────────────────────────────────────────────────────

export function updateStreamText(text, messageId) {
    _streamText = text;
    _messageId  = messageId;
    _notify('text:stream');
}

export function updateMessageText(text, messageId) {
    _messageText = text;
    _messageId   = messageId;
    _notify('text:message');
}

export function getStreamText()  { return _streamText; }
export function getMessageText() { return _messageText; }
export function getMessageId()   { return _messageId; }

// ── Pub/sub ────────────────────────────────────────────────────────────────

export function subscribe(keys, fn) {
    for (const key of keys) {
        if (!_subscribers.has(key)) _subscribers.set(key, new Set());
        _subscribers.get(key).add(fn);
    }
}

export function unsubscribe(keys, fn) {
    for (const key of keys) _subscribers.get(key)?.delete(fn);
}

function _notify(key) {
    const fns = _subscribers.get(key);
    if (!fns?.size) return;
    for (const fn of fns) fn();
}
