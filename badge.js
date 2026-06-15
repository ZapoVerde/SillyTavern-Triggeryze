/**
 * @file st-extensions/SillyTavern-Triggeryze/badge.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role UI — per-message status badge and rule badge buttons
 * @description
 * Injects a small status pill after each AI message's .ch_name row.
 * States: unchanged (neutral) | thinking (red pulse) | modified (green).
 * Also renders per-rule manual-trigger badge buttons for badgeTrigger rules.
 *
 * @api-declaration
 * ensureBadge(messageId)             — injects badge if not present; no-op for user messages
 * setBadge(messageId, state)         — 'unchanged' | 'thinking' | 'modified'
 * renderRuleBadges(messageId, defs)  — renders rule badge buttons for a message
 * removeAllBadges()                  — strips all badges from DOM (called on disable)
 * reinjectAllBadges()                — refreshes all AI messages (called on chat change)
 *
 * @contract
 *   assertions:
 *     purity:          UI only — no rule evaluation, no settings mutation
 *     state_ownership: none
 *     external_io:     DOM (.mes[mesid] .ch_name)
 */

import { extension_settings } from '../../../extensions.js';

const EXT_NAME = 'triggeryze';

function isEnabled() {
    return extension_settings[EXT_NAME]?.showBadges !== false;
}

function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

const ICONS = {
    unchanged: 'fa-bolt',
    thinking:  'fa-circle-notch fa-spin',
    modified:  'fa-pen',
};

export function ensureBadge(messageId) {
    if (!isEnabled()) return;
    const $mes = $(`.mes[mesid="${messageId}"]`);
    if (!$mes.length) return;

    const stCtx = window.SillyTavern?.getContext?.();
    if (stCtx?.chat?.[messageId]?.is_user) return;

    if ($mes.find('.trg-badge').length) return;

    const $badge = $(`
<div class="trg-badge trg-badge-unchanged">
    <i class="fa-solid ${ICONS.unchanged}"></i>
    <span class="trg-badge-text">unchanged</span>
</div>`);
    const $chName = $mes.find('.ch_name');
    if ($chName.length) $chName.after($badge);
}

export function setBadge(messageId, state) {
    ensureBadge(messageId);
    const $badge = $(`.mes[mesid="${messageId}"] .trg-badge`);
    if (!$badge.length) return;
    $badge
        .removeClass('trg-badge-unchanged trg-badge-thinking trg-badge-modified')
        .addClass(`trg-badge-${state}`);
    $badge.find('i').attr('class', `fa-solid ${ICONS[state] ?? ICONS.unchanged}`);
    $badge.find('.trg-badge-text').text(state);
}

/**
 * Render per-rule clickable badge buttons next to the status badge for a message.
 * defs: [{ ruleId, label, color }]  — pass [] to clear existing rule badges.
 */
export function renderRuleBadges(messageId, defs) {
    if (!isEnabled()) return;
    const $mes = $(`.mes[mesid="${messageId}"]`);
    if (!$mes.length) return;
    const stCtx = window.SillyTavern?.getContext?.();
    if (stCtx?.chat?.[messageId]?.is_user) return;

    $mes.find('.trg-rule-badge').remove();
    if (!defs?.length) return;

    const $chName = $mes.find('.ch_name');
    if (!$chName.length) return;

    // Insert after the status badge if present, else after .ch_name; maintain order.
    let $ref = $mes.find('.trg-badge').length ? $mes.find('.trg-badge') : $chName;
    for (const { ruleId, label, color } of defs) {
        const safeColor = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#8888ff';
        const $btn = $(`<button class="trg-rule-badge"
            data-rule-id="${esc(ruleId)}"
            data-mesid="${messageId}"
            style="background:${hexToRgba(safeColor, .15)};border-color:${hexToRgba(safeColor, .45)};color:${safeColor}"
            title="Run: ${esc(label || 'run')}">${esc(label || 'run')}</button>`);
        $ref.after($btn);
        $ref = $btn;
    }
}

export function removeAllBadges() {
    $('.trg-badge, .trg-rule-badge').remove();
}

export function reinjectAllBadges() {
    const stCtx = window.SillyTavern?.getContext?.();
    if (!stCtx?.chat) return;
    stCtx.chat.forEach((_msg, idx) => ensureBadge(idx));
}
