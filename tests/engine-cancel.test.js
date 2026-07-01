import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../../scripts/world-info.js', () => ({
    getSortedEntries:          vi.fn(async () => []),
    parseRegexFromString:      vi.fn(() => null),
    world_info_case_sensitive: false,
}));

vi.mock('../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

vi.mock('../settings/storage.js', () => ({
    getSettings:     vi.fn(() => ({ rules: [], verbose: false, enabled: true })),
    getEnabledRules: vi.fn((s) => (s.rules ?? []).filter(r => r.enabled !== false)),
}));

vi.mock('../badge.js', () => ({
    ensureBadge:                    vi.fn(),
    setBadge:                       vi.fn(),
    renderRuleBadges:               vi.fn(),
    clearAllMessageBadges:          vi.fn(),
    removeAllBadges:                vi.fn(),
    reinjectAllBadges:              vi.fn(),
    injectInlineBadges:             vi.fn(),
    removeAllInlineBadges:          vi.fn(),
    reinjectAllInlineBadges:        vi.fn(),
    buildResolvedPatterns:          vi.fn(async () => []),
    injectPatternsIntoEl:           vi.fn(),
    stopInlineBadgeRemovalWatcher:  vi.fn(),
    startInlineBadgeRemovalWatcher: vi.fn(),
}));

vi.mock('../actions/index.js', () => ({
    clearPrefetchCache: vi.fn(),
    isDispatchActive:   vi.fn(() => false),
}));

vi.mock('../engine/evaluate.js', () => ({
    evaluateTriggers: vi.fn(async () => null),
}));

vi.mock('../engine/live-patch.js', () => ({
    stopPatchObserver:       vi.fn(),
    applyLivePatch:          vi.fn(),
    applyPrefetch:           vi.fn(),
    applyInlineBadgePatch:   vi.fn(),
    clearLivePatchState:     vi.fn(),
    clearPendingHighlights:  vi.fn(),
}));

vi.mock('../engine/execute.js', () => ({
    executeActions: vi.fn(async () => {}),
}));

// rule-registry subscriptions would interfere with engine-level tests.
vi.mock('../engine/rule-registry.js', () => ({
    rebuildRegistry: vi.fn(),
}));

import { cancelCurrentOperations, onMessageReceived } from '../engine.js';
import { getSettings }                                 from '../settings/storage.js';
import { clearTurnState, getGenerationId, hasFlag }   from '../engine/turn-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();
    clearTurnState();
    vi.mocked(getSettings).mockReturnValue({ rules: [], verbose: false, enabled: true });
    global.window    = { SillyTavern: { getContext: () => ({ chat: [{ is_user: false, mes: 'hi' }] }) } };
    global.document  = { querySelector: vi.fn(() => null) };
    global.performance = { now: () => 0 };
    global.setTimeout = (fn) => fn(); // flush synchronous timer
});

// ---------------------------------------------------------------------------
// cancelCurrentOperations
// ---------------------------------------------------------------------------

describe('cancelCurrentOperations', () => {
    it('increments the generationId', () => {
        const before = getGenerationId();
        cancelCurrentOperations();
        expect(getGenerationId()).toBeGreaterThan(before);
    });

    it('can be called multiple times without throwing', () => {
        expect(() => {
            cancelCurrentOperations();
            cancelCurrentOperations();
        }).not.toThrow();
    });

    it('each call increments generationId by at least 1', () => {
        const g0 = getGenerationId();
        cancelCurrentOperations();
        const g1 = getGenerationId();
        cancelCurrentOperations();
        const g2 = getGenerationId();
        expect(g1).toBeGreaterThan(g0);
        expect(g2).toBeGreaterThan(g1);
    });
});

// ---------------------------------------------------------------------------
// onMessageReceived — flag dispatch
// ---------------------------------------------------------------------------

describe('onMessageReceived', () => {
    it('sets MESSAGE_RECEIVED flag in turn-state', async () => {
        await onMessageReceived(0);
        expect(hasFlag('MESSAGE_RECEIVED')).toBe(true);
    });

    it('does nothing when the extension is disabled', async () => {
        vi.mocked(getSettings).mockReturnValue({ rules: [], enabled: false });
        await onMessageReceived(0);
        expect(hasFlag('MESSAGE_RECEIVED')).toBe(false);
    });

    it('does not call executeActions directly — dispatch is handled by rule-registry', async () => {
        const { executeActions } = await import('../engine/execute.js');
        await onMessageReceived(0);
        expect(executeActions).not.toHaveBeenCalled();
    });
});
