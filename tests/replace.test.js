import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({
    eventSource:        { emit: vi.fn() },
    event_types:        { MESSAGE_UPDATED: 'MESSAGE_UPDATED', WORLDINFO_UPDATED: 'WORLDINFO_UPDATED' },
    name1:              'Alice',
    name2:              'Bot',
    addOneMessage:      vi.fn(),
    updateMessageBlock: vi.fn(),
    getRequestHeaders:  vi.fn(() => ({})),
}));
vi.mock('../../../../../scripts/openai.js', () => ({ oai_settings: { prompts: [] } }));

vi.mock('../lorebookApi.js', () => ({
    lbGetLorebook:  vi.fn(async () => ({ entries: {} })),
    lbSaveLorebook: vi.fn(async () => {}),
}));

vi.mock('../triggers.js', () => ({
    clearWiCache:         vi.fn(),
    getLbEntryByName:     vi.fn(async () => null),
    resolveLbQueryTokens: vi.fn(async t => t),
    getTurnVarsSnapshot:  vi.fn(() => ({})),
}));

vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

import { update }                               from '../actions/update.js';
import { updateMessageBlock, eventSource }      from '../../../../../script.js';

// ---------------------------------------------------------------------------
// Helpers — mirror the replace config as update(text, replaceKeyword)
// ---------------------------------------------------------------------------

function makeCtx(mesText, overrides = {}) {
    const msg = { mes: mesText, name: 'Char', is_user: false };
    return {
        matchedKeyword:      'dragon',
        messageId:           0,
        stCtx:               { chat: [msg], saveChat: vi.fn(async () => {}) },
        vars:                {},
        debug:               false,
        highlighted:         '',
        isCurrentGeneration: () => true,
        ...overrides,
    };
}

function cfg(value) {
    return { target: 'text', mode: 'replaceKeyword', value };
}

beforeEach(() => { vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// Guard clauses
// ---------------------------------------------------------------------------

describe('update(text, replaceKeyword) — guard clauses', () => {
    it('does nothing when no message exists at messageId', async () => {
        const ctx = makeCtx('irrelevant');
        ctx.stCtx.chat = [];
        await update.execute(cfg('X'), ctx);
        expect(updateMessageBlock).not.toHaveBeenCalled();
    });

    it('does nothing when the keyword is not present in the message', async () => {
        const ctx = makeCtx('A peaceful meadow.');
        await update.execute(cfg('X'), ctx);
        expect(updateMessageBlock).not.toHaveBeenCalled();
        expect(ctx.stCtx.chat[0].mes).toBe('A peaceful meadow.');
    });
});

// ---------------------------------------------------------------------------
// Replacement behaviour
// ---------------------------------------------------------------------------

describe('update(text, replaceKeyword) — keyword substitution', () => {
    it('replaces a single occurrence of the keyword', async () => {
        const ctx = makeCtx('The dragon roars.');
        await update.execute(cfg('beast'), ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('The beast roars.');
    });

    it('replaces ALL occurrences (global flag)', async () => {
        const ctx = makeCtx('A dragon and another dragon.');
        await update.execute(cfg('beast'), ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('A beast and another beast.');
    });

    it('replacement is case-insensitive', async () => {
        const ctx = makeCtx('A DRAGON appeared.');
        await update.execute(cfg('beast'), ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('A beast appeared.');
    });

    it('preserves surrounding text', async () => {
        const ctx = makeCtx('Before dragon after.');
        await update.execute(cfg('serpent'), ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('Before serpent after.');
    });

    it('empty value string deletes the keyword', async () => {
        const ctx = makeCtx('A dragon appeared.');
        await update.execute(cfg(''), ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('A  appeared.');
    });

    it('value containing {{keyword}} interpolates the matched keyword', async () => {
        const ctx = makeCtx('A dragon roared.', { matchedKeyword: 'dragon' });
        await update.execute(cfg('[{{keyword}}]'), ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('A [dragon] roared.');
    });

    it('escapes regex special characters in the keyword so they are matched literally', async () => {
        const ctx = makeCtx('price is $5 today.', { matchedKeyword: '$5' });
        await update.execute(cfg('ten'), ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('price is ten today.');
    });
});

// ---------------------------------------------------------------------------
// Side-effects: updateMessageBlock, saveChat, eventSource
// ---------------------------------------------------------------------------

describe('update(text, replaceKeyword) — side effects', () => {
    it('calls updateMessageBlock after a successful replacement', async () => {
        const ctx = makeCtx('A dragon appeared.');
        await update.execute(cfg('beast'), ctx);
        expect(updateMessageBlock).toHaveBeenCalledWith(0, ctx.stCtx.chat[0]);
    });

    it('calls saveChat after a successful replacement', async () => {
        const ctx = makeCtx('A dragon appeared.');
        await update.execute(cfg('beast'), ctx);
        expect(ctx.stCtx.saveChat).toHaveBeenCalledOnce();
    });

    it('emits MESSAGE_UPDATED after a successful replacement', async () => {
        const ctx = makeCtx('A dragon appeared.');
        await update.execute(cfg('beast'), ctx);
        expect(eventSource.emit).toHaveBeenCalledWith('MESSAGE_UPDATED', 0);
    });

    it('does not call updateMessageBlock when text is unchanged', async () => {
        const ctx = makeCtx('No keyword here.');
        await update.execute(cfg('X'), ctx);
        expect(updateMessageBlock).not.toHaveBeenCalled();
        expect(ctx.stCtx.saveChat).not.toHaveBeenCalled();
    });

    it('does not call saveChat when stCtx.saveChat is not a function', async () => {
        const ctx = makeCtx('A dragon appeared.');
        ctx.stCtx.saveChat = null;
        await expect(
            update.execute(cfg('beast'), ctx),
        ).resolves.toBeUndefined();
    });
});
