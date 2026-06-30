/**
 * @file engine/rule-registry.js
 * @stamp {"utc":"2026-06-30T00:00:00.000Z"}
 * @architectural-role Engine — per-rule evaluator lifecycle
 * @description
 * Manages one evaluator per {rule, stage} pair. Each evaluator subscribes to the
 * turn-state keys its triggers care about — event flags, variable names, or text
 * streams — and fires independently when any watched key changes. Rules do not wait
 * for each other; a slow LLM call in one rule does not delay another.
 *
 * rebuildRegistry() must be called after settings load and after any settings change
 * that adds, removes, enables, or disables rules. All prior subscriptions are torn
 * down before the new set is built.
 *
 * Watch key derivation:
 *   event trigger     → flag:<eventName>
 *   varMatch trigger  → var:<varName>
 *   keyword/regex/lb  → text:stream  (stream evaluator)
 *                       text:message (postMessage evaluator)
 *   no explicit key   → text channel for the stage (safe default)
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
import { evaluateTriggers, ruleHasStage }                            from './evaluate.js';
import { executeActions }                                             from './execute.js';
import { setBadge }                                                   from '../badge.js';
import {
    subscribe, unsubscribe,
    hasFired, markFired,
    getGenerationId,
    getStreamText, getMessageText, getMessageId,
} from './turn-state.js';
import { trgLog, trgError } from '../logger.js';

// dedupKey ("ruleId:stage") → { keys: string[], fn: Function }
const _evaluators   = new Map();
// dedupKeys currently mid-evaluation — prevents duplicate concurrent fires
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
        if (ruleHasStage(rule, 'stream'))      _register(rule, 'stream');
        if (ruleHasStage(rule, 'postMessage')) _register(rule, 'postMessage');
    }
    trgLog('registry rebuilt', { rules: rules.length, evaluators: _evaluators.size });
}

function _watchKeys(rule, stage) {
    const keys = new Set();
    for (const t of rule.triggers ?? []) {
        if (t.type === 'event')    { keys.add(`flag:${t.config?.event ?? ''}`); continue; }
        if (t.type === 'varMatch') { keys.add(`var:${t.config?.varName ?? ''}`); continue; }
        // keyword, regex, lorebook — subscribe to the text channel for this stage
        keys.add(stage === 'stream' ? 'text:stream' : 'text:message');
    }
    if (!keys.size) keys.add(stage === 'stream' ? 'text:stream' : 'text:message');
    return [...keys];
}

function _register(rule, stage) {
    const dedupKey = `${rule.id}:${stage}`;
    const keys     = _watchKeys(rule, stage);
    const getText  = stage === 'stream' ? getStreamText : getMessageText;

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
            trgLog('match', { ruleId: rule.id, stage, matched });

            const count = (_activeCounts.get(msgId) ?? 0) + 1;
            _activeCounts.set(msgId, count);
            if (msgId >= 0) setBadge(msgId, 'thinking');

            try {
                await executeActions(rule, stage, { matchedKeyword: matched, messageId: msgId, stCtx }, getGenerationId);
            } finally {
                const remaining = (_activeCounts.get(msgId) ?? 1) - 1;
                _activeCounts.set(msgId, remaining);
                if (remaining <= 0) {
                    _activeCounts.delete(msgId);
                    if (msgId >= 0) setBadge(msgId, 'modified');
                }
            }
        } catch (err) {
            trgError('rule evaluator', rule.id, stage, err);
        } finally {
            _pending.delete(dedupKey);
        }
    };

    subscribe(keys, fn);
    _evaluators.set(dedupKey, { keys, fn });
}
