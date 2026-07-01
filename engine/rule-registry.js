/**
 * @file engine/rule-registry.js
 * @stamp {"utc":"2026-07-01T00:00:00.000Z"}
 * @architectural-role Engine — per-rule evaluator lifecycle
 * @description
 * Manages one evaluator per rule. Each evaluator subscribes to the turn-state keys
 * its triggers care about — event flags, variable names, or text:stream — and fires
 * as soon as any watched key changes. Rules do not wait for each other.
 *
 * All keyword/regex/lorebook triggers subscribe to text:stream so rules fire the
 * moment the keyword appears during generation. Actions that need the committed
 * message await it themselves (via waitForMessageText in execute.js) — the evaluator
 * does not impose a stage. One evaluator per rule, dedup key = ruleId.
 *
 * rebuildRegistry() must be called after settings load and after any settings change
 * that adds, removes, enables, or disables rules. All prior subscriptions are torn
 * down before the new set is built.
 *
 * Watch key derivation:
 *   event trigger     → flag:<eventName>
 *   varMatch trigger  → var:<varName>
 *   keyword/regex/lb  → text:stream
 *   no explicit key   → text:stream (safe default)
 *
 * @api-declaration
 * rebuildRegistry() — tear down all evaluators and rebuild from current enabled rules
 *
 * @contract
 *   assertions:
 *     purity:          none — evaluators call executeActions which has arbitrary IO
 *     state_ownership: [_evaluators, _pending, _activeCounts]
 *     external_io:     delegates all IO to executeActions and evaluateTriggers
 */

import { getSettings, getEnabledRules }                              from '../settings/storage.js';
import { evaluateTriggers }                                          from './evaluate.js';
import { executeActions }                                             from './execute.js';
import { setBadge }                                                   from '../badge.js';
import {
    subscribe, unsubscribe,
    hasFired, markFired,
    getGenerationId,
    getStreamText, getMessageText, getMessageId,
} from './turn-state.js';
import { trgLog, trgError } from '../logger.js';

// ruleId → { keys: string[], fn: Function }
const _evaluators   = new Map();
// ruleIds currently mid-evaluation. If a watched key fires while an evaluator is
// already running (e.g. during a lorebook world-info lookup), we drop the redundant
// wake-up rather than queuing a second concurrent evaluation of the same rule.
// The drop is safe because all trigger test() functions read directly from turn-state
// at call time — they don't consume the notification payload — so the in-flight
// evaluation already sees the latest state without needing a second pass.
const _pending      = new Set();
// messageId → count of in-flight action executions (for badge state)
const _activeCounts = new Map();

export function rebuildRegistry() {
    for (const { keys, fn } of _evaluators.values()) unsubscribe(keys, fn);
    _evaluators.clear();
    _pending.clear();
    _activeCounts.clear();

    const s = getSettings();
    if (!s?.enabled) return;

    const rules = getEnabledRules(s);
    for (const rule of rules) {
        _register(rule);
    }
    trgLog('registry rebuilt', { rules: rules.length, evaluators: _evaluators.size });
}

function _watchKeys(rule) {
    const keys = new Set();
    for (const t of rule.triggers ?? []) {
        if (t.type === 'event')    { keys.add(`flag:${t.config?.event ?? ''}`); continue; }
        if (t.type === 'varMatch') { keys.add(`var:${t.config?.varName ?? ''}`); continue; }
        keys.add('text:stream');
    }
    if (!keys.size) keys.add('text:stream');
    return [...keys];
}

function _register(rule) {
    const dedupKey = rule.id;
    const keys     = _watchKeys(rule);
    const getText  = () => getStreamText() || getMessageText();

    const fn = async () => {
        if (hasFired(dedupKey) || _pending.has(dedupKey)) return;
        _pending.add(dedupKey);
        try {
            const matched = await evaluateTriggers(rule, getText());
            if (matched === null) return;
            if (hasFired(dedupKey)) return;
            markFired(dedupKey);

            const stCtx  = window.SillyTavern?.getContext?.();
            const msgId  = getMessageId();
            trgLog('match', { ruleId: rule.id, matched });

            const count = (_activeCounts.get(msgId) ?? 0) + 1;
            _activeCounts.set(msgId, count);
            if (msgId >= 0) setBadge(msgId, 'thinking');

            try {
                await executeActions(rule, { matchedKeyword: matched, messageId: msgId, stCtx }, getGenerationId);
            } finally {
                const remaining = (_activeCounts.get(msgId) ?? 1) - 1;
                _activeCounts.set(msgId, remaining);
                if (remaining <= 0) {
                    _activeCounts.delete(msgId);
                    if (msgId >= 0) setBadge(msgId, 'modified');
                }
            }
        } catch (err) {
            trgError('rule evaluator', rule.id, err);
        } finally {
            _pending.delete(dedupKey);
        }
    };

    subscribe(keys, fn);
    _evaluators.set(dedupKey, { keys, fn });
}
