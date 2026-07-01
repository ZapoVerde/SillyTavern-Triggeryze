/**
 * Dedup regression tests — one rule fires exactly once per turn.
 *
 * The original double-fire bug: two evaluators per rule (one per stage),
 * each with its own dedup key (ruleId:stage), fired the same action twice
 * in a single turn — once on text:stream, once on text:message. Any rule
 * with a toast action (stage: ['stream', 'postMessage']) triggered this.
 *
 * Fix: one evaluator per rule, dedup key = ruleId. These tests drive the
 * real turn-state pub/sub → rule-registry pipeline with executeActions
 * mocked, and assert call counts across all the scenarios that used to
 * produce doubles.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — cut the ST boundary while keeping rule-registry + turn-state real
// ---------------------------------------------------------------------------

vi.mock('../settings/storage.js', () => ({
    getSettings:     vi.fn(() => ({ enabled: true, rules: [] })),
    getEnabledRules: vi.fn(() => []),
}));

vi.mock('../badge.js', () => ({
    setBadge: vi.fn(),
}));

// evaluateTriggers always matches by default; individual tests can override.
vi.mock('../engine/evaluate.js', () => ({
    evaluateTriggers: vi.fn(async () => 'keyword'),
}));

// executeActions is the observable we count — keep it async so the evaluator
// body behaves exactly as in production (two awaits before the finally block).
vi.mock('../engine/execute.js', () => ({
    executeActions: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { rebuildRegistry }              from '../engine/rule-registry.js';
import { executeActions }               from '../engine/execute.js';
import { evaluateTriggers }             from '../engine/evaluate.js';
import { getSettings, getEnabledRules } from '../settings/storage.js';
import {
    clearTurnState,
    updateStreamText,
    updateMessageText,
    setFlag,
} from '../engine/turn-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(id, triggerType = 'keyword') {
    const trigger = triggerType === 'event'
        ? { type: 'event',   config: { event: 'MESSAGE_RECEIVED' } }
        : { type: 'keyword', config: { mode: 'text', keywords: 'dragon' } };
    return {
        id, name: id, enabled: true, devMode: false, when: 'any',
        triggers: [trigger],
        actions:  [{ type: 'toast', config: { message: 'fired' } }],
    };
}

function setupRegistry(rules) {
    vi.mocked(getSettings).mockReturnValue({ enabled: true, rules });
    vi.mocked(getEnabledRules).mockReturnValue(rules);
    rebuildRegistry();
}

// Drain all pending micro-tasks so async evaluator chains complete.
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
    vi.clearAllMocks();
    clearTurnState();
    vi.mocked(evaluateTriggers).mockResolvedValue('keyword');
    global.window = { SillyTavern: { getContext: () => null } };
});

// ---------------------------------------------------------------------------
// Keyword trigger — evaluator subscribed to text:stream
// ---------------------------------------------------------------------------

describe('dedup — keyword rule', () => {
    it('fires exactly once when multiple stream tokens arrive', async () => {
        setupRegistry([makeRule('r1')]);

        updateStreamText('A dragon', 0);
        updateStreamText('A dragon appeared', 0);
        updateStreamText('A dragon appeared.', 0);
        await flush();

        expect(executeActions).toHaveBeenCalledTimes(1);
    });

    it('fires exactly once across stream tokens AND the committed message', async () => {
        setupRegistry([makeRule('r1')]);

        // Stream fires the evaluator on text:stream.
        updateStreamText('A dragon appeared.', 0);
        await flush();

        // Committed message notifies text:message — keyword evaluator does NOT
        // subscribe there, so this must not trigger a second fire.
        updateMessageText('A dragon appeared.', 0);
        await flush();

        expect(executeActions).toHaveBeenCalledTimes(1);
    });

    it('fires once per turn — dedup resets after clearTurnState', async () => {
        setupRegistry([makeRule('r1')]);

        // Turn 1
        updateStreamText('A dragon.', 0);
        await flush();
        expect(executeActions).toHaveBeenCalledTimes(1);

        // Between turns the engine calls clearTurnState, which resets the fired set.
        clearTurnState();

        // Turn 2
        updateStreamText('A dragon again.', 1);
        await flush();
        expect(executeActions).toHaveBeenCalledTimes(2);
    });

    it('does not fire when the trigger does not match', async () => {
        vi.mocked(evaluateTriggers).mockResolvedValue(null);
        setupRegistry([makeRule('r1')]);

        updateStreamText('No match here.', 0);
        await flush();

        expect(executeActions).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Event trigger — evaluator subscribed to flag:MESSAGE_RECEIVED
// ---------------------------------------------------------------------------

describe('dedup — event rule', () => {
    it('fires exactly once when the event flag is set', async () => {
        setupRegistry([makeRule('r2', 'event')]);

        setFlag('MESSAGE_RECEIVED');
        await flush();

        expect(executeActions).toHaveBeenCalledTimes(1);
    });

    it('fires exactly once even if the same flag is set again this turn', async () => {
        setupRegistry([makeRule('r2', 'event')]);

        setFlag('MESSAGE_RECEIVED');
        setFlag('MESSAGE_RECEIVED');
        await flush();

        expect(executeActions).toHaveBeenCalledTimes(1);
    });

    it('does not fire on unrelated text:stream notifications', async () => {
        setupRegistry([makeRule('r2', 'event')]);

        // Stream text arrives but this rule only watches flag:MESSAGE_RECEIVED.
        updateStreamText('Any text.', 0);
        await flush();

        expect(executeActions).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Multiple rules — independent evaluators, no cross-rule dedup contamination
// ---------------------------------------------------------------------------

describe('dedup — multiple rules', () => {
    it('two keyword rules each fire once — total = 2, not 4', async () => {
        setupRegistry([makeRule('rA'), makeRule('rB')]);

        updateStreamText('A dragon appeared.', 0);
        updateStreamText('A dragon appeared!', 0);
        await flush();

        expect(executeActions).toHaveBeenCalledTimes(2);
    });

    it('two event rules each fire once when the flag is set', async () => {
        setupRegistry([makeRule('rC', 'event'), makeRule('rD', 'event')]);

        setFlag('MESSAGE_RECEIVED');
        await flush();

        expect(executeActions).toHaveBeenCalledTimes(2);
    });

    it('keyword rule and event rule each fire exactly once in the same turn', async () => {
        setupRegistry([makeRule('rE'), makeRule('rF', 'event')]);

        updateStreamText('A dragon appeared.', 0);
        setFlag('MESSAGE_RECEIVED');
        await flush();

        expect(executeActions).toHaveBeenCalledTimes(2);
    });
});
