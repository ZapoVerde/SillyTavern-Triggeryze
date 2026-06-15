/**
 * @file st-extensions/SillyTavern-Triggeryze/inline-badge.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role UI — inline keyword badge injection into rendered message text
 * @description
 * Scans rendered AI message text for keyword matches from inlineBadge rules and
 * wraps each match in a clickable <span class="trg-inline-badge">. Does not fire
 * any rules itself — click handling lives in index.js, which calls fireRuleManually.
 * Injection is idempotent: a strip pass runs before each inject pass.
 *
 * @api-declaration
 * injectInlineBadges(messageId, defs)  — strip and re-inject for one message
 * removeAllInlineBadges()              — unwrap all inline badges across the DOM
 * reinjectAllInlineBadges(defs)        — re-inject for every AI message in chat
 *
 * @contract
 *   assertions:
 *     purity:          UI only — no rule evaluation, no settings mutation
 *     state_ownership: none
 *     external_io:     DOM (.mes[mesid] .mes_text)
 */

import { extension_settings }                               from '../../../extensions.js';
import { resolveLbQueryTokens, getTurnVarsSnapshot }        from './triggers.js';

const EXT_NAME = 'triggeryze';

function _expandKwVars(str, snapshot) {
    return str.replace(/\{\{([^{}]+)\}\}/g, (_, k) => {
        const v = snapshot[k.trim()];
        return v !== undefined ? String(v) : '';
    });
}

function isEnabled() {
    return extension_settings[EXT_NAME]?.showBadges !== false;
}

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function stripInlineBadges(root) {
    for (const span of root.querySelectorAll('.trg-inline-badge')) {
        span.replaceWith(document.createTextNode(span.textContent));
    }
    root.normalize();
}

function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (node.parentElement?.closest('pre, code, .trg-inline-badge')) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
}

function buildKeywordPatterns(defs) {
    const patterns = [];
    for (const def of defs) {
        const kws = (def.keywords ?? '').split(',').map(k => k.trim()).filter(Boolean);
        const safeColor = def.color && /^#[0-9a-fA-F]{6}$/.test(def.color) ? def.color : '#8888ff';
        for (const kw of kws) {
            const esc = kw.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                          .replace(/\*/g, '.*')
                          .replace(/\?/g, '.');
            patterns.push({
                re:     new RegExp(esc, def.caseSensitive ? 'g' : 'gi'),
                ruleId: def.ruleId,
                color:  safeColor,
            });
        }
    }
    return patterns;
}

function findMatches(text, patterns) {
    const raw = [];
    for (const { re, ruleId, color } of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            raw.push({ start: m.index, end: m.index + m[0].length, matched: m[0], ruleId, color });
            if (m[0].length === 0) { re.lastIndex++; break; }
        }
    }
    // Sort by position; on tie, prefer longer match
    raw.sort((a, b) => a.start - b.start || b.end - a.end);
    // Remove overlapping matches — first non-overlapping wins
    const result = [];
    let cursor = 0;
    for (const m of raw) {
        if (m.start >= cursor) { result.push(m); cursor = m.end; }
    }
    return result;
}

function replaceTextNode(node, matches) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const m of matches) {
        if (m.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, m.start)));
        const span = document.createElement('span');
        span.className        = 'trg-inline-badge';
        span.dataset.ruleId   = m.ruleId;
        span.dataset.kw       = m.matched;
        span.textContent      = m.matched;
        span.style.cssText    = `background:${hexToRgba(m.color, .15)};border-color:${hexToRgba(m.color, .45)};color:${m.color}`;
        frag.appendChild(span);
        pos = m.end;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
}

/** Inject pre-built patterns into an already-obtained element (no async, no strip pass). */
export function injectPatternsIntoEl(el, patterns) {
    if (!patterns?.length) return;
    for (const node of collectTextNodes(el)) {
        if (!node.parentNode) continue;
        const matches = findMatches(node.nodeValue ?? '', patterns);
        if (matches.length) replaceTextNode(node, matches);
    }
}

/** Resolve keyword strings in defs against LB data and turn vars, return ready patterns. */
export async function buildResolvedPatterns(defs) {
    if (!defs?.length) return [];
    const snapshot = getTurnVarsSnapshot();
    const resolvedDefs = await Promise.all(defs.map(async def => {
        const afterLb  = await resolveLbQueryTokens(def.keywords ?? '', snapshot);
        const keywords = _expandKwVars(afterLb, snapshot);
        return { ...def, keywords };
    }));
    return buildKeywordPatterns(resolvedDefs);
}

export async function injectInlineBadges(messageId, defs) {
    if (!isEnabled() || !defs?.length) return;
    const mesText = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    if (!mesText) return;

    stripInlineBadges(mesText);

    const patterns = await buildResolvedPatterns(defs);
    if (!patterns.length) return;

    injectPatternsIntoEl(mesText, patterns);
}

export function removeAllInlineBadges() {
    for (const span of document.querySelectorAll('.trg-inline-badge')) {
        span.replaceWith(document.createTextNode(span.textContent));
    }
}

export function reinjectAllInlineBadges(defs) {
    const stCtx = window.SillyTavern?.getContext?.();
    if (!stCtx?.chat) return;
    stCtx.chat.forEach((_msg, idx) => injectInlineBadges(idx, defs));
}
