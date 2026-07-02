import { vi, describe, it, expect, beforeEach } from 'vitest';

// evaluate.js now only exports getVarDeps (stageMatches/resolveStage removed).
vi.mock('../engine/evaluate.js', () => ({
    getVarDeps: vi.fn(() => []),
}));

// ACTION_REGISTRY starts empty; tests populate it per-case.
vi.mock('../actions/index.js', () => ({
    ACTION_REGISTRY: {},
}));

vi.mock('../triggers/turn-vars.js', () => ({
    getTurnVar:          vi.fn(() => undefined),
    getTurnVarsSnapshot: vi.fn(() => ({})),
}));

// Default: actions are immediate tier — no message wait needed.
vi.mock('../actions/template.js', () => ({
    getTemplateTier: vi.fn(() => 'immediate'),
}));

// Default: no committed message yet; waitForMessageText resolves right away.
vi.mock('../engine/turn-state.js', () => ({
    getMessageText:     vi.fn(() => ''),
    getMessageId:       vi.fn(() => 0),
    waitForMessageText: vi.fn(async () => 'committed text'),
    commitTurnVars:     vi.fn(),
}));

import { executeActions }    from '../engine/execute.js';
import { ACTION_REGISTRY }   from '../actions/index.js';
import { getVarDeps }        from '../engine/evaluate.js';
import { getTemplateTier }   from '../actions/template.js';
import { getMessageText, waitForMessageText, commitTurnVars } from '../engine/turn-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(actions, overrides = {}) {
    return { id: 'r1', name: 'Test Rule', devMode: false, actions, ...overrides };
}

function makeAction(type, config = {}, overrides = {}) {
    return { type, config, ...overrides };
}

const execCtx = { matchedKeyword: 'kw', messageId: 0, highlighted: '' };
const genId    = () => 1;

beforeEach(() => {
    for (const k of Object.keys(ACTION_REGISTRY)) delete ACTION_REGISTRY[k];
    vi.clearAllMocks();
    vi.mocked(getVarDeps).mockReturnValue([]);
    vi.mocked(getTemplateTier).mockReturnValue('immediate');
    vi.mocked(getMessageText).mockReturnValue('');
    vi.mocked(waitForMessageText).mockResolvedValue('committed text');
    global.window = { SillyTavern: { getContext: () => null } };
});

// ---------------------------------------------------------------------------
// executeActions
// ---------------------------------------------------------------------------

describe('executeActions', () => {
    it('calls execute on a registered action', async () => {
        ACTION_REGISTRY.act = { execute: vi.fn() };
        await executeActions(makeRule([makeAction('act')]), execCtx, genId);
        expect(ACTION_REGISTRY.act.execute).toHaveBeenCalledOnce();
    });

    it('passes execCtx fields and vars into the action', async () => {
        ACTION_REGISTRY.act = { execute: vi.fn() };
        await executeActions(makeRule([makeAction('act')]), execCtx, genId);
        const [config, ctx] = ACTION_REGISTRY.act.execute.mock.calls[0];
        expect(ctx.matchedKeyword).toBe('kw');
        expect(ctx.ruleId).toBe('r1');
        expect(ctx.vars).toBeDefined();
    });

    it('skips an action type not present in ACTION_REGISTRY', async () => {
        // no registry entry for 'ghost' — should not throw
        await expect(
            executeActions(makeRule([makeAction('ghost')]), execCtx, genId)
        ).resolves.toBeUndefined();
    });

    it('does nothing when the rule has no actions', async () => {
        await expect(
            executeActions(makeRule([]), execCtx, genId)
        ).resolves.toBeUndefined();
    });

    it('catches errors thrown by an action and continues to the next', async () => {
        ACTION_REGISTRY.bad  = { execute: vi.fn().mockRejectedValue(new Error('boom')) };
        ACTION_REGISTRY.good = { execute: vi.fn() };
        await executeActions(
            makeRule([makeAction('bad'), makeAction('good')]),
            execCtx, genId,
        );
        expect(ACTION_REGISTRY.good.execute).toHaveBeenCalled();
    });

    it('publishes outputVar via commitTurnVars once the rule settles', async () => {
        ACTION_REGISTRY.act = {
            execute: vi.fn(async (_cfg, ctx) => { ctx.vars['myVar'] = 'result'; }),
        };
        const action = makeAction('act', { outputVar: 'myVar' });
        await executeActions(makeRule([action]), execCtx, genId);
        expect(commitTurnVars).toHaveBeenCalledOnce();
        const [pairs, rulesetId] = commitTurnVars.mock.calls[0];
        expect(pairs.get('myVar')).toBe('result');
        expect(rulesetId).toBeUndefined();
    });

    it('skips commitTurnVars when no action writes an outputVar', async () => {
        ACTION_REGISTRY.act = {
            execute: vi.fn(),  // does not touch vars
        };
        const action = makeAction('act', { outputVar: 'myVar' });
        await executeActions(makeRule([action]), execCtx, genId);
        expect(commitTurnVars).not.toHaveBeenCalled();
    });

    it('provides isCurrentGeneration predicate that matches the captured gen id', async () => {
        let capturedPredicate;
        ACTION_REGISTRY.act = {
            execute: vi.fn(async (_cfg, ctx) => { capturedPredicate = ctx.isCurrentGeneration; }),
        };
        await executeActions(makeRule([makeAction('act')]), execCtx, genId);
        expect(capturedPredicate()).toBe(true);
    });

    it('awaits message text for a message-tier action when none is yet committed', async () => {
        vi.mocked(getTemplateTier).mockReturnValue('message');
        vi.mocked(getMessageText).mockReturnValue('');
        ACTION_REGISTRY.act = { templateFields: () => ['{{message}}'], execute: vi.fn() };
        await executeActions(makeRule([makeAction('act')]), execCtx, genId);
        expect(waitForMessageText).toHaveBeenCalled();
        expect(ACTION_REGISTRY.act.execute).toHaveBeenCalledOnce();
    });

    it('skips a message-tier action when generation changes while awaiting message text', async () => {
        vi.mocked(getTemplateTier).mockReturnValue('message');
        vi.mocked(getMessageText).mockReturnValue('');
        vi.mocked(waitForMessageText).mockResolvedValue('');
        ACTION_REGISTRY.act = { templateFields: () => ['{{message}}'], execute: vi.fn() };
        // Returns 1 at capture time in executeActions, then 2 for the isCurrentGeneration check.
        const dynamicGenId = vi.fn().mockReturnValueOnce(1).mockReturnValue(2);
        await executeActions(makeRule([makeAction('act')]), execCtx, dynamicGenId);
        expect(ACTION_REGISTRY.act.execute).not.toHaveBeenCalled();
    });
});
