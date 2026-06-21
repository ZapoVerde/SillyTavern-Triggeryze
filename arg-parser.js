/**
 * @file arg-parser.js
 * @stamp {"utc":"2026-06-21T00:00:00.000Z"}
 * @architectural-role IO — pure filter-argument parsing and matching utilities
 * @description
 * Shared utilities for parsing and evaluating filter arguments used by template tokens
 * ({{lbTitles:…}}, {{psName:…}}, etc.). Handles comma-separated OR lists, explicit AND/OR
 * combinators, {{var}} references, quoted literals, glob patterns, and ! exclusions.
 * Has no IO or state — all functions are pure.
 *
 * @api-declaration
 * parseArg(str)                              → ParsedArg   — parse a raw filter string into an AST
 * resolveArg(parsed, vars)                   → ResolvedArg — expand {{var}} references
 * resolveScalar(str, vars)                   → string|null — resolve a scalar (mode/scope) argument
 * globTest(pattern, str)                     → boolean     — glob match with * and ? wildcards
 * filterMatchesSingle(filter, str)           → boolean     — apply filter to a single string
 * filterMatchesArray(filter, strArray)       → boolean     — apply filter to an array of strings
 *
 * @contract
 *   assertions:
 *     purity:          all functions are pure; no side effects
 *     state_ownership: none
 *     external_io:     none
 */

// ---------------------------------------------------------------------------
// Internal types (JSDoc — not runtime checked)
//
// ParsedItem:   { negate: boolean, kind: 'literal'|'var', value: string }
// ParsedArg:    null | { type: 'OR'|'AND', items: ParsedItem[] }
// ResolvedItem: { negate: boolean, value: string }
// ResolvedArg:  null | { type: 'OR'|'AND', items: ResolvedItem[] }
//
// A null ParsedArg / ResolvedArg means "wildcard" — everything matches.
// An empty items array means "match nothing".
// ---------------------------------------------------------------------------

/**
 * Splits str on commas while respecting single- and double-quoted substrings.
 * "Dragon, the great", Magic  →  ["\"Dragon, the great\"", "Magic"]
 * (Quotes are preserved so _parseItem can detect and strip them.)
 */
function _splitRespectingQuotes(str) {
    const parts = [];
    let cur      = '';
    let inDouble = false;
    let inSingle = false;
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if      (c === '"' && !inSingle) { inDouble = !inDouble; cur += c; }
        else if (c === "'" && !inDouble) { inSingle = !inSingle; cur += c; }
        else if (c === ',' && !inDouble && !inSingle) {
            const t = cur.trim();
            if (t) parts.push(t);
            cur = '';
        } else {
            cur += c;
        }
    }
    const t = cur.trim();
    if (t) parts.push(t);
    return parts;
}

/**
 * Parses one item string (after comma-splitting) into a ParsedItem.
 * Handles: ! prefix (negate), double/single-quoted literals, {{var}}, bare literals.
 */
function _parseItem(raw) {
    let negate = false;
    let s = raw.trim();
    if (s.startsWith('!')) {
        negate = true;
        s = s.slice(1).trim();
    }
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return { negate, kind: 'literal', value: s.slice(1, -1) };
    }
    const varMatch = s.match(/^\{\{([^{}]+)\}\}$/);
    if (varMatch) return { negate, kind: 'var', value: varMatch[1].trim() };
    return { negate, kind: 'literal', value: s };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses a raw filter argument string into a ParsedArg.
 *
 * '' | null | undefined      → null  (wildcard — matches everything)
 * 'Dragon'                   → OR  [ literal Dragon ]
 * 'Dragon, Magic'            → OR  [ literal Dragon, literal Magic ]
 * '"Dragon, beast"'          → OR  [ literal Dragon, beast ]  (comma protected by quotes)
 * '!Dragon'                  → OR  [ !literal Dragon ]
 * '{{myVar}}'                → OR  [ var myVar ]
 * '!{{myVar}}'               → OR  [ !var myVar ]
 * 'OR(Dragon, Magic)'        → OR  [ literal Dragon, literal Magic ]
 * 'AND(sword, !fire)'        → AND [ literal sword, !literal fire ]
 * 'AND("a,b", c)'            → AND [ literal a,b, literal c ]
 */
export function parseArg(str) {
    const t = (str ?? '').trim();
    if (!t) return null;

    const combMatch = t.match(/^(AND|OR)\((.+)\)$/is);
    if (combMatch) {
        const op    = combMatch[1].toUpperCase();
        const items = _splitRespectingQuotes(combMatch[2])
            .map(_parseItem)
            .filter(i => i.value !== '');
        return items.length ? { type: op, items } : null;
    }

    const items = _splitRespectingQuotes(t)
        .map(_parseItem)
        .filter(i => i.value !== '');
    return items.length ? { type: 'OR', items } : null;
}

/**
 * Expands {{var}} references in a ParsedArg using the vars map, returning a ResolvedArg.
 *
 * In OR context, variable values are comma-split into multiple items (multi-value support).
 * In AND context, variable values are treated as atomic (no comma-split).
 * Unresolved variables (missing or empty) contribute no items.
 * Negation from ParsedItem is preserved on each ResolvedItem.
 * Returns null when parsed is null.
 */
export function resolveArg(parsed, vars) {
    if (parsed === null) return null;
    const items = parsed.items.flatMap(item => {
        if (item.kind === 'var') {
            const val = (vars?.[item.value] ?? '').trim();
            if (!val) return [];
            const vals = parsed.type === 'OR'
                ? val.split(',').map(s => s.trim()).filter(Boolean)
                : [val];
            return vals.map(v => ({ negate: item.negate, value: v }));
        }
        return [{ negate: item.negate, value: item.value }];
    });
    return { type: parsed.type, items };
}

/**
 * Resolves a scalar (mode/scope) argument.
 * '' → null (use default); '{{var}}' → vars[var] ?? null; 'literal' → 'literal'
 */
export function resolveScalar(str, vars) {
    const t = (str ?? '').trim();
    if (!t) return null;
    const m = t.match(/^\{\{([^{}]+)\}\}$/);
    if (m) return vars?.[m[1].trim()] || null;
    return t;
}

/**
 * Tests whether pattern glob-matches str.
 * * matches any sequence of characters; ? matches exactly one character.
 * Matching is case-insensitive.
 */
export function globTest(pattern, str) {
    const re = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
        'i',
    );
    return re.test(str);
}

/**
 * Applies a ResolvedArg filter to a single string value (e.g. lorebook name, entry title).
 *
 * null filter           → always true (wildcard)
 * empty items           → always false
 * OR, only exclusions   → true unless any exclusion matches the string
 * OR, with inclusions   → false if any exclusion matches; true if any inclusion matches
 * AND, positive items   → every positive must match; no negative must match
 */
export function filterMatchesSingle(filter, str) {
    if (filter === null) return true;
    const { type, items } = filter;
    if (!items.length) return false;

    const positives = items.filter(i => !i.negate);
    const negatives = items.filter(i =>  i.negate);

    if (type === 'AND') {
        if (negatives.some(i => globTest(i.value, str))) return false;
        return positives.every(i => globTest(i.value, str));
    }

    // OR
    if (negatives.some(i => globTest(i.value, str))) return false;
    if (!positives.length) return true;
    return positives.some(i => globTest(i.value, str));
}

/**
 * Applies a ResolvedArg filter to an array of strings (e.g. a lorebook entry's key array).
 *
 * null filter           → always true (wildcard)
 * empty items           → always false
 * OR, only exclusions   → true unless any key matches any exclusion
 * OR, with inclusions   → false if any key matches any exclusion; true if any key matches any inclusion
 * AND, positive items   → every positive must match at least one key; no negative must match any key
 */
export function filterMatchesArray(filter, strArray) {
    if (filter === null) return true;
    const { type, items } = filter;
    if (!items.length) return false;

    const positives = items.filter(i => !i.negate);
    const negatives = items.filter(i =>  i.negate);

    if (type === 'AND') {
        if (negatives.some(i => strArray.some(s => globTest(i.value, s)))) return false;
        return positives.every(i => strArray.some(s => globTest(i.value, s)));
    }

    // OR
    if (negatives.some(i => strArray.some(s => globTest(i.value, s)))) return false;
    if (!positives.length) return true;
    return positives.some(i => strArray.some(s => globTest(i.value, s)));
}
