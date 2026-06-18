/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/text.js
 * @stamp {"utc":"2026-06-18T00:00:00.000Z"}
 * @architectural-role IO — text and paragraph utilities shared across action implementations
 * @description
 * Pure helpers for HTML escaping, async task queuing, chat history formatting,
 * and paragraph-boundary extraction. No external IO; no state.
 *
 * @api-declaration
 * esc(s)                                         — HTML-escapes a string for safe DOM insertion
 * runQueued(taskFns, concurrency)                — runs async task functions with capped concurrency
 * buildHistoryText(chat, beforeIndex, n, filter?, vars?) — formats N messages before beforeIndex as "Name: mes" blocks;
 *                                                  filter='user'|'ai'|'[Glob]'|varName selects by role or speaker name
 * extractParagraph(text, matchIndex)             — returns { text, start, end } of newline-bounded paragraph at matchIndex
 * collectUniqueParagraphs(text, re)              — returns all unique paragraphs containing a regex match, in order
 *
 * @contract
 *   assertions:
 *     purity:          all functions are pure (no IO, no state)
 *     state_ownership: none
 *     external_io:     none
 */

export function esc(s) { return $('<span>').text(s ?? '').html(); }

/**
 * Runs async task functions with capped concurrency, preserving result order.
 * concurrency=1 gives serial execution (safe when the underlying call uses
 * shared global state, e.g. generateQuietPrompt / generateRaw).
 */
export function runQueued(taskFns, concurrency = 1) {
    return new Promise(resolve => {
        const results = new Array(taskFns.length).fill(null);
        let nextIdx = 0, done = 0, running = 0;
        if (!taskFns.length) { resolve(results); return; }
        function kick() {
            while (running < concurrency && nextIdx < taskFns.length) {
                const i = nextIdx++;
                running++;
                taskFns[i]()
                    .then(r  => { results[i] = r ?? null; })
                    .catch(() => { results[i] = null; })
                    .finally(() => { running--; done++; if (done === taskFns.length) resolve(results); else kick(); });
            }
        }
        kick();
    });
}

/**
 * Builds a formatted transcript of messages before `beforeIndex`.
 * Format: "Name: message" blocks joined by double newlines.
 *
 * Without a filter: returns N turn-pairs (approximated as N*2 messages).
 * With a filter: walks backwards collecting exactly N messages that match.
 *   filter='user'     — only user messages (is_user === true)
 *   filter='ai'       — only AI messages (is_user === false, not system)
 *   filter='[Glob]'   — literal name match, * is a wildcard (case-insensitive)
 *   filter='varName'  — look up name pattern from vars
 */
export function buildHistoryText(chat, beforeIndex, numPairs, filter = null, vars = {}) {
    if (!numPairs || numPairs <= 0 || !chat?.length) return '';

    if (filter !== null) {
        const result = [];
        for (let i = beforeIndex - 1; i >= 0 && result.length < numPairs; i--) {
            const m = chat[i];
            if (m.is_system) continue;
            if (_msgMatchesFilter(m, filter, vars)) result.unshift(m);
        }
        return result.map(m => `${m.name ?? 'Unknown'}: ${m.mes ?? ''}`).join('\n\n');
    }

    const start = Math.max(0, beforeIndex - numPairs * 2);
    const slice = chat.slice(start, beforeIndex);
    if (!slice.length) return '';
    return slice.map(m => `${m.name ?? 'Unknown'}: ${m.mes ?? ''}`).join('\n\n');
}

function _msgMatchesFilter(msg, filter, vars) {
    if (filter === 'user') return msg.is_user === true;
    if (filter === 'ai')   return msg.is_user === false && msg.is_system !== true;

    let pattern;
    if (filter.startsWith('[') && filter.endsWith(']')) {
        pattern = filter.slice(1, -1);
    } else {
        pattern = vars?.[filter] ?? '';
        if (!pattern) return false;
    }
    return _nameMatchesGlob(msg.name ?? '', pattern);
}

function _nameMatchesGlob(name, pattern) {
    if (!pattern.includes('*')) return name.toLowerCase() === pattern.toLowerCase();
    const escaped = pattern.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    const re = new RegExp('^' + escaped.replace(/\\\*/g, '.*') + '$', 'i');
    return re.test(name);
}

/** Returns { text, start, end } of the newline-bounded paragraph at matchIndex. */
export function extractParagraph(text, matchIndex) {
    const start = text.lastIndexOf('\n', matchIndex - 1) + 1;
    const nlEnd  = text.indexOf('\n', matchIndex);
    const end    = nlEnd === -1 ? text.length : nlEnd;
    return { text: text.slice(start, end), start, end };
}

/** Returns all unique paragraphs (by start index) that contain a regex match, in order. */
export function collectUniqueParagraphs(text, re) {
    const seen = new Map();
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        const p = extractParagraph(text, m.index);
        if (!seen.has(p.start)) seen.set(p.start, p);
    }
    return [...seen.values()].sort((a, b) => a.start - b.start);
}
