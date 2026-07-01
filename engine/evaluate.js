/**
 * @file st-extensions/SillyTavern-Triggeryze/engine/evaluate.js
 * @stamp {"utc":"2026-07-01T00:00:00.000Z"}
 * @architectural-role Engine — stateless trigger and rule evaluation utilities
 * @description
 * Pure evaluation helpers used throughout the rule loop. Trigger testing, AND/OR
 * combinator logic, and template variable dependency resolution.
 * No state, no IO of its own — all side effects belong in callers.
 *
 * @api-declaration
 * evaluateTriggers(rule, text)        — tests all rule triggers; returns matched keyword or null
 * getVarDeps(config, knownVars)       — returns config template vars that are in knownVars
 *
 * @contract
 *   assertions:
 *     purity:          impure — trigger.test is async and may call ST world-info APIs
 *     state_ownership: none
 *     external_io:     TRIGGER_REGISTRY.test (may read lorebook via ST APIs)
 */

import { TRIGGER_REGISTRY } from '../triggers.js';
import { trgWarn, trgDev }  from '../logger.js';

async function runTrigger(trigger, text, rulesetId) {
    const def = TRIGGER_REGISTRY[trigger.type];
    if (!def) return null;
    try { return await def.test(text, trigger.config ?? {}, rulesetId); }
    catch (err) { trgWarn('trigger', trigger.type, 'threw', err); return null; }
}

export async function evaluateTriggers(rule, text) {
    if (!rule.triggers?.length) return null;
    const debug     = rule.devMode ?? false;
    const rulesetId = rule._rulesetId;

    trgDev(debug, `  evaluate "${rule.name ?? rule.id}" | text: ${JSON.stringify(text.slice(0, 200))}${text.length > 200 ? '…' : ''}`);

    if (rule.when === 'all') {
        const results = await Promise.all(rule.triggers.map(t => runTrigger(t, text, rulesetId)));
        results.forEach((r, i) => trgDev(debug, `  trigger[${i}] (${rule.triggers[i].type}):`, r ?? 'no match'));
        return results.every(r => r !== null) ? (results.find(r => r !== null) ?? null) : null;
    }

    for (let i = 0; i < rule.triggers.length; i++) {
        const matched = await runTrigger(rule.triggers[i], text, rulesetId);
        trgDev(debug, `  trigger[${i}] (${rule.triggers[i].type}):`, matched ?? 'no match');
        if (matched !== null) return matched;
    }
    return null;
}

export function getVarDeps(config, knownVars) {
    if (!knownVars.size) return [];
    const text = Object.values(config ?? {}).filter(v => typeof v === 'string').join(' ');
    const templateDeps = [...text.matchAll(/\{\{([^{}]+)\}\}/g)].map(m => m[1].trim());
    // {{mapLines: sep : sourceName}} — source is a bare var name, not wrapped in {{}}
    const mapLinesDeps = [];
    for (const m of text.matchAll(/\{\{mapLines((?:[^}])*)\}\}/g)) {
        const parts = m[1].slice(1).split(' : ');
        if (parts.length >= 2) mapLinesDeps.push(parts.slice(1).join(' : ').trim());
    }
    return [...new Set([...templateDeps, ...mapLinesDeps])].filter(n => knownVars.has(n));
}
