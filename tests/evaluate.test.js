import { vi, describe, it, expect, beforeEach } from 'vitest';

// Provide an empty registry that tests mutate directly; evaluate.js sees the same reference.
vi.mock('../triggers.js', () => ({ TRIGGER_REGISTRY: {} }));

import { evaluateTriggers, getVarDeps } from '../engine/evaluate.js';
import { TRIGGER_REGISTRY } from '../triggers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(triggers, when = 'any', actions = []) {
    return { triggers, when, actions };
}

function makeTrigger(type, config = {}) {
    return { type, config };
}

beforeEach(() => {
    for (const k of Object.keys(TRIGGER_REGISTRY)) delete TRIGGER_REGISTRY[k];
});

// ---------------------------------------------------------------------------
// evaluateTriggers
// ---------------------------------------------------------------------------

describe('evaluateTriggers', () => {
    it('returns null when rule has no triggers', async () => {
        expect(await evaluateTriggers(makeRule([]), '')).toBeNull();
    });

    it('returns null when triggers is undefined', async () => {
        expect(await evaluateTriggers({}, '')).toBeNull();
    });

    describe('OR mode (default / when: "any")', () => {
        it('returns matched string from first matching trigger', async () => {
            TRIGGER_REGISTRY.kw = { test: vi.fn().mockResolvedValue('hello') };
            expect(await evaluateTriggers(makeRule([makeTrigger('kw')], 'any'), 'hello world')).toBe('hello');
        });

        it('skips non-matching triggers and returns the first match', async () => {
            TRIGGER_REGISTRY.kw1 = { test: vi.fn().mockResolvedValue(null) };
            TRIGGER_REGISTRY.kw2 = { test: vi.fn().mockResolvedValue('world') };
            const rule = makeRule([makeTrigger('kw1'), makeTrigger('kw2')], 'any');
            expect(await evaluateTriggers(rule, 'hello world')).toBe('world');
        });

        it('returns null when no triggers match', async () => {
            TRIGGER_REGISTRY.kw = { test: vi.fn().mockResolvedValue(null) };
            expect(await evaluateTriggers(makeRule([makeTrigger('kw')], 'any'), 'nothing')).toBeNull();
        });

        it('returns null for an unknown trigger type', async () => {
            expect(await evaluateTriggers(makeRule([makeTrigger('ghost')], 'any'), 'text')).toBeNull();
        });

        it('treats a throwing trigger as null and keeps trying', async () => {
            TRIGGER_REGISTRY.bad  = { test: vi.fn().mockRejectedValue(new Error('boom')) };
            TRIGGER_REGISTRY.good = { test: vi.fn().mockResolvedValue('found') };
            const rule = makeRule([makeTrigger('bad'), makeTrigger('good')], 'any');
            expect(await evaluateTriggers(rule, 'text')).toBe('found');
        });
    });

    describe('AND mode (when: "all")', () => {
        it('returns first matched string when all triggers match', async () => {
            TRIGGER_REGISTRY.a = { test: vi.fn().mockResolvedValue('match-a') };
            TRIGGER_REGISTRY.b = { test: vi.fn().mockResolvedValue('match-b') };
            const rule = makeRule([makeTrigger('a'), makeTrigger('b')], 'all');
            expect(await evaluateTriggers(rule, 'text')).toBe('match-a');
        });

        it('returns null when any single trigger fails', async () => {
            TRIGGER_REGISTRY.a = { test: vi.fn().mockResolvedValue('match') };
            TRIGGER_REGISTRY.b = { test: vi.fn().mockResolvedValue(null) };
            const rule = makeRule([makeTrigger('a'), makeTrigger('b')], 'all');
            expect(await evaluateTriggers(rule, 'text')).toBeNull();
        });

        it('returns null when all triggers fail', async () => {
            TRIGGER_REGISTRY.a = { test: vi.fn().mockResolvedValue(null) };
            TRIGGER_REGISTRY.b = { test: vi.fn().mockResolvedValue(null) };
            const rule = makeRule([makeTrigger('a'), makeTrigger('b')], 'all');
            expect(await evaluateTriggers(rule, 'text')).toBeNull();
        });
    });
});

// ---------------------------------------------------------------------------
// getVarDeps
// ---------------------------------------------------------------------------

describe('getVarDeps', () => {
    it('returns empty array when knownVars is empty', () => {
        expect(getVarDeps({ text: '{{foo}}' }, new Set())).toEqual([]);
    });

    it('returns empty array when config has no template tokens', () => {
        expect(getVarDeps({ text: 'plain text' }, new Set(['foo']))).toEqual([]);
    });

    it('returns matching var names present in knownVars', () => {
        expect(getVarDeps({ text: 'Result: {{output}}' }, new Set(['output', 'other']))).toEqual(['output']);
    });

    it('does not return vars absent from knownVars', () => {
        expect(getVarDeps({ text: '{{unknown}}' }, new Set(['output']))).toEqual([]);
    });

    it('scans all string fields in the config object', () => {
        const config = { field1: '{{a}}', field2: '{{b}}', n: 42, flag: true };
        const result = getVarDeps(config, new Set(['a', 'b']));
        expect(result).toContain('a');
        expect(result).toContain('b');
    });

    it('trims whitespace from matched var names', () => {
        expect(getVarDeps({ text: '{{ spaced }}' }, new Set(['spaced']))).toEqual(['spaced']);
    });

    it('returns empty array when config is null', () => {
        expect(getVarDeps(null, new Set(['x']))).toEqual([]);
    });

    it('returns empty array when config is undefined', () => {
        expect(getVarDeps(undefined, new Set(['x']))).toEqual([]);
    });
});
