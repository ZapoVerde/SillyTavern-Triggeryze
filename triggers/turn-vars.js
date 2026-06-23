/**
 * @file triggers/turn-vars.js
 * @stamp {"utc":"2026-06-23T00:00:00.000Z"}
 * @architectural-role IO — turn-level ephemeral variable store
 * @description
 * Owns the per-turn variable map shared across all rules within a single generation.
 * Cleared at GENERATION_STARTED; readable and writable during stream and postMessage stages.
 * Does not persist across turns — callers that need durable state must use ST variables or lorebooks.
 *
 * Variables are ruleset-scoped by default: a name written by rules in one ruleset is
 * invisible to rules in another. Names prefixed with $ are global and readable by any rule
 * regardless of ruleset. Callers that omit rulesetId also write into the global namespace.
 *
 * @api-declaration
 * setTurnVar(name, value, rulesetId?)  — writes into ruleset scope, or global if name starts with $ or rulesetId is omitted
 * getTurnVar(name, rulesetId?)         → any | undefined — reads from scope, falls back to global
 * clearTurnVars()                      — resets all scopes; call on GENERATION_STARTED
 * getTurnVarsSnapshot(rulesetId?)      → {[name]: any}  merged global + scoped plain object
 * getAllTurnVarNames()                 → string[]  all variable names across every scope, sorted; for UI suggestion lists
 *
 * @contract
 *   assertions:
 *     purity:          no external IO; pure in-memory maps
 *     state_ownership: [_globalVars, _scopedVars]
 *     external_io:     none
 */

const _globalVars = new Map();
const _scopedVars = new Map(); // rulesetId → Map<name, value>

export function setTurnVar(name, value, rulesetId) {
    if (!rulesetId || name.startsWith('$')) { _globalVars.set(name, value); return; }
    if (!_scopedVars.has(rulesetId)) _scopedVars.set(rulesetId, new Map());
    _scopedVars.get(rulesetId).set(name, value);
}

export function getTurnVar(name, rulesetId) {
    if (!rulesetId || name.startsWith('$')) return _globalVars.get(name);
    return _scopedVars.get(rulesetId)?.get(name) ?? _globalVars.get(name);
}

export function clearTurnVars() { _globalVars.clear(); _scopedVars.clear(); }

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
