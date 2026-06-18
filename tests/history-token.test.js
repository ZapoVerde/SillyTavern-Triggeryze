import { vi, describe, it, expect } from 'vitest';

// Minimal mocks so template.js can import without pulling in ST globals.
vi.mock('../triggers/lb-query.js', () => ({
    getLbEntryByName:     vi.fn(async () => null),
    resolveLbQueryTokens: vi.fn(async t => t),
}));
vi.mock('../triggers/turn-vars.js', () => ({
    getTurnVarsSnapshot: vi.fn(() => ({})),
}));
vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));
vi.mock('../../../../../script.js',                    () => ({ itemizedPrompts: [], name1: 'User', name2: 'Char' }));
vi.mock('../../../../../scripts/openai.js',            () => ({ oai_settings: { prompts: [] } }));
vi.mock('../../../../../scripts/itemized-prompts.js',  () => ({ itemizedPrompts: [] }));

import { resolveHistoryTokens } from '../actions/template.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChat(...messages) {
    return messages.map(([name, mes]) => ({ name, mes }));
}

// [name, mes, isUser] — isUser defaults to false
function makeChatFull(...messages) {
    return messages.map(([name, mes, isUser = false]) => ({ name, mes, is_user: isUser, is_system: false }));
}

// ---------------------------------------------------------------------------
// {{history:[N]}} — literal form
// ---------------------------------------------------------------------------

describe('resolveHistoryTokens — literal {{history:[N]}}', () => {
    const chat = makeChat(
        ['User', 'hello'],
        ['Char', 'hi there'],
        ['User', 'how are you'],
        ['Char', 'great thanks'],
    );

    it('returns the last N turn-pairs before beforeIndex', () => {
        // N is pair-count: N=1 → 2 messages (one user+char pair), N=2 → 4 messages
        const result = resolveHistoryTokens('{{history:[1]}}', chat, 4, {});
        expect(result).toBe('User: how are you\n\nChar: great thanks');
    });

    it('returns fewer turns when N exceeds available history', () => {
        const result = resolveHistoryTokens('{{history:[10]}}', chat, 4, {});
        expect(result).toContain('User: hello');
        expect(result).toContain('Char: great thanks');
    });

    it('returns empty string when N is 0', () => {
        expect(resolveHistoryTokens('{{history:[0]}}', chat, 4, {})).toBe('');
    });

    it('returns empty string when N is negative', () => {
        expect(resolveHistoryTokens('{{history:[-1]}}', chat, 4, {})).toBe('');
    });

    it('returns empty string when beforeIndex is 0 (no prior turns)', () => {
        expect(resolveHistoryTokens('{{history:[2]}}', chat, 0, {})).toBe('');
    });

    it('preserves surrounding text', () => {
        const result = resolveHistoryTokens('Context:\n{{history:[1]}}\nEnd', chat, 4, {});
        expect(result.startsWith('Context:\n')).toBe(true);
        expect(result.endsWith('\nEnd')).toBe(true);
        expect(result).toContain('Char: great thanks');
    });

    it('leaves template unchanged when no {{history:}} present', () => {
        const t = 'no history token here';
        expect(resolveHistoryTokens(t, chat, 4, {})).toBe(t);
    });

    it('resolves multiple history tokens in one template', () => {
        // N=1 pair → "User: how are you\n\nChar: great thanks" (the last pair before index 4)
        const onePair = 'User: how are you\n\nChar: great thanks';
        const result  = resolveHistoryTokens('A:{{history:[1]}} B:{{history:[1]}}', chat, 4, {});
        expect(result).toBe(`A:${onePair} B:${onePair}`);
    });
});

// ---------------------------------------------------------------------------
// {{history:varName}} — turn variable form
// ---------------------------------------------------------------------------

describe('resolveHistoryTokens — variable {{history:varName}}', () => {
    const chat = makeChat(
        ['User', 'msg1'],
        ['Char', 'msg2'],
        ['User', 'msg3'],
        ['Char', 'msg4'],
    );

    it('reads N from a turn variable', () => {
        // N=1 pair → last user+char pair before index 4
        const result = resolveHistoryTokens('{{history:depth}}', chat, 4, { depth: '1' });
        expect(result).toBe('User: msg3\n\nChar: msg4');
    });

    it('returns empty string when variable is unset', () => {
        expect(resolveHistoryTokens('{{history:depth}}', chat, 4, {})).toBe('');
    });

    it('returns empty string when variable resolves to 0', () => {
        expect(resolveHistoryTokens('{{history:depth}}', chat, 4, { depth: '0' })).toBe('');
    });

    it('returns empty string when variable resolves to non-numeric', () => {
        expect(resolveHistoryTokens('{{history:depth}}', chat, 4, { depth: 'many' })).toBe('');
    });

    it('resolves a numeric string like "3" from a variable', () => {
        const result = resolveHistoryTokens('{{history:n}}', chat, 4, { n: '3' });
        expect(result).toContain('Char: msg2');
        expect(result).toContain('User: msg3');
        expect(result).toContain('Char: msg4');
    });
});

// ---------------------------------------------------------------------------
// {{history:[N]:filter}} — role and name filters
// ---------------------------------------------------------------------------

describe('resolveHistoryTokens — :user filter', () => {
    // 3 user messages, 4 AI messages, multi-AI turn after msg3
    const chat = makeChatFull(
        ['User', 'msg1', true],
        ['Aria', 'msg2'],
        ['User', 'msg3', true],
        ['Aria', 'msg4'],
        ['Aria', 'msg5'],  // consecutive AI — same "turn" as msg4
        ['User', 'msg6', true],
        ['Aria', 'msg7'],
    );

    it('returns exactly N last user messages', () => {
        const result = resolveHistoryTokens('{{history:[2]:user}}', chat, 7, {});
        expect(result).toBe('User: msg3\n\nUser: msg6');
    });

    it('returns all user messages when N exceeds available', () => {
        const result = resolveHistoryTokens('{{history:[10]:user}}', chat, 7, {});
        expect(result).toBe('User: msg1\n\nUser: msg3\n\nUser: msg6');
    });

    it('respects beforeIndex — excludes messages at or after it', () => {
        // beforeIndex=2 means only indices 0..1 are in scope (msg1=User, msg2=Aria)
        const result = resolveHistoryTokens('{{history:[5]:user}}', chat, 2, {});
        expect(result).toBe('User: msg1');
    });

    it('skips consecutive AI messages cleanly', () => {
        // With N=1 we want the single most-recent user message before index 7
        const result = resolveHistoryTokens('{{history:[1]:user}}', chat, 7, {});
        expect(result).toBe('User: msg6');
    });
});

describe('resolveHistoryTokens — :ai filter', () => {
    const chat = makeChatFull(
        ['User', 'msg1', true],
        ['Aria', 'msg2'],
        ['User', 'msg3', true],
        ['Aria', 'msg4'],
        ['Aria', 'msg5'],
        ['User', 'msg6', true],
        ['Aria', 'msg7'],
    );

    it('returns exactly N last AI messages', () => {
        const result = resolveHistoryTokens('{{history:[3]:ai}}', chat, 7, {});
        expect(result).toBe('Aria: msg4\n\nAria: msg5\n\nAria: msg7');
    });

    it('includes consecutive AI messages — both counted individually', () => {
        // msg4 and msg5 are consecutive AI messages in the same turn; N=2 returns both
        const result = resolveHistoryTokens('{{history:[2]:ai}}', chat, 5, {});
        expect(result).toBe('Aria: msg4\n\nAria: msg5');
    });
});

describe('resolveHistoryTokens — :[Name] literal filter', () => {
    const chat = makeChatFull(
        ['Aria',  'msg1'],
        ['Bob',   'msg2'],
        ['Aria',  'msg3'],
        ['Bob',   'msg4'],
        ['Aria',  'msg5'],
    );

    it('returns exactly N messages from the named speaker', () => {
        const result = resolveHistoryTokens('{{history:[2]:[Aria]}}', chat, 5, {});
        expect(result).toBe('Aria: msg3\n\nAria: msg5');
    });

    it('is case-insensitive', () => {
        const result = resolveHistoryTokens('{{history:[2]:[aria]}}', chat, 5, {});
        expect(result).toBe('Aria: msg3\n\nAria: msg5');
    });

    it('returns empty when the named speaker has no messages in range', () => {
        const result = resolveHistoryTokens('{{history:[2]:[Zara]}}', chat, 5, {});
        expect(result).toBe('');
    });
});

describe('resolveHistoryTokens — :[Glob*] wildcard filter', () => {
    const chat = makeChatFull(
        ['Jane',   'msg1'],
        ['Janet',  'msg2'],
        ['Bob',    'msg3'],
        ['Janice', 'msg4'],
        ['Jane',   'msg5'],
    );

    it('matches multiple speakers with a prefix wildcard', () => {
        const result = resolveHistoryTokens('{{history:[3]:[Ja*]}}', chat, 5, {});
        expect(result).toBe('Janet: msg2\n\nJanice: msg4\n\nJane: msg5');
    });

    it('excludes speakers that do not match the glob', () => {
        const result = resolveHistoryTokens('{{history:[10]:[Ja*]}}', chat, 5, {});
        expect(result).not.toContain('Bob');
        expect(result).toContain('Jane: msg1');
        expect(result).toContain('Janet: msg2');
        expect(result).toContain('Janice: msg4');
        expect(result).toContain('Jane: msg5');
    });

    it('wildcard matches are case-insensitive', () => {
        const result = resolveHistoryTokens('{{history:[3]:[ja*]}}', chat, 5, {});
        expect(result).toBe('Janet: msg2\n\nJanice: msg4\n\nJane: msg5');
    });
});

describe('resolveHistoryTokens — :varName filter (name from turn variable)', () => {
    const chat = makeChatFull(
        ['Aria', 'msg1'],
        ['Bob',  'msg2'],
        ['Aria', 'msg3'],
    );

    it('resolves filter name from a turn variable', () => {
        const result = resolveHistoryTokens('{{history:[2]:speaker}}', chat, 3, { speaker: 'Aria' });
        expect(result).toBe('Aria: msg1\n\nAria: msg3');
    });

    it('returns empty when the variable is unset', () => {
        const result = resolveHistoryTokens('{{history:[2]:speaker}}', chat, 3, {});
        expect(result).toBe('');
    });

    it('supports glob patterns from a variable', () => {
        const result = resolveHistoryTokens('{{history:[2]:speaker}}', chat, 3, { speaker: 'A*' });
        expect(result).toBe('Aria: msg1\n\nAria: msg3');
    });
});

// ---------------------------------------------------------------------------
// Edge cases / warnings
// ---------------------------------------------------------------------------

describe('resolveHistoryTokens — edge cases', () => {
    it('logs a warning and returns empty string for bare {{history:}} with no argument', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = resolveHistoryTokens('{{history:}}', [], 0, {});
        expect(result).toBe('');
        expect(warn).toHaveBeenCalledWith('[TRG]', expect.stringContaining('{{history:}}'));
        warn.mockRestore();
    });

    it('returns the template unchanged when chat is null', () => {
        expect(resolveHistoryTokens('{{history:[2]}}', null, 4, {})).toBe('');
    });

    it('returns the template unchanged when template is empty', () => {
        expect(resolveHistoryTokens('', [], 0, {})).toBe('');
    });

    it('returns the template unchanged when template is null', () => {
        expect(resolveHistoryTokens(null, [], 0, {})).toBe(null);
    });

    it('bracket syntax takes priority: [2] is literal 2, not variable lookup', () => {
        // Even if a variable named "2" exists, [2] means literal
        const chat = makeChat(['User', 'a'], ['Char', 'b']);
        const result = resolveHistoryTokens('{{history:[2]}}', chat, 2, { '2': '99' });
        expect(result).toBe('User: a\n\nChar: b');
    });
});
