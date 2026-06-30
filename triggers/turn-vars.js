/**
 * @file triggers/turn-vars.js
 * @stamp {"utc":"2026-06-30T00:00:00.000Z"}
 * @architectural-role IO — turn-level ephemeral variable store (re-export shim)
 * @description
 * Thin re-export from engine/turn-state.js. Variable storage now lives in turn-state
 * alongside flags and dedup so that writing a variable automatically notifies any rule
 * evaluator subscribed to that var name. This file preserves the import path for all
 * trigger and action modules that previously imported from triggers/turn-vars.js.
 *
 * @api-declaration
 * setTurnVar(name, value, rulesetId?)  — write; notifies var:<name> subscribers
 * getTurnVar(name, rulesetId?)         → value | undefined
 * getTurnVarsSnapshot(rulesetId?)      → plain object of visible vars
 * getAllTurnVarNames()                 → sorted string[]
 *
 * @contract
 *   assertions:
 *     purity:          delegates entirely to turn-state
 *     state_ownership: none (state is in turn-state)
 *     external_io:     none
 */

export { setTurnVar, getTurnVar, getTurnVarsSnapshot, getAllTurnVarNames } from '../engine/turn-state.js';
