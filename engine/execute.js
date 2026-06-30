/**
 * @file st-extensions/SillyTavern-Triggeryze/engine/execute.js
 * @stamp {"utc":"2026-06-30T00:00:00.000Z"}
 * @architectural-role Engine — action execution
 * @description
 * Owns the action-execution loop (executeActions). Each rule evaluator in rule-registry.js
 * calls this once when the rule's triggers are satisfied. Actions within a rule run with
 * promise-based dependency ordering: an action that depends on a prior action's outputVar
 * awaits a varReady promise resolved when that prior action completes.
 *
 * There is no early-fire pass. Rules fire once, when their trigger conditions are met,
 * against the text that is current at that moment. Variable writes go through turn-state
 * and automatically notify any subscribed rule evaluators, producing the reactive cascade.
 *
 * @api-declaration
 * executeActions(rule, stage, execCtx, getGenId) — runs all stage-matching actions for a rule
 *
 * @contract
 *   assertions:
 *     purity:          none — executes action registry entries which have arbitrary IO
 *     state_ownership: none
 *     external_io:     delegates all IO to ACTION_REGISTRY entries
 */

import { stageMatches, resolveStage, getVarDeps }  from './evaluate.js';
import { ACTION_REGISTRY }                          from '../actions/index.js';
import { setTurnVar, getTurnVarsSnapshot }          from '../triggers/turn-vars.js';
import { trgLog, trgDev, trgError }                from '../logger.js';

export async function executeActions(rule, stage, execCtx, getGenId) {
    const stageActions = (rule.actions ?? [])
        .map((a, idx) => ({ a, idx }))
        .filter(({ a }) => stageMatches(resolveStage(ACTION_REGISTRY[a.type], a.config), stage));
    if (!stageActions.length) return;

    const capturedGenId       = getGenId();
    const isCurrentGeneration = () => getGenId() === capturedGenId;
    const vars  = { ...getTurnVarsSnapshot(rule._rulesetId), highlighted: execCtx.highlighted ?? '', 'chat_id': execCtx.stCtx?.chatId ?? '' };
    const debug = rule.devMode ?? false;

    trgDev(debug, `── rule "${rule.name ?? rule.id}" | ${stage} | keyword="${execCtx.matchedKeyword}" ──`);
    trgDev(debug, '  rule json:', JSON.stringify(rule, null, 2));

    const knownVars = new Set(stageActions.map(({ a }) => a.config?.outputVar).filter(Boolean));
    const varReady  = new Map();
    for (const name of knownVars) {
        let resolve;
        varReady.set(name, { promise: new Promise(r => { resolve = r; }), resolve });
    }

    const runOne = async ({ a, idx }) => {
        const deps = getVarDeps(a.config, knownVars);
        trgLog('exec action', { idx, type: a.type, outputVar: a.config?.outputVar, deps });
        if (deps.length) {
            trgDev(debug, `  [${idx}] ${a.type} waiting for: [${deps.join(', ')}]`);
            await Promise.all(deps.map(d => varReady.get(d).promise));
            trgLog('exec action unblocked', { idx, type: a.type, vars: Object.fromEntries(deps.map(d => [d, (vars[d] ?? '').toString().slice(0, 40)])) });
            trgDev(debug, `  [${idx}] ${a.type} unblocked | vars:`, { ...vars });
        }

        const def = ACTION_REGISTRY[a.type];
        if (!def) return;
        trgLog('action', { ruleId: rule.id, type: a.type, actionIdx: idx, ...execCtx });
        try {
            await def.execute(a.config ?? {}, { ...execCtx, ruleId: rule.id, actionIdx: idx, isCurrentGeneration, vars, debug });
        } catch (err) {
            trgError('action', a.type, 'threw', err);
        } finally {
            trgDev(debug, `  [${idx}] ${a.type} done | vars:`, { ...vars });
            if (a.config?.outputVar) {
                if (a.config.outputVar in vars) setTurnVar(a.config.outputVar, vars[a.config.outputVar], rule._rulesetId);
                varReady.get(a.config.outputVar)?.resolve();
            }
        }
    };

    await Promise.all(stageActions.map(runOne));
}
