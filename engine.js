/**
 * @file st-extensions/SillyTavern-Triggeryze/engine.js
 * @stamp {"utc":"2026-06-30T00:00:00.000Z"}
 * @architectural-role Engine — rule dispatch orchestrator
 * @description
 * Receives ST lifecycle events and translates them into turn-state mutations: setting
 * event flags, updating text, and clearing state between turns. Rule evaluation is
 * fully delegated to rule-registry.js — each rule has its own evaluator subscribed
 * to the turn-state keys it cares about and fires independently when conditions are met.
 *
 * Turn-state clearing happens at the first stream token of each new generation (streaming),
 * or at MESSAGE_RECEIVED if no tokens arrived (non-streaming). GENERATION_STARTED does
 * NOT clear state because ST also fires that event on dry runs, and we must not discard
 * the live turn's state on a dry run.
 *
 * @api-declaration
 * onChatLoaded()                        — fires CHAT_LOADED flag
 * onGenerationStarted()                 — resets first-token tracker; fires GENERATION_STARTED flag
 * onStreamToken(text)                   — clears turn-state on first token; updates stream text
 * onMessageReceived(messageId)          — clears turn-state if non-streaming; fires MESSAGE_RECEIVED flag
 * onMessageSwiped(messageId)            — clears turn-state; fires MESSAGE_SWIPED flag
 * onCharacterMessageRendered(messageId) — badge rebuild + CHARACTER_MESSAGE_RENDERED flag
 * fireRuleManually(ruleId, msgId, highlighted, forcedMatchedKw?) — badge-triggered manual rule execution
 * cancelCurrentOperations()             — bump generationId to abort in-flight actions
 * reinjectRuleBadges(messageId?)        — render or refresh rule badge buttons
 * reinjectInlineBadges(messageId?)      — inject or refresh inline keyword badge spans
 * rebuildRegistry()                     — re-export; call after settings change
 *
 * @contract
 *   assertions:
 *     purity:          none — reads/writes DOM via sub-modules; owns _firstTokenFired, _prevTurnAiId
 *     state_ownership: [_firstTokenFired, _prevTurnAiId]
 *     external_io:     delegates all IO to engine/ sub-modules and badge.js
 */

import { getSettings, getEnabledRules }                                       from './settings/storage.js';
import { clearWiCache }                                                        from './triggers/lb-query.js';
import { clearPrefetchCache, isDispatchActive }                               from './actions/index.js';
import { clearAllMessageBadges, ensureBadge, setBadge, renderRuleBadges, injectInlineBadges, reinjectAllInlineBadges, removeAllInlineBadges, startInlineBadgeRemovalWatcher, stopInlineBadgeRemovalWatcher } from './badge.js';
import { stopPatchObserver, applyLivePatch, applyPrefetch, applyInlineBadgePatch, clearLivePatchState, clearPendingHighlights } from './engine/live-patch.js';
import { executeActions }                                                       from './engine/execute.js';
import {
    clearTurnState, bumpGenerationId, getGenerationId,
    setFlag, updateStreamText, updateMessageText, getMessageId,
} from './engine/turn-state.js';
import { rebuildRegistry }                                                     from './engine/rule-registry.js';
import { trgLog, trgPerf }                                                     from './logger.js';

export { rebuildRegistry };

let _firstTokenFired = false;
// Index of the last completed AI message before the current generation began.
// Used to demolish that turn's badges on first token and to guard
// CHARACTER_MESSAGE_RENDERED from rebuilding them mid-generation.
let _prevTurnAiId    = -1;

function _isBadgeTrigger(t) {
    return t.type === 'badge' && t.config?.style !== 'inline' || t.type === 'badgeTrigger';
}
function _isInlineTrigger(t) {
    return t.type === 'badge' && t.config?.style === 'inline' || t.type === 'inlineBadge';
}

function getRuleBadgeDefs(rules) {
    return (rules ?? [])
        .filter(r => r.enabled && r.triggers?.some(_isBadgeTrigger))
        .map(r => {
            const t   = r.triggers.find(_isBadgeTrigger);
            const cfg = t?.config ?? {};
            const legacy = t?.type === 'badgeTrigger';
            return {
                ruleId:      r.id,
                label:       cfg.label || r.name || 'run',
                color:       cfg.color || '#8888ff',
                style:       legacy ? 'top' : (cfg.style || 'top'),
                graph:       cfg.graph === true,
                compact:     cfg.compact === true,
                splitOn:     cfg.splitOn || '',
                clickAction: cfg.clickAction || 'fire',
            };
        });
}

function getInlineBadgeDefs(rules) {
    return (rules ?? [])
        .filter(r => r.enabled && r.triggers?.some(_isInlineTrigger))
        .map(r => {
            const cfg = r.triggers.find(_isInlineTrigger)?.config ?? {};
            const def = {
                ruleId:        r.id,
                keywords:      cfg.keywords ?? '',
                caseSensitive: cfg.caseSensitive ?? false,
                color:         cfg.color ?? '#8888ff',
                clickAction:   cfg.clickAction || 'fire',
            };
            if (cfg.useRegex) { def.useRegex = true; def.pattern = cfg.pattern ?? ''; }
            return def;
        });
}

function _clearTurn() {
    clearTurnState();
    clearWiCache();
}

export function cancelCurrentOperations() {
    bumpGenerationId();
    trgLog('operations cancelled — generationId bumped');
}

export async function fireRuleManually(ruleId, messageId, highlighted = '', forcedMatchedKw = null) {
    const s = getSettings();
    if (!s?.enabled) return;
    const rule = getEnabledRules(s).find(r => r.id === ruleId);
    if (!rule) return;
    const stCtx = window.SillyTavern?.getContext?.();
    const defaultLabel = rule.triggers?.find(t => t.type === 'badge' || t.type === 'badgeTrigger')?.config?.label ?? 'badge';
    const matchedKeyword = forcedMatchedKw ?? defaultLabel;
    setBadge(messageId, 'thinking');
    try {
        await executeActions(rule, 'postMessage', { matchedKeyword, messageId, stCtx, highlighted }, getGenerationId);
    } finally {
        setBadge(messageId, 'modified');
    }
}

export function reinjectRuleBadges(messageId = null) {
    const s    = getSettings();
    const defs = getRuleBadgeDefs(getEnabledRules(s));
    trgLog('badge reinjectRuleBadges', { messageId, defs: defs.length });
    if (messageId !== null) { renderRuleBadges(messageId, defs); return; }
    const stCtx = window.SillyTavern?.getContext?.();
    if (!stCtx?.chat) return;
    stCtx.chat.forEach((_msg, idx) => renderRuleBadges(idx, defs));
}

export function reinjectInlineBadges(messageId = null) {
    const s    = getSettings();
    const defs = getInlineBadgeDefs(getEnabledRules(s));
    trgLog('badge reinjectInlineBadges', { messageId, defs: defs.length });
    if (messageId !== null) { injectInlineBadges(messageId, defs); return; }
    reinjectAllInlineBadges(defs);
}

export async function onGenerationStarted() {
    if (isDispatchActive()) return;
    stopInlineBadgeRemovalWatcher();
    _firstTokenFired = false;
    clearLivePatchState();
    clearPrefetchCache();

    const stCtx = window.SillyTavern?.getContext?.();
    const _chat = stCtx?.chat ?? [];
    _prevTurnAiId = -1;
    for (let i = _chat.length - 1; i >= 0; i--) {
        if (!_chat[i]?.is_user && _chat[i]?.mes) { _prevTurnAiId = i; break; }
    }
    trgLog('generation started', { prevTurnAiId: _prevTurnAiId });

    // Turn-state is NOT cleared here. Dry-run generations also fire GENERATION_STARTED
    // and must not discard the live turn's state. Clearing happens at first token instead.
    // Setting the flag notifies any rule evaluators subscribed to flag:GENERATION_STARTED.
    const s = getSettings();
    if (!s?.enabled) return;
    setFlag('GENERATION_STARTED');
}

export async function onStreamToken(text) {
    const s = getSettings();
    if (!s?.enabled) return;

    if (!_firstTokenFired) {
        _firstTokenFired = true;
        // First real token — safe to clear the previous turn's state now.
        // Also demolish that turn's badges before the new message starts growing.
        _clearTurn();
        if (_prevTurnAiId >= 0) clearAllMessageBadges(_prevTurnAiId);
        removeAllInlineBadges();
    }

    const stCtx = window.SillyTavern?.getContext?.();
    const streamingMessageId = (stCtx?.chat?.length ?? 0) - 1;
    if (streamingMessageId >= 0) {
        // updateStreamText notifies text:stream subscribers (stream-stage rule evaluators).
        updateStreamText(text, streamingMessageId);
        await applyLivePatch(text, streamingMessageId, stCtx);
        await applyPrefetch(text, streamingMessageId, stCtx, getGenerationId);
        await applyInlineBadgePatch(streamingMessageId, getInlineBadgeDefs(getEnabledRules(s)));
    }
}

export async function onMessageReceived(messageId) {
    const s = getSettings();
    if (!s?.enabled) return;
    stopPatchObserver();
    clearPendingHighlights();

    // Non-streaming path: no tokens arrived so turn-state was never cleared at first-token.
    if (!_firstTokenFired) _clearTurn();

    const stCtx = window.SillyTavern?.getContext?.();
    const text  = stCtx?.chat?.[messageId]?.mes ?? '';

    startInlineBadgeRemovalWatcher();
    ensureBadge(messageId);
    const _enabledRules = getEnabledRules(s);
    trgLog('badge onMessageReceived', { messageId, enabledRules: _enabledRules.length });
    renderRuleBadges(messageId, getRuleBadgeDefs(_enabledRules));
    injectInlineBadges(messageId, getInlineBadgeDefs(_enabledRules));

    const tPostMsg = performance.now();

    // updateMessageText notifies text:message subscribers first; setFlag notifies
    // event:MESSAGE_RECEIVED subscribers. All rule evaluators fire independently.
    updateMessageText(text, messageId);
    setFlag('MESSAGE_RECEIVED');

    // Re-render badges after a tick so any synchronous rule completions are reflected.
    setTimeout(() => {
        const s2 = getSettings();
        if (!s2?.enabled) return;
        const rules = getEnabledRules(s2);
        renderRuleBadges(messageId, getRuleBadgeDefs(rules));
        injectInlineBadges(messageId, getInlineBadgeDefs(rules));
        trgPerf(`postMessage dispatch complete | elapsed=${Math.round(performance.now() - tPostMsg)}ms`);
    }, 0);
}

export async function onMessageSwiped(messageId) {
    _clearTurn();
    clearLivePatchState();
    const s = getSettings();
    if (!s?.enabled) return;
    setFlag('MESSAGE_SWIPED');
}

export async function onChatLoaded() {
    _clearTurn();
    const s = getSettings();
    if (!s?.enabled) return;
    setFlag('CHAT_LOADED');
}

async function _renderAllBadgesForMessage(messageId) {
    const enabledRules = getEnabledRules(getSettings());
    ensureBadge(messageId);
    renderRuleBadges(messageId, getRuleBadgeDefs(enabledRules));
    await injectInlineBadges(messageId, getInlineBadgeDefs(enabledRules));
}

export async function onCharacterMessageRendered(messageId) {
    const s = getSettings();
    if (!s?.enabled) return;

    // Once the first token lands, the previous AI turn's badges were demolished.
    // Block CHARACTER_MESSAGE_RENDERED from rebuilding them for the duration of
    // this generation (ST can re-fire this event after context-menu re-renders).
    if (_firstTokenFired && messageId === _prevTurnAiId) return;

    await _renderAllBadgesForMessage(messageId);

    // Dispatch is only meaningful for the most recent AI message — historical
    // re-renders (page load, scrolling) must not trigger rules repeatedly.
    const stCtx = window.SillyTavern?.getContext?.();
    const chat   = stCtx?.chat ?? [];
    const lastAiId = chat.reduce((max, msg, idx) => (!msg.is_user ? idx : max), -1);
    if (lastAiId < 0 || messageId !== lastAiId) return;

    // Flag persists for the turn; dedup in turn-state prevents the evaluator from
    // firing again if CHARACTER_MESSAGE_RENDERED fires multiple times for this message.
    setFlag('CHARACTER_MESSAGE_RENDERED');
}
