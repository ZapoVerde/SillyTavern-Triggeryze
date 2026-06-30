/**
 * End-to-end pipeline tests.
 *
 * Each test defines a complete rule (triggers + actions), drives it through the
 * real evaluateTriggers → executeActions stack, and asserts the observable output.
 * The ST boundary (DOM, HTTP, events) is mocked; all extension logic is real.
 *
 * One lane per functional pathway:
 *   1. Keyword → compose → replace (chain / var sequencing)
 *   2. Math in compose template
 *   3. AND trigger gate (all triggers must match)
 *   4. OR trigger gate (any trigger matches)
 *   5. Chance trigger (probability gate)
 *   6. Condition trigger (chatvar evaluated in a condition)
 *   7. Lorebook write via update action
 *   8. ST variable write (set-stvar) → turn-var read-back
 *   9. Imaging pathway (action routing to image)
 *  10. Disabled rule is a no-op
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared in-memory stores — created before mock factories run
// ---------------------------------------------------------------------------

const { stVarStore, lbStore } = vi.hoisted(() => ({
    stVarStore: new Map(),  // backing store for ST chat/global variables
    lbStore:    new Map(),  // backing store for lorebook HTTP calls
}));

// ---------------------------------------------------------------------------
// Mock: external ST boundary (files that do not exist on disk in test env)
// ---------------------------------------------------------------------------

vi.mock('../../../../../script.js', () => ({
    eventSource:        { emit: vi.fn() },
    event_types:        { MESSAGE_UPDATED: 'MESSAGE_UPDATED', WORLDINFO_UPDATED: 'WORLDINFO_UPDATED' },
    name1:              'Alice',
    name2:              'Bot',
    addOneMessage:      vi.fn(),
    updateMessageBlock: vi.fn(),
    appendMediaToMessage: vi.fn(),
    callPopup:          vi.fn(async () => false),
    getRequestHeaders:  vi.fn(() => ({})),
    generateQuietPrompt: vi.fn(async () => ({ content: '' })),
    messageFormatting:  vi.fn(() => ''),
    itemizedPrompts:    [],
}));
vi.mock('../../../../../scripts/openai.js', () => ({ oai_settings: { prompts: [] } }));

// triggers.js (project root) uses 4-up paths to reach world-info and variables.
// triggers/ submodules (lb-query.js, keyword.js) use 5-up — mirror both.
vi.mock('../../../../scripts/world-info.js', () => ({
    getSortedEntries:          vi.fn(async () => []),
    parseRegexFromString:      vi.fn(() => null),
    world_info_case_sensitive: false,
}));
vi.mock('../../../../../scripts/world-info.js', () => ({
    getSortedEntries:          vi.fn(async () => []),
    parseRegexFromString:      vi.fn(() => null),
    world_info_case_sensitive: false,
}));

vi.mock('../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

// actions/ and condition.js use 5-up paths — back them with the in-memory store
vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  (name, opts = {}) => {
        const key = opts?.index !== undefined ? `${name}[${opts.index}]` : name;
        return stVarStore.get(key) ?? null;
    },
    getGlobalVariable: (name, opts = {}) => stVarStore.get(`global:${name}`) ?? null,
    setLocalVariable:  (name, value, opts = {}) => {
        const key = opts?.index !== undefined ? `${name}[${opts.index}]` : name;
        stVarStore.set(key, value);
    },
    setGlobalVariable: (name, value) => stVarStore.set(`global:${name}`, value),
}));

// ---------------------------------------------------------------------------
// Mock: local files with external dependencies
// ---------------------------------------------------------------------------

// Lorebook HTTP layer — backed by lbStore
vi.mock('../lorebookApi.js', () => ({
    lbGetLorebook: async (name) => {
        const stored = lbStore.get(name);
        return stored ? { ...stored, entries: { ...stored.entries } } : { entries: {} };
    },
    lbSaveLorebook: async (name, data) => { lbStore.set(name, data); },
}));

// live-patch.js — DOM-heavy; provide minimal stubs used by execute.js
vi.mock('../engine/live-patch.js', () => ({
    hasLiveResult:       vi.fn(() => false),
    setLiveResult:       vi.fn(),
    stopPatchObserver:   vi.fn(),
    clearLivePatchState: vi.fn(),
}));

// settings/storage.js — return empty settings (no rules, not verbose)
vi.mock('../settings/storage.js', () => ({
    getSettings: vi.fn(() => ({ rules: [] })),
}));

// actions/index.js — mutable ACTION_REGISTRY populated per-test
vi.mock('../actions/index.js', () => ({
    ACTION_REGISTRY:  {},
    getTemplateTier:  vi.fn(() => 'immediate'),
    resolveLbTokens:  vi.fn(async t => t),
    interpolate:      vi.fn(t => t),
}));

// ---------------------------------------------------------------------------
// Real module imports (trigger + engine pipeline)
// ---------------------------------------------------------------------------

import { evaluateTriggers }                             from '../engine/evaluate.js';
import { executeActions }                               from '../engine/execute.js';
import { ACTION_REGISTRY }                              from '../actions/index.js';
import { setTurnVar, getTurnVar }                       from '../triggers/turn-vars.js';
import { clearTurnState, setFlag }                      from '../engine/turn-state.js';
import { clearWiCache }                                 from '../triggers/lb-query.js';
import { getSortedEntries }                             from '../../../../scripts/world-info.js';

// Real action implementations under test
import { compose }  from '../actions/compose.js';
import { setStVar } from '../actions/set-stvar.js';
import { update }   from '../actions/update.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Every rule in production carries _rulesetId from getEnabledRules. Tests must
// include it so that executeActions scopes var writes correctly and evaluateTriggers
// threads it into def.test() — the seam where the scoping bug lived.
const E2E_RS = 'e2e-rs';

function makeRule(triggers, actions, overrides = {}) {
    return {
        id: 'e2e', name: 'E2E rule', enabled: true, devMode: false,
        when: 'any', triggers, actions, _rulesetId: E2E_RS, ...overrides,
    };
}

// Read a turn variable from the e2e ruleset scope (mirrors how executeActions writes).
function getVar(name) { return getTurnVar(name, E2E_RS); }

function makeMsg(mes) { return { mes, name: 'Bot', is_user: false, is_system: false }; }

function makeStCtx(mes) {
    const msg = makeMsg(mes);
    return { chat: [msg], saveChat: vi.fn(async () => {}) };
}

async function run(rule, text, stCtx) {
    const matched = await evaluateTriggers(rule, text);
    if (matched === null) return { matched, vars: {} };
    const execCtx = { matchedKeyword: matched, messageId: 0, highlighted: '', stCtx };
    await executeActions(rule, 'postMessage', execCtx, () => 1);
    return { matched };
}

beforeEach(() => {
    clearTurnState();
    clearWiCache();
    stVarStore.clear();
    lbStore.clear();
    vi.clearAllMocks();
    // Reset ACTION_REGISTRY to empty before each test
    for (const k of Object.keys(ACTION_REGISTRY)) delete ACTION_REGISTRY[k];
});

// ---------------------------------------------------------------------------
// 1. Keyword → compose → update(text)  (variable-sequencing pipeline)
// ---------------------------------------------------------------------------

describe('pathway: keyword → compose → update(text)', () => {
    it('compose result is available to update(text) as a rule variable', async () => {
        ACTION_REGISTRY.compose = compose;
        ACTION_REGISTRY.update  = update;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [
                { type: 'compose', config: { outputVar: 'label', template: '{{keyword}} slain' } },
                { type: 'update', config: { target: 'text', mode: 'replaceKeyword', value: '[{{label}}]' } },
            ],
        );

        const { matched } = await run(rule, 'A dragon appeared.', stCtx);

        expect(matched).toBe('dragon');
        expect(stCtx.chat[0].mes).toBe('A [dragon slain] appeared.');
    });

    it('trigger miss: no match → actions do not run', async () => {
        ACTION_REGISTRY.compose = compose;
        const stCtx = makeStCtx('A peaceful meadow.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'compose', config: { outputVar: 'x', template: 'fired' } }],
        );

        const { matched } = await run(rule, 'A peaceful meadow.', stCtx);

        expect(matched).toBeNull();
        expect(getVar('x')).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 2. Math in compose template
// ---------------------------------------------------------------------------

describe('pathway: math expressions', () => {
    it('{{math:}} is evaluated inside a compose template', async () => {
        ACTION_REGISTRY.compose = compose;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'compose', config: { outputVar: 'result', template: '{{math: 6 * 7}}' } }],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        expect(getVar('result')).toBe('42');
    });

    it('math expression using up-to text length via compose', async () => {
        ACTION_REGISTRY.compose = compose;

        const stCtx = makeStCtx('ABC dragon');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            // Verify operator precedence: 2 + 3 * 4 = 14, not 20
            [{ type: 'compose', config: { outputVar: 'calc', template: '{{math: 2 + 3 * 4}}' } }],
        );

        await run(rule, 'ABC dragon', stCtx);

        expect(getVar('calc')).toBe('14');
    });
});

// ---------------------------------------------------------------------------
// 3. AND trigger gate (when: 'all')
// ---------------------------------------------------------------------------

describe('pathway: AND gate (all triggers must match)', () => {
    it('does not fire when only one of two required triggers matches', async () => {
        ACTION_REGISTRY.compose = compose;

        const rule = makeRule(
            [
                { type: 'keyword', config: { mode: 'text', keywords: 'dragon' } },
                { type: 'varMatch',     config: { varName: 'mood', operator: 'equals', value: 'angry' } },
            ],
            [{ type: 'compose', config: { outputVar: 'outcome', template: 'fired' } }],
            { when: 'all' },
        );

        // Only keyword matches; varMatch fails (mood not set)
        const matched = await evaluateTriggers(rule, 'A dragon appeared.');
        expect(matched).toBeNull();
    });

    it('fires when both triggers match', async () => {
        ACTION_REGISTRY.compose = compose;

        setTurnVar('mood', 'angry', E2E_RS);
        const rule = makeRule(
            [
                { type: 'keyword', config: { mode: 'text', keywords: 'dragon' } },
                { type: 'varMatch',     config: { varName: 'mood', operator: 'equals', value: 'angry' } },
            ],
            [{ type: 'compose', config: { outputVar: 'outcome', template: 'rage triggered' } }],
            { when: 'all' },
        );

        const stCtx = makeStCtx('A dragon appeared.');
        const { matched } = await run(rule, 'A dragon appeared.', stCtx);

        expect(matched).toBe('dragon');
        expect(getVar('outcome')).toBe('rage triggered');
    });
});

// ---------------------------------------------------------------------------
// 4. OR trigger gate (when: 'any')
// ---------------------------------------------------------------------------

describe('pathway: OR gate (any trigger is sufficient)', () => {
    it('fires on the first matching trigger', async () => {
        ACTION_REGISTRY.compose = compose;

        const rule = makeRule(
            [
                { type: 'keyword', config: { mode: 'text', keywords: 'dragon' } },
                { type: 'keyword', config: { mode: 'text', keywords: 'serpent' } },
            ],
            [{ type: 'compose', config: { outputVar: 'beast', template: '{{keyword}}' } }],
            { when: 'any' },
        );

        const stCtx = makeStCtx('A serpent coils.');
        await run(rule, 'A serpent coils.', stCtx);

        expect(getVar('beast')).toBe('serpent');
    });

    it('fires on the second trigger when the first does not match', async () => {
        ACTION_REGISTRY.compose = compose;

        const rule = makeRule(
            [
                { type: 'keyword', config: { mode: 'text', keywords: 'dragon' } },
                { type: 'event', config: { event: 'MESSAGE_RECEIVED' } },
            ],
            [{ type: 'compose', config: { outputVar: 'tag', template: 'chat-done' } }],
            { when: 'any' },
        );

        // No 'dragon' in text, but MESSAGE_RECEIVED flag is set for this turn
        setFlag('MESSAGE_RECEIVED');

        const stCtx = makeStCtx('All quiet.');
        await run(rule, 'All quiet.', stCtx);

        expect(getVar('tag')).toBe('chat-done');
    });
});

// ---------------------------------------------------------------------------
// 5. Chance trigger (probability gate)
// ---------------------------------------------------------------------------

describe('pathway: chance trigger', () => {
    it('fires when the random roll falls below the threshold', async () => {
        ACTION_REGISTRY.compose = compose;

        vi.spyOn(Math, 'random').mockReturnValue(0.2); // 20 < 50 → fires

        const rule = makeRule(
            [{ type: 'chance', config: { chance: 50 } }],
            [{ type: 'compose', config: { outputVar: 'fired', template: 'yes' } }],
        );

        const stCtx = makeStCtx('Any text.');
        await run(rule, 'Any text.', stCtx);

        expect(getVar('fired')).toBe('yes');
    });

    it('does not fire when the random roll meets or exceeds the threshold', async () => {
        ACTION_REGISTRY.compose = compose;

        vi.spyOn(Math, 'random').mockReturnValue(0.8); // 80 >= 50 → blocked

        const rule = makeRule(
            [{ type: 'chance', config: { chance: 50 } }],
            [{ type: 'compose', config: { outputVar: 'fired', template: 'yes' } }],
        );

        const matched = await evaluateTriggers(rule, 'Any text.');
        expect(matched).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 6. Condition trigger (chatvar evaluated in boolean expression)
// ---------------------------------------------------------------------------

describe('pathway: condition trigger (chatvar)', () => {
    it('fires when the chatvar condition is true', async () => {
        ACTION_REGISTRY.compose = compose;

        // Use chatvar:: prefix so the lookup calls getLocalVariable (backed by stVarStore).
        // Bare variable names in conditions resolve from the turn-var snapshot, not ST vars.
        stVarStore.set('hp', '15');

        const rule = makeRule(
            [{ type: 'condition', config: { expression: 'chatvar::hp < 20' } }],
            [{ type: 'compose', config: { outputVar: 'status', template: 'critical' } }],
        );

        const stCtx = makeStCtx('');
        await run(rule, '', stCtx);

        expect(getVar('status')).toBe('critical');
    });

    it('does not fire when the condition is false', async () => {
        ACTION_REGISTRY.compose = compose;

        stVarStore.set('hp', '80');

        const rule = makeRule(
            [{ type: 'condition', config: { expression: 'chatvar::hp < 20' } }],
            [{ type: 'compose', config: { outputVar: 'status', template: 'critical' } }],
        );

        const matched = await evaluateTriggers(rule, '');
        expect(matched).toBeNull();
    });

    it('AND/OR logic works inside the condition expression', async () => {
        ACTION_REGISTRY.compose = compose;

        stVarStore.set('hp', '5');
        stVarStore.set('shield', 'broken');

        const rule = makeRule(
            [{ type: 'condition', config: { expression: 'chatvar::hp < 20 AND chatvar::shield is "broken"' } }],
            [{ type: 'compose', config: { outputVar: 'alert', template: 'in danger' } }],
        );

        const stCtx = makeStCtx('');
        await run(rule, '', stCtx);

        expect(getVar('alert')).toBe('in danger');
    });
});

// ---------------------------------------------------------------------------
// 7. Lorebook write via update action
// ---------------------------------------------------------------------------

describe('pathway: lorebook write (update action)', () => {
    it('creates a lorebook entry via the trigger → update pipeline', async () => {
        ACTION_REGISTRY.update = update;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{
                type:   'update',
                config: { target: 'lorebook', lorebook: 'testBook', title: 'Dragon', keys: 'dragon', content: 'A fearsome beast: {{keyword}}' },
            }],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        const lbData = lbStore.get('testBook');
        expect(lbData).toBeDefined();
        const entry = Object.values(lbData.entries).find(e => e.comment === 'Dragon');
        expect(entry).toBeDefined();
        expect(entry.content).toBe('A fearsome beast: dragon');
    });

    it('lorebook write from getSortedEntries mock supports keyword (lorebook mode) trigger', async () => {
        // Populate the WI mock with an entry whose key 'elara' will trigger
        vi.mocked(getSortedEntries).mockResolvedValue([
            { comment: 'Elara Voss', content: 'An archivist.', disable: false, world: 'testBook', key: ['elara'], keysecondary: [] },
        ]);

        ACTION_REGISTRY.compose = compose;

        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'lorebook' } }],
            [{ type: 'compose', config: { outputVar: 'who', template: '{{keyword}} found' } }],
        );

        const stCtx = makeStCtx('Elara arrived at the archive.');
        await run(rule, 'Elara arrived at the archive.', stCtx);

        expect(getVar('who')).toMatch(/elara/i);
    });
});

// ---------------------------------------------------------------------------
// 8. ST variable pipeline (set-stvar → chatvar read-back)
// ---------------------------------------------------------------------------

describe('pathway: ST variable write (set-stvar) + read-back', () => {
    it('set-stvar stores the value; subsequent compose reads it via stVarStore', async () => {
        ACTION_REGISTRY.setStVar  = setStVar;
        ACTION_REGISTRY.compose   = compose;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [
                { type: 'setStVar', config: { scope: 'chat', varName: 'creature', key: '', value: '{{keyword}}' } },
                { type: 'compose',  config: { outputVar: 'echo', template: '{{chatvar::creature}} was stored' } },
            ],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        // set-stvar should have written to stVarStore via the 5-up variables mock
        expect(stVarStore.get('creature')).toBe('dragon');
        // compose should have read it back via {{chatvar::creature}}
        expect(getVar('echo')).toBe('dragon was stored');
    });

    it('global scope: set-stvar writes to global, compose reads via {{globalvar::}}', async () => {
        ACTION_REGISTRY.setStVar = setStVar;
        ACTION_REGISTRY.compose  = compose;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [
                { type: 'setStVar', config: { scope: 'global', varName: 'lastBeast', key: '', value: '{{keyword}}' } },
                { type: 'compose',  config: { outputVar: 'echo', template: '{{globalvar::lastBeast}}' } },
            ],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        expect(stVarStore.get('global:lastBeast')).toBe('dragon');
        expect(getVar('echo')).toBe('dragon');
    });
});

// ---------------------------------------------------------------------------
// 9. Imaging pathway (action routing)
// ---------------------------------------------------------------------------

describe('pathway: imaging (image action routing)', () => {
    it('image action execute is called when the trigger fires', async () => {
        const imageExecute = vi.fn(async () => {});
        ACTION_REGISTRY.image = { stage: () => 'postMessage', execute: imageExecute };

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'image', config: { source: 'pollinations', prompt: 'A {{keyword}} in a cave' } }],
        );

        const { matched } = await run(rule, 'A dragon appeared.', stCtx);

        expect(matched).toBe('dragon');
        expect(imageExecute).toHaveBeenCalledOnce();
        const [config, ctx] = imageExecute.mock.calls[0];
        expect(config.prompt).toBe('A {{keyword}} in a cave');
        expect(ctx.matchedKeyword).toBe('dragon');
    });

    it('image is not called when the trigger does not match', async () => {
        const imageExecute = vi.fn(async () => {});
        ACTION_REGISTRY.image = { stage: () => 'postMessage', execute: imageExecute };

        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'image', config: { source: 'pollinations', prompt: 'A beast' } }],
        );

        const matched = await evaluateTriggers(rule, 'A peaceful meadow.');
        expect(matched).toBeNull();
        expect(imageExecute).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 10. Stage gating — action stage must match the execution stage
// ---------------------------------------------------------------------------

describe('pathway: stage gating', () => {
    it('postMessage action is skipped when executing under the streaming stage', async () => {
        // compose.stage = 'postMessage'; executing with stage='streaming' should skip it
        ACTION_REGISTRY.compose = compose;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'compose', config: { outputVar: 'x', template: 'fired' } }],
        );

        const matched = await evaluateTriggers(rule, 'A dragon appeared.');
        const execCtx = { matchedKeyword: matched, messageId: 0, highlighted: '', stCtx };
        await executeActions(rule, 'streaming', execCtx, () => 1);

        expect(getVar('x')).toBeUndefined();
    });

    it('postMessage action runs when stage matches', async () => {
        ACTION_REGISTRY.compose = compose;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'compose', config: { outputVar: 'x', template: 'fired' } }],
        );

        const matched = await evaluateTriggers(rule, 'A dragon appeared.');
        const execCtx = { matchedKeyword: matched, messageId: 0, highlighted: '', stCtx };
        await executeActions(rule, 'postMessage', execCtx, () => 1);

        expect(getVar('x')).toBe('fired');
    });
});

// ---------------------------------------------------------------------------
// 11. Ruleset variable scope — varMatch and condition see scoped vars
//
// These tests exist because of a class of bug where triggers called
// getTurnVarsSnapshot() without a rulesetId and therefore only saw global
// ($-prefixed) variables.  The seam under test is:
//   evaluateTriggers → runTrigger → def.test(text, config, rulesetId)
// Each test pre-populates a var using the rule's own rulesetId (matching what
// executeActions does) and asserts that the trigger fires correctly.
// ---------------------------------------------------------------------------

describe('pathway: varMatch reads variables through ruleset scope', () => {
    it('fires when the variable exists in the rule\'s own ruleset scope', async () => {
        setTurnVar('mood', 'angry', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'mood', operator: 'equals', value: 'angry' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBe('angry');
    });

    it('does not fire when the variable is scoped to a different ruleset', async () => {
        setTurnVar('mood', 'angry', 'rs-other');
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'mood', operator: 'equals', value: 'angry' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });

    it('set operator fires for a variable in the rule\'s own scope', async () => {
        setTurnVar('flag', 'yes', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'flag', operator: 'set' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBe('yes');
    });

    it('notSet operator returns null when the variable exists in scope', async () => {
        setTurnVar('flag', 'yes', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'flag', operator: 'notSet' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });

    it('$-prefixed variable is visible regardless of rulesetId', async () => {
        setTurnVar('$emotion', 'calm');
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: '$emotion', operator: 'equals', value: 'calm' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBe('calm');
    });

    it('condition trigger evaluates a scoped variable when rulesetId matches', async () => {
        setTurnVar('hp', '5', E2E_RS);
        const rule = makeRule(
            [{ type: 'condition', config: { expression: 'hp > 0' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBe('true');
    });

    it('condition trigger does not fire when variable is in a different scope', async () => {
        setTurnVar('hp', '5', 'rs-other');
        const rule = makeRule(
            [{ type: 'condition', config: { expression: 'hp > 0' } }],
            [],
        );
        // Missing var defaults to '' → Number('') = 0, which is not > 0
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 12. varMatch operator coverage
//
// One describe per operator. Each covers: fires (true positive), does not fire
// on mismatch (true negative), and the relevant boundary cases for that op.
// The final describe covers the full reactive pipeline: a compose action in
// Rule A writes a variable; Rule B's varMatch trigger reads it.
// ---------------------------------------------------------------------------

describe('pathway: varMatch — equals', () => {
    it('fires when the variable value exactly matches the target', async () => {
        ACTION_REGISTRY.compose = compose;
        setTurnVar('mood', 'angry', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'mood', operator: 'equals', value: 'angry' } }],
            [{ type: 'compose', config: { outputVar: 'result', template: 'matched' } }],
        );
        await run(rule, '', makeStCtx(''));
        expect(getVar('result')).toBe('matched');
    });

    it('does not fire when the variable value differs', async () => {
        setTurnVar('mood', 'calm', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'mood', operator: 'equals', value: 'angry' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });

    it('does not fire when the variable is not set', async () => {
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'mood', operator: 'equals', value: 'angry' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });
});

describe('pathway: varMatch — notEquals', () => {
    it('fires when the variable value differs from the target', async () => {
        ACTION_REGISTRY.compose = compose;
        setTurnVar('mood', 'calm', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'mood', operator: 'notEquals', value: 'angry' } }],
            [{ type: 'compose', config: { outputVar: 'result', template: 'not angry' } }],
        );
        await run(rule, '', makeStCtx(''));
        expect(getVar('result')).toBe('not angry');
    });

    it('does not fire when the variable value matches the target', async () => {
        setTurnVar('mood', 'angry', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'mood', operator: 'notEquals', value: 'angry' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });

    it('does not fire when the variable is not set', async () => {
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'mood', operator: 'notEquals', value: 'angry' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });
});

describe('pathway: varMatch — contains', () => {
    it('fires when the variable value contains the substring (case-insensitive)', async () => {
        ACTION_REGISTRY.compose = compose;
        setTurnVar('desc', 'A large Dragon roars', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'desc', operator: 'contains', value: 'dragon' } }],
            [{ type: 'compose', config: { outputVar: 'result', template: 'found' } }],
        );
        await run(rule, '', makeStCtx(''));
        expect(getVar('result')).toBe('found');
    });

    it('does not fire when the variable does not contain the substring', async () => {
        setTurnVar('desc', 'A peaceful meadow', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'desc', operator: 'contains', value: 'dragon' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });

    it('does not fire when the variable is not set', async () => {
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'desc', operator: 'contains', value: 'dragon' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });
});

describe('pathway: varMatch — notEmpty', () => {
    it('fires when the variable has a non-blank value', async () => {
        ACTION_REGISTRY.compose = compose;
        setTurnVar('summary', 'something happened', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'summary', operator: 'notEmpty' } }],
            [{ type: 'compose', config: { outputVar: 'result', template: 'had content' } }],
        );
        await run(rule, '', makeStCtx(''));
        expect(getVar('result')).toBe('had content');
    });

    it('does not fire when the variable is an empty string', async () => {
        setTurnVar('summary', '', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'summary', operator: 'notEmpty' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });

    it('does not fire when the variable is a whitespace-only string', async () => {
        setTurnVar('summary', '   ', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'summary', operator: 'notEmpty' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });

    it('does not fire when the variable is not set', async () => {
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'summary', operator: 'notEmpty' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });
});

describe('pathway: varMatch — empty', () => {
    it('fires when the variable is set to an empty string', async () => {
        ACTION_REGISTRY.compose = compose;
        setTurnVar('summary', '', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'summary', operator: 'empty' } }],
            [{ type: 'compose', config: { outputVar: 'result', template: 'was blank' } }],
        );
        await run(rule, '', makeStCtx(''));
        expect(getVar('result')).toBe('was blank');
    });

    it('fires when the variable is set to a whitespace-only string', async () => {
        setTurnVar('summary', '   ', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'summary', operator: 'empty' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBe('empty');
    });

    it('does not fire when the variable has a non-blank value', async () => {
        setTurnVar('summary', 'something', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'summary', operator: 'empty' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });

    it('does not fire when the variable is not set (empty is not the same as unset)', async () => {
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'summary', operator: 'empty' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });
});

describe('pathway: varMatch — set', () => {
    it('fires when the variable is set to a non-empty value', async () => {
        ACTION_REGISTRY.compose = compose;
        setTurnVar('flag', 'yes', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'flag', operator: 'set' } }],
            [{ type: 'compose', config: { outputVar: 'result', template: 'was set' } }],
        );
        await run(rule, '', makeStCtx(''));
        expect(getVar('result')).toBe('was set');
    });

    it('fires with "set" sentinel when the variable is set to an empty string', async () => {
        // set means "exists in the store" — even an empty string counts.
        // The sentinel "set" is returned so the matched keyword is non-empty.
        setTurnVar('flag', '', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'flag', operator: 'set' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBe('set');
    });

    it('does not fire when the variable has never been written this turn', async () => {
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'flag', operator: 'set' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });
});

describe('pathway: varMatch — notSet', () => {
    it('fires when the variable has never been written this turn', async () => {
        ACTION_REGISTRY.compose = compose;
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'absent', operator: 'notSet' } }],
            [{ type: 'compose', config: { outputVar: 'result', template: 'was absent' } }],
        );
        await run(rule, '', makeStCtx(''));
        expect(getVar('result')).toBe('was absent');
    });

    it('does not fire when the variable exists in scope', async () => {
        setTurnVar('present', 'something', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'present', operator: 'notSet' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });

    it('does not fire when the variable is set to an empty string (it is still set)', async () => {
        setTurnVar('present', '', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'present', operator: 'notSet' } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });
});

describe('pathway: varMatch — regex mode', () => {
    it('equals + useRegex fires when the value matches the pattern', async () => {
        ACTION_REGISTRY.compose = compose;
        setTurnVar('hp', '42', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'hp', operator: 'equals', value: '^\\d+$', useRegex: true } }],
            [{ type: 'compose', config: { outputVar: 'result', template: 'numeric' } }],
        );
        await run(rule, '', makeStCtx(''));
        expect(getVar('result')).toBe('numeric');
    });

    it('equals + useRegex does not fire when the value does not match the pattern', async () => {
        setTurnVar('hp', 'full', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'hp', operator: 'equals', value: '^\\d+$', useRegex: true } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });

    it('notEquals + useRegex fires when the value does not match the pattern', async () => {
        ACTION_REGISTRY.compose = compose;
        setTurnVar('status', 'idle', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'status', operator: 'notEquals', value: '/active|busy/', useRegex: true } }],
            [{ type: 'compose', config: { outputVar: 'result', template: 'not active' } }],
        );
        await run(rule, '', makeStCtx(''));
        expect(getVar('result')).toBe('not active');
    });

    it('notEquals + useRegex does not fire when the value matches the pattern', async () => {
        setTurnVar('status', 'active', E2E_RS);
        const rule = makeRule(
            [{ type: 'varMatch', config: { varName: 'status', operator: 'notEquals', value: '/active|busy/', useRegex: true } }],
            [],
        );
        expect(await evaluateTriggers(rule, '')).toBeNull();
    });
});

describe('pathway: varMatch — full reactive pipeline (compose writes, varMatch reads)', () => {
    it('fires when a prior rule wrote the variable this turn', async () => {
        ACTION_REGISTRY.compose = compose;

        const ruleA = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'compose', config: { outputVar: 'mood', template: 'angry' } }],
        );
        const stCtx = makeStCtx('A dragon appeared.');
        await run(ruleA, 'A dragon appeared.', stCtx);

        const ruleB = makeRule(
            [{ type: 'varMatch', config: { varName: 'mood', operator: 'equals', value: 'angry' } }],
            [{ type: 'compose', config: { outputVar: 'result', template: 'rage triggered' } }],
        );
        await run(ruleB, 'A dragon appeared.', stCtx);

        expect(getVar('result')).toBe('rage triggered');
    });

    it('does not fire when the upstream rule did not match and the variable was never written', async () => {
        ACTION_REGISTRY.compose = compose;

        const ruleA = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'compose', config: { outputVar: 'mood', template: 'angry' } }],
        );
        await run(ruleA, 'A peaceful meadow.', makeStCtx('A peaceful meadow.'));

        const ruleB = makeRule(
            [{ type: 'varMatch', config: { varName: 'mood', operator: 'equals', value: 'angry' } }],
            [],
        );
        expect(await evaluateTriggers(ruleB, 'A peaceful meadow.')).toBeNull();
    });
});
