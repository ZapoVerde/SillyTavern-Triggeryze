import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({
    eventSource:        { emit: vi.fn() },
    event_types:        { MESSAGE_UPDATED: 'MESSAGE_UPDATED' },
    updateMessageBlock: vi.fn(),
    addOneMessage:      vi.fn(),
}));

import {
    makeSave,
    applyReplaceKeyword,
    applyReplaceParagraph,
    applyPrepend,
    applyAppend,
    applyReplaceMessage,
    applyInsertMessage,
} from '../actions/text-ops.js';
import { updateMessageBlock, addOneMessage, eventSource } from '../../../../../script.js';

beforeEach(() => { vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// makeSave
// ---------------------------------------------------------------------------

describe('makeSave', () => {
    function makeStCtx() {
        return { chat: [{ mes: 'hello' }], saveChat: vi.fn(async () => {}) };
    }

    it('calls updateMessageBlock with messageId and msg', async () => {
        const msg   = { mes: 'hello' };
        const stCtx = makeStCtx();
        const save  = makeSave(() => true, 0, msg, stCtx);
        await save();
        expect(updateMessageBlock).toHaveBeenCalledWith(0, msg);
    });

    it('calls stCtx.saveChat', async () => {
        const stCtx = makeStCtx();
        const save  = makeSave(() => true, 0, {}, stCtx);
        await save();
        expect(stCtx.saveChat).toHaveBeenCalledOnce();
    });

    it('emits MESSAGE_UPDATED with messageId', async () => {
        const stCtx = makeStCtx();
        const save  = makeSave(() => true, 3, {}, stCtx);
        await save();
        expect(eventSource.emit).toHaveBeenCalledWith('MESSAGE_UPDATED', 3);
    });

    it('does nothing when isCurrentGeneration returns false', async () => {
        const stCtx = makeStCtx();
        const save  = makeSave(() => false, 0, {}, stCtx);
        await save();
        expect(updateMessageBlock).not.toHaveBeenCalled();
        expect(stCtx.saveChat).not.toHaveBeenCalled();
        expect(eventSource.emit).not.toHaveBeenCalled();
    });

    it('runs normally when isCurrentGeneration is not provided', async () => {
        const stCtx = makeStCtx();
        const save  = makeSave(null, 0, {}, stCtx);
        await save();
        expect(updateMessageBlock).toHaveBeenCalledOnce();
    });
});

// ---------------------------------------------------------------------------
// applyReplaceKeyword
// ---------------------------------------------------------------------------

describe('applyReplaceKeyword', () => {
    const mkRe = () => /dragon/gi;

    it('replaces all occurrences', () => {
        expect(applyReplaceKeyword('dragon and dragon', mkRe, 'beast')).toBe('beast and beast');
    });

    it('is case-insensitive', () => {
        expect(applyReplaceKeyword('A DRAGON roared.', mkRe, 'serpent')).toBe('A serpent roared.');
    });

    it('returns the string unchanged when the keyword is absent', () => {
        expect(applyReplaceKeyword('no match here', mkRe, 'x')).toBe('no match here');
    });
});

// ---------------------------------------------------------------------------
// applyReplaceParagraph
// ---------------------------------------------------------------------------

describe('applyReplaceParagraph', () => {
    const mkRe = () => /dragon/gi;

    it('returns null when the keyword is not found', () => {
        expect(applyReplaceParagraph('no match here', mkRe, 'x')).toBeNull();
    });

    it('replaces the paragraph containing the keyword', () => {
        const result = applyReplaceParagraph('A dragon roared.\nA knight rode.', mkRe, '[replaced]');
        expect(result).toBe('[replaced]\nA knight rode.');
    });

    it('replaces multiple paragraphs when the keyword appears in each', () => {
        const result = applyReplaceParagraph('dragon here.\nanother dragon.\nno match.', mkRe, 'X');
        expect(result).toBe('X\nX\nno match.');
    });

    it('replaces each paragraph once even when the keyword appears twice in it', () => {
        const result = applyReplaceParagraph('dragon and dragon here.', mkRe, '[p]');
        expect(result).toBe('[p]');
    });
});

// ---------------------------------------------------------------------------
// applyPrepend
// ---------------------------------------------------------------------------

describe('applyPrepend', () => {
    it('places value before the message with a double newline separator', () => {
        expect(applyPrepend('Original.', 'Prefix.')).toBe('Prefix.\n\nOriginal.');
    });

    it('works on an empty message', () => {
        expect(applyPrepend('', 'Prefix.')).toBe('Prefix.\n\n');
    });
});

// ---------------------------------------------------------------------------
// applyAppend
// ---------------------------------------------------------------------------

describe('applyAppend', () => {
    it('places value after the message with a double newline separator', () => {
        expect(applyAppend('Original.', 'Suffix.')).toBe('Original.\n\nSuffix.');
    });

    it('works on an empty message', () => {
        expect(applyAppend('', 'Suffix.')).toBe('\n\nSuffix.');
    });
});

// ---------------------------------------------------------------------------
// applyReplaceMessage
// ---------------------------------------------------------------------------

describe('applyReplaceMessage', () => {
    it('returns the value regardless of the original message', () => {
        expect(applyReplaceMessage('old content', 'new content')).toBe('new content');
    });

    it('returns empty string when value is empty', () => {
        expect(applyReplaceMessage('old content', '')).toBe('');
    });
});

// ---------------------------------------------------------------------------
// applyInsertMessage
// ---------------------------------------------------------------------------

describe('applyInsertMessage', () => {
    function makeStCtx(mes = 'Original.') {
        return { chat: [{ mes }], saveChat: vi.fn(async () => {}) };
    }

    it('splices a new message into chat at messageId + 1', async () => {
        const stCtx = makeStCtx();
        await applyInsertMessage(stCtx, 0, 'New message.', 'Bot');
        expect(stCtx.chat).toHaveLength(2);
        expect(stCtx.chat[1].mes).toBe('New message.');
    });

    it('new message is not a user or system message', async () => {
        const stCtx = makeStCtx();
        await applyInsertMessage(stCtx, 0, 'Hello.', 'Bot');
        expect(stCtx.chat[1].is_user).toBe(false);
        expect(stCtx.chat[1].is_system).toBe(false);
    });

    it('new message carries the supplied charName', async () => {
        const stCtx = makeStCtx();
        await applyInsertMessage(stCtx, 0, 'Hello.', 'Aria');
        expect(stCtx.chat[1].name).toBe('Aria');
    });

    it('calls addOneMessage with insertAfter: messageId', async () => {
        const stCtx = makeStCtx();
        await applyInsertMessage(stCtx, 2, 'Hello.', 'Bot');
        expect(addOneMessage).toHaveBeenCalledWith(
            expect.objectContaining({ mes: 'Hello.' }),
            expect.objectContaining({ insertAfter: 2 }),
        );
    });

    it('calls stCtx.saveChat', async () => {
        const stCtx = makeStCtx();
        await applyInsertMessage(stCtx, 0, 'Hello.', 'Bot');
        expect(stCtx.saveChat).toHaveBeenCalledOnce();
    });
});
