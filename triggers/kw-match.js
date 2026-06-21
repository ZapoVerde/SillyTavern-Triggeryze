/**
 * @file triggers/kw-match.js
 * @stamp {"utc":"2026-06-21T00:00:00.000Z"}
 * @architectural-role IO — keyword and regex matching shared across trigger and badge entries
 * @description
 * Centralised text-matching utilities for keyword triggers and inline badges.
 * Owns glob-to-regex conversion, /pattern/flags parsing, single-keyword matching,
 * regex testing, and all-match span enumeration (used by the UI test drawer).
 * No external state is read; all functions are pure.
 *
 * @api-declaration
 * globToRegex(pattern, caseSensitive)                           → RegExp
 * parseRegexPattern(str)                                        → RegExp | null
 * matchKeyword(text, kw, caseSensitive)                         → string | null
 * testRegex(text, patternStr)                                   → string | null
 * findAllMatches(text, { useRegex, pattern,
 *                        resolvedKeywords, caseSensitive })      → [{start,end,value}]
 *
 * @contract
 *   assertions:
 *     purity:          pure — no side effects, no external reads
 *     state_ownership: none
 *     external_io:     none
 */

/** Converts a glob pattern (* / ?) to a RegExp. * matches word chars; ? matches exactly one. */
export function globToRegex(pattern, caseSensitive) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                           .replace(/\*/g, '\\w*')
                           .replace(/\?/g, '\\w');
    return new RegExp(escaped, caseSensitive ? '' : 'i');
}

/**
 * Parses a /pattern/flags string → RegExp, or treats a plain string as a case-insensitive
 * literal pattern. Returns null if the input is empty or produces an invalid RegExp.
 */
export function parseRegexPattern(str) {
    if (!str) return null;
    const m = str.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (m) {
        try { return new RegExp(m[1], m[2]); } catch { return null; }
    }
    try { return new RegExp(str, 'i'); } catch { return null; }
}

/** Matches text against one keyword (literal or glob). Returns the matched string or null. */
export function matchKeyword(text, kw, caseSensitive) {
    if (kw.includes('*') || kw.includes('?')) {
        const re = globToRegex(kw, caseSensitive);
        const m  = re.exec(text);
        return m ? m[0] : null;
    }
    const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, caseSensitive ? '' : 'i');
    return re.test(text) ? kw : null;
}

/** Tests text against a pattern string. Returns capture group 1, full match, or null. */
export function testRegex(text, patternStr) {
    const re = parseRegexPattern(patternStr);
    if (!re) return null;
    const m = re.exec(text);
    return m ? (m[1] ?? m[0]) : null;
}

/**
 * Finds ALL match positions in text for UI highlighting (test drawer).
 * Returns [{start, end, value}] sorted by start, overlaps removed.
 *
 * Regex mode:   pass { useRegex:true, pattern }
 * Keyword mode: pass { resolvedKeywords:[...], caseSensitive }
 *   — resolvedKeywords must already be variable-expanded by the caller.
 */
export function findAllMatches(text, { useRegex, pattern, resolvedKeywords, caseSensitive }) {
    const spans = [];

    if (useRegex) {
        const re = parseRegexPattern(pattern ?? '');
        if (!re) return [];
        const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
        const gRe   = new RegExp(re.source, flags);
        let m;
        while ((m = gRe.exec(text)) !== null) {
            spans.push({ start: m.index, end: m.index + m[0].length, value: m[1] ?? m[0] });
            if (m[0].length === 0) gRe.lastIndex++;
        }
        return spans;
    }

    const cs = caseSensitive ?? false;
    for (const kw of (resolvedKeywords ?? [])) {
        let re;
        if (kw.includes('*') || kw.includes('?')) {
            const esc = kw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '\\w*').replace(/\?/g, '\\w');
            re = new RegExp(esc, cs ? 'g' : 'gi');
        } else {
            re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, cs ? 'g' : 'gi');
        }
        let m;
        while ((m = re.exec(text)) !== null) {
            spans.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
            if (m[0].length === 0) re.lastIndex++;
        }
    }

    spans.sort((a, b) => a.start - b.start);
    let cursor = 0;
    return spans.filter(s => { if (s.start >= cursor) { cursor = s.end; return true; } return false; });
}
