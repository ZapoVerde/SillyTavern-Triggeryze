import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Vitest matches vi.mock paths against the raw import specifier when the file doesn't exist.
// triggers.js is at the project root and uses 4-level-up paths; we mirror that exactly.
vi.mock('../../../../scripts/world-info.js', () => ({
    getSortedEntries:          vi.fn(async () => []),
    parseRegexFromString:      vi.fn(() => null),
    world_info_case_sensitive: false,
}));

// triggers.js uses 4-up for variables.js (from project root).
vi.mock('../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

// condition.js (in actions/) uses 5-up for variables.js — mirror that too so condition.js loads cleanly.
vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

import {
    TRIGGER_REGISTRY,
    setTurnVar, getTurnVar, clearTurnVars, getTurnVarsSnapshot,
    setChatComplete, clearWiCache,
    setCurrentEvent, clearCurrentEvent,
    getLbEntryByName,
    resolveLbQueryTokens,
} from '../triggers.js';
import { getSortedEntries, parseRegexFromString }    from '../../../../scripts/world-info.js';
import { getLocalVariable as getLocalVar5up }        from '../../../../../scripts/variables.js';

beforeEach(() => {
    clearTurnVars();
    clearWiCache();
    setChatComplete(false);
    clearCurrentEvent();
    vi.clearAllMocks();
    // Default: getSortedEntries returns no entries, parseRegexFromString returns null
    vi.mocked(getSortedEntries).mockResolvedValue([]);
    vi.mocked(parseRegexFromString).mockReturnValue(null);
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Turn variable store
// ---------------------------------------------------------------------------

describe('turn variable store', () => {
    it('getTurnVar returns undefined for an unset variable', () => {
        expect(getTurnVar('missing')).toBeUndefined();
    });

    it('setTurnVar / getTurnVar round-trip', () => {
        setTurnVar('mood', 'happy');
        expect(getTurnVar('mood')).toBe('happy');
    });

    it('clearTurnVars removes all variables', () => {
        setTurnVar('a', '1');
        setTurnVar('b', '2');
        clearTurnVars();
        expect(getTurnVar('a')).toBeUndefined();
        expect(getTurnVar('b')).toBeUndefined();
    });

    it('getTurnVarsSnapshot returns a plain object copy', () => {
        setTurnVar('x', '10');
        setTurnVar('y', '20');
        const snap = getTurnVarsSnapshot();
        expect(snap).toEqual({ x: '10', y: '20' });
    });

    it('modifying the snapshot does not affect the live store', () => {
        setTurnVar('z', 'original');
        const snap = getTurnVarsSnapshot();
        snap.z = 'mutated';
        expect(getTurnVar('z')).toBe('original');
    });
});

// ---------------------------------------------------------------------------
// keywordMatch trigger
// ---------------------------------------------------------------------------

describe('TRIGGER_REGISTRY.keywordMatch', () => {
    const kw = TRIGGER_REGISTRY.keywordMatch;

    it('matches a plain keyword anywhere in the text (case insensitive by default)', async () => {
        expect(await kw.test('Hello World', { keywords: 'world' })).toBe('world');
    });

    it('returns null when the keyword is not found', async () => {
        expect(await kw.test('Hello World', { keywords: 'dragon' })).toBeNull();
    });

    it('returns the keyword as matched when caseSensitive is false', async () => {
        expect(await kw.test('HELLO', { keywords: 'hello', caseSensitive: false })).toBe('hello');
    });

    it('returns null when case-sensitive and case differs', async () => {
        expect(await kw.test('HELLO', { keywords: 'hello', caseSensitive: true })).toBeNull();
    });

    it('returns the first matching keyword from a comma-separated list', async () => {
        expect(await kw.test('the dragon roars', { keywords: 'knight, dragon, wizard' })).toBe('dragon');
    });

    it('returns null when no keyword in the list matches', async () => {
        expect(await kw.test('A peaceful meadow', { keywords: 'dragon, wizard' })).toBeNull();
    });

    it('returns null for empty keywords string', async () => {
        expect(await kw.test('hello world', { keywords: '' })).toBeNull();
    });

    it('glob * matches zero or more characters', async () => {
        // globToRegex produces /sam.*/i — no anchors, so exec() returns from the first match
        // position to end-of-string ('samuel was there'), not just the word 'samuel'.
        const result = await kw.test('samuel was there', { keywords: 'sam*' });
        expect(result).not.toBeNull();
        expect(result).toMatch(/^samuel/);
    });

    it('glob * does not match across word boundaries incorrectly', async () => {
        // 'sam*' should match 'samuel' in the text
        const result = await kw.test('I saw samuel today', { keywords: 'sam*' });
        expect(result).not.toBeNull();
    });

    it('glob ? matches exactly one character', async () => {
        const result = await kw.test('elara speaks', { keywords: 'el?ra' });
        expect(result).toBe('elara');
    });

    it('glob ? does not match zero or two characters', async () => {
        expect(await kw.test('elra speaks', { keywords: 'el?ra' })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// regex trigger
// ---------------------------------------------------------------------------

describe('TRIGGER_REGISTRY.regex', () => {
    const rx = TRIGGER_REGISTRY.regex;

    it('returns null for an empty pattern', async () => {
        expect(await rx.test('hello world', { pattern: '' })).toBeNull();
    });

    it('matches text with a plain regex pattern', async () => {
        expect(await rx.test('hello world', { pattern: 'world' })).toBe('world');
    });

    it('returns null when the pattern does not match', async () => {
        expect(await rx.test('hello world', { pattern: 'dragon' })).toBeNull();
    });

    it('uses the regex returned by parseRegexFromString when available', async () => {
        vi.mocked(parseRegexFromString).mockReturnValue(/\bdragon\b/i);
        expect(await rx.test('A Dragon appeared', { pattern: '/dragon/i' })).toBe('Dragon');
    });

    it('returns null for an invalid pattern that parseRegexFromString cannot parse', async () => {
        vi.mocked(parseRegexFromString).mockReturnValue(null);
        expect(await rx.test('text', { pattern: '[invalid' })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// chatComplete trigger
// ---------------------------------------------------------------------------

describe('TRIGGER_REGISTRY.chatComplete', () => {
    it('returns null when chat is not complete', async () => {
        setChatComplete(false);
        expect(await TRIGGER_REGISTRY.chatComplete.test('any text', {})).toBeNull();
    });

    it('returns "chat complete" when chat is complete', async () => {
        setChatComplete(true);
        expect(await TRIGGER_REGISTRY.chatComplete.test('any text', {})).toBe('chat complete');
    });
});

// ---------------------------------------------------------------------------
// varMatch trigger
// ---------------------------------------------------------------------------

describe('TRIGGER_REGISTRY.varMatch', () => {
    const vm = TRIGGER_REGISTRY.varMatch;

    it('returns null when the variable is not set this turn', async () => {
        expect(await vm.test('', { varName: 'mood', operator: 'equals', value: 'happy' })).toBeNull();
    });

    it('matches with equals operator when values are identical', async () => {
        setTurnVar('mood', 'happy');
        expect(await vm.test('', { varName: 'mood', operator: 'equals', value: 'happy' })).toBe('happy');
    });

    it('returns null with equals when values differ', async () => {
        setTurnVar('mood', 'sad');
        expect(await vm.test('', { varName: 'mood', operator: 'equals', value: 'happy' })).toBeNull();
    });

    it('matches with contains operator (case insensitive)', async () => {
        setTurnVar('desc', 'A large dragon');
        expect(await vm.test('', { varName: 'desc', operator: 'contains', value: 'DRAGON' })).toBe('A large dragon');
    });

    it('matches with matches operator (regex)', async () => {
        setTurnVar('hp', '15');
        expect(await vm.test('', { varName: 'hp', operator: 'matches', value: '^\\d+$' })).toBe('15');
    });

    it('matches with notEmpty operator when variable has a value', async () => {
        setTurnVar('result', 'something');
        expect(await vm.test('', { varName: 'result', operator: 'notEmpty' })).toBe('something');
    });

    it('returns null with notEmpty when variable is empty string', async () => {
        setTurnVar('result', '');
        expect(await vm.test('', { varName: 'result', operator: 'notEmpty' })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// chance trigger
// ---------------------------------------------------------------------------

describe('TRIGGER_REGISTRY.chance', () => {
    it('always fires at 100%', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        expect(await TRIGGER_REGISTRY.chance.test('', { chance: 100 })).toBe('chance');
    });

    it('never fires at 0%', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        expect(await TRIGGER_REGISTRY.chance.test('', { chance: 0 })).toBeNull();
    });

    it('fires when random falls below the threshold', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.3);  // 30 < 75
        expect(await TRIGGER_REGISTRY.chance.test('', { chance: 75 })).toBe('chance');
    });

    it('does not fire when random meets or exceeds the threshold', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.8);  // 80 >= 75
        expect(await TRIGGER_REGISTRY.chance.test('', { chance: 75 })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// condition trigger
// ---------------------------------------------------------------------------

describe('TRIGGER_REGISTRY.condition', () => {
    const cond = TRIGGER_REGISTRY.condition;

    it('returns null for an empty expression', async () => {
        expect(await cond.test('', { expression: '' })).toBeNull();
        expect(await cond.test('', { expression: '   ' })).toBeNull();
    });

    it('returns "true" when the condition is met using a turn variable', async () => {
        setTurnVar('hp', '15');
        expect(await cond.test('', { expression: 'hp < 20' })).toBe('true');
    });

    it('returns null when the condition is not met using a turn variable', async () => {
        setTurnVar('hp', '50');
        expect(await cond.test('', { expression: 'hp < 20' })).toBeNull();
    });

    it('supports all numeric comparison operators via turn vars', async () => {
        setTurnVar('n', '10');
        expect(await cond.test('', { expression: 'n > 5'   })).toBe('true');
        expect(await cond.test('', { expression: 'n < 5'   })).toBeNull();
        expect(await cond.test('', { expression: 'n >= 10' })).toBe('true');
        expect(await cond.test('', { expression: 'n <= 10' })).toBe('true');
        expect(await cond.test('', { expression: 'n >= 11' })).toBeNull();
    });

    it('supports text operators via turn vars', async () => {
        setTurnVar('mood', 'happy');
        expect(await cond.test('', { expression: 'mood is "happy"'       })).toBe('true');
        expect(await cond.test('', { expression: 'mood contains "app"'   })).toBe('true');
        expect(await cond.test('', { expression: 'mood matches "h.*y"'   })).toBe('true');
        expect(await cond.test('', { expression: 'mood is "sad"'         })).toBeNull();
    });

    it('supports empty operator', async () => {
        setTurnVar('flag', '');
        expect(await cond.test('', { expression: 'flag empty'   })).toBe('true');
        setTurnVar('flag', 'set');
        expect(await cond.test('', { expression: 'flag empty'   })).toBeNull();
        expect(await cond.test('', { expression: '!flag empty'  })).toBe('true');
    });

    it('supports AND / OR boolean logic', async () => {
        setTurnVar('a', '5');
        setTurnVar('b', '10');
        expect(await cond.test('', { expression: 'a < 10 AND b > 5'  })).toBe('true');
        expect(await cond.test('', { expression: 'a > 10 AND b > 5'  })).toBeNull();
        expect(await cond.test('', { expression: 'a > 10 OR b > 5'   })).toBe('true');
        expect(await cond.test('', { expression: 'a > 10 OR b > 20'  })).toBeNull();
    });

    it('reads chatvar:: via the 5-up variables mock', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue(15);
        expect(await cond.test('', { expression: 'chatvar::hp < 20' })).toBe('true');
    });

    it('returns null when chatvar:: condition is not met', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue(50);
        expect(await cond.test('', { expression: 'chatvar::hp < 20' })).toBeNull();
    });

    it('resolves chatvar:: dot-notation index in condition', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue(8);
        expect(await cond.test('', { expression: 'chatvar::stats.hp <= 10' })).toBe('true');
    });

    it('combines chatvar:: and turn var in AND condition', async () => {
        setTurnVar('danger', 'high');
        vi.mocked(getLocalVar5up).mockReturnValue(5);
        expect(await cond.test('', { expression: 'chatvar::hp < 20 AND danger is "high"' })).toBe('true');
        expect(await cond.test('', { expression: 'chatvar::hp < 20 AND danger is "low"'  })).toBeNull();
    });

    it('text is ignored — condition trigger does not test message text', async () => {
        setTurnVar('hp', '50');
        // Even if the message text contains "critical", the condition checks vars only
        expect(await cond.test('critical situation', { expression: 'hp < 20' })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// getLbEntryByName
// ---------------------------------------------------------------------------

describe('getLbEntryByName', () => {
    it('returns null when no entries exist', async () => {
        expect(await getLbEntryByName('Elara Voss')).toBeNull();
    });

    it('returns the matching entry by comment (case insensitive)', async () => {
        const entry = { comment: 'Elara Voss', content: 'An archivist.', disable: false };
        vi.mocked(getSortedEntries).mockResolvedValue([entry]);
        expect(await getLbEntryByName('elara voss')).toBe(entry);
    });

    it('skips disabled entries', async () => {
        const entry = { comment: 'Elara Voss', content: 'An archivist.', disable: true };
        vi.mocked(getSortedEntries).mockResolvedValue([entry]);
        expect(await getLbEntryByName('Elara Voss')).toBeNull();
    });

    it('filters by lbName when provided', async () => {
        const a = { comment: 'Elara', content: 'A', disable: false, world: 'LoreA' };
        const b = { comment: 'Elara', content: 'B', disable: false, world: 'LoreB' };
        vi.mocked(getSortedEntries).mockResolvedValue([a, b]);
        expect(await getLbEntryByName('Elara', 'LoreB')).toBe(b);
    });
});

// ---------------------------------------------------------------------------
// resolveLbQueryTokens
// ---------------------------------------------------------------------------

describe('resolveLbQueryTokens', () => {
    it('returns the template unchanged when it has no {{lb tokens', async () => {
        expect(await resolveLbQueryTokens('hello {{name}}', {})).toBe('hello {{name}}');
    });

    it('returns the template unchanged when it is empty', async () => {
        expect(await resolveLbQueryTokens('', {})).toBe('');
    });

    it('resolves {{lbTitles}} to a comma-separated list of matching entry titles', async () => {
        const entries = [
            { comment: 'Elara',  disable: false, world: 'Lore' },
            { comment: 'Marcus', disable: false, world: 'Lore' },
        ];
        vi.mocked(getSortedEntries).mockResolvedValue(entries);
        const result = await resolveLbQueryTokens('{{lbTitles:}}', {});
        expect(result).toBe('Elara, Marcus');
    });

    it('resolves {{lbContent:}} to the first matching entry content (default mode is first)', async () => {
        const entries = [
            { comment: 'A', content: 'First content', disable: false, world: 'Lore' },
            { comment: 'B', content: 'Second content', disable: false, world: 'Lore' },
        ];
        vi.mocked(getSortedEntries).mockResolvedValue(entries);
        // Syntax: {{lbContent:lbFilter:titleFilter:keyFilter:mode}}
        // Bare {{lbContent:}} = all filters wildcard, mode defaults to 'first'.
        const result = await resolveLbQueryTokens('{{lbContent:}}', {});
        expect(result).toBe('First content');
    });
});

// ---------------------------------------------------------------------------
// TRIGGER_REGISTRY.event
// ---------------------------------------------------------------------------

describe('TRIGGER_REGISTRY.event', () => {
    const ev = TRIGGER_REGISTRY.event;

    afterEach(() => {
        clearCurrentEvent();
    });

    it('test() returns null when no current event is active', async () => {
        expect(await ev.test('', { event: 'MESSAGE_RECEIVED' })).toBeNull();
    });

    it('test() returns the event name when _currentEvent matches config.event', async () => {
        setCurrentEvent('MESSAGE_RECEIVED');
        expect(await ev.test('', { event: 'MESSAGE_RECEIVED' })).toBe('MESSAGE_RECEIVED');
    });

    it('test() returns null when _currentEvent does not match config.event', async () => {
        setCurrentEvent('GENERATION_STARTED');
        expect(await ev.test('', { event: 'MESSAGE_RECEIVED' })).toBeNull();
    });

    it('test() matches GENERATION_STARTED when set', async () => {
        setCurrentEvent('GENERATION_STARTED');
        expect(await ev.test('', { event: 'GENERATION_STARTED' })).toBe('GENERATION_STARTED');
    });

    it('test() matches CHARACTER_MESSAGE_RENDERED when set', async () => {
        setCurrentEvent('CHARACTER_MESSAGE_RENDERED');
        expect(await ev.test('', { event: 'CHARACTER_MESSAGE_RENDERED' })).toBe('CHARACTER_MESSAGE_RENDERED');
    });

    it('test() returns null when config.event is empty string even if currentEvent is set', async () => {
        setCurrentEvent('MESSAGE_RECEIVED');
        expect(await ev.test('', { event: '' })).toBeNull();
    });

    it('defaultConfig has correct shape', () => {
        expect(ev.defaultConfig).toEqual({ event: 'MESSAGE_RECEIVED' });
    });
});

// ---------------------------------------------------------------------------
// TRIGGER_REGISTRY.badge
// ---------------------------------------------------------------------------

describe('TRIGGER_REGISTRY.badge', () => {
    const badge = TRIGGER_REGISTRY.badge;

    it('test() always returns null — badge never auto-fires', async () => {
        expect(await badge.test('any text', {})).toBeNull();
        expect(await badge.test('', {})).toBeNull();
        expect(await badge.test('keyword', { style: 'inline', keywords: 'keyword' })).toBeNull();
    });

    it('defaultConfig has correct shape', () => {
        const cfg = badge.defaultConfig;
        expect(cfg.style).toBe('top');
        expect(cfg.label).toBe('run');
        expect(cfg.color).toBe('#8888ff');
        expect(cfg.splitOn).toBe('');
        expect(cfg.keywords).toBe('');
        expect(cfg.caseSensitive).toBe(false);
        expect(cfg.clickAction).toBe('fire');
    });
});
