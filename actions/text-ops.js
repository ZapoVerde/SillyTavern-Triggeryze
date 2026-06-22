/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/text-ops.js
 * @stamp {"utc":"2026-06-22T00:00:00.000Z"}
 * @architectural-role IO — shared message-mutation helpers for update and sideCall
 * @description
 * Pure string-level mutation functions and a save-helper factory shared by update.js
 * and side-call.js. All functions that modify message text are pure (accept the current
 * string, return the new one; caller assigns to msg.mes). applyInsertMessage is the
 * exception — it splices into stCtx.chat and calls addOneMessage, so it is async and
 * impure. applyReplaceParagraph returns null when the regex matches no paragraph, so
 * the caller can early-return without calling save.
 *
 * @api-declaration
 * makeSave(isCurrentGeneration, messageId, msg, stCtx) → async () → void
 * applyReplaceKeyword(mes, mkRe, value) → string
 * applyReplaceParagraph(mes, mkRe, value) → string | null
 * applyPrepend(mes, value) → string
 * applyAppend(mes, value) → string
 * applyReplaceMessage(_mes, value) → string
 * applyInsertMessage(stCtx, messageId, value, charName) → Promise<void>
 *
 * @contract
 *   assertions:
 *     purity:          mixed — string ops are pure; makeSave result and applyInsertMessage are impure
 *     state_ownership: none
 *     external_io:     updateMessageBlock, addOneMessage, eventSource, stCtx.saveChat
 */

import { eventSource, event_types, addOneMessage, updateMessageBlock } from '../../../../../script.js';
import { collectUniqueParagraphs } from './text.js';

export function makeSave(isCurrentGeneration, messageId, msg, stCtx) {
    return async () => {
        if (isCurrentGeneration && !isCurrentGeneration()) return;
        updateMessageBlock(messageId, msg);
        if (typeof stCtx.saveChat === 'function') await stCtx.saveChat();
        eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
    };
}

export function applyReplaceKeyword(mes, mkRe, value) {
    return mes.replace(mkRe(), value);
}

/** Returns null when the regex matches no paragraph — caller should early-return without saving. */
export function applyReplaceParagraph(mes, mkRe, value) {
    const paragraphs = collectUniqueParagraphs(mes, mkRe());
    if (!paragraphs.length) return null;
    let built = mes;
    for (let i = paragraphs.length - 1; i >= 0; i--)
        built = built.slice(0, paragraphs[i].start) + value + built.slice(paragraphs[i].end);
    return built;
}

export function applyPrepend(mes, value) {
    return value + '\n\n' + mes;
}

export function applyAppend(mes, value) {
    return mes + '\n\n' + value;
}

// eslint-disable-next-line no-unused-vars
export function applyReplaceMessage(_mes, value) {
    return value;
}

export async function applyInsertMessage(stCtx, messageId, value, charName) {
    const newMsg = {
        name: charName, is_user: false, is_system: false,
        send_date: new Date().toLocaleString(),
        mes: value, extra: {}, swipe_id: 0, swipes: [value],
    };
    stCtx.chat.splice(messageId + 1, 0, newMsg);
    addOneMessage(newMsg, { insertAfter: messageId, scroll: true });
    if (typeof stCtx.saveChat === 'function') await stCtx.saveChat();
}
