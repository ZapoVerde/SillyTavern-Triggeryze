/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/preset.js
 * @stamp {"utc":"2026-06-20T00:00:00.000Z"}
 * @architectural-role Registry — preset action (PromptManager named prompt write/clear/remove)
 * @description
 * Creates or updates a named prompt entry in ST's PromptManager, enabling rules to inject
 * persistent text into the CC prompt stack between turns. On first creation always fires a
 * toastr so orphan prompts are never invisible. Exports listTrgPresets() and reportTrgPresets()
 * for use by the chat-load audit in index.js.
 *
 * Both name and content support {{variable}} interpolation. The prompt id is derived from the
 * resolved name (trg_preset_<slug>), so a name that resolves differently each turn produces a
 * different slot each turn.
 *
 * @api-declaration
 * preset               — action definition object for the ACTION_REGISTRY
 * listTrgPresets(pm)   — returns names of all TRG-owned prompts from the given PromptManager
 * reportTrgPresets()   — fires a toastr listing active TRG presets; no-op if none exist
 *
 * @contract
 *   assertions:
 *     purity:          none — writes to promptManager, calls window.toastr
 *     state_ownership: none
 *     external_io:     promptManager (scripts/openai.js), window.toastr
 */

import { name1, name2 }                from '../../../../../script.js';
import { promptManager }               from '../../../../../scripts/openai.js';
import { interpolate, resolveLbTokens } from './template.js';
import { esc }                          from './text.js';
import { trgWarn, trgDev }             from '../logger.js';

const TRG_PRESET_PREFIX = 'trg_preset_';

function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

function presetId(name) {
    return TRG_PRESET_PREFIX + slugify(name);
}

/**
 * Ensures the named prompt exists in pm. Returns true if it was just created,
 * false if it was already present.
 */
export function ensureTrgPreset(pm, id, name) {
    if (pm.getPromptById(id)) return false;
    pm.addPrompt({ name, content: '', role: 'system', enabled: true }, id);
    const order = pm.getPromptOrderForCharacter(pm.activeCharacter);
    const idx   = order.findIndex(e => e.identifier === 'chatHistory');
    if (idx !== -1) order.splice(idx, 0, { identifier: id, enabled: true });
    else            order.push({ identifier: id, enabled: true });
    pm.saveServiceSettings();
    return true;
}

/** Returns the human-readable names of all TRG-owned prompts from the given PromptManager. */
export function listTrgPresets(pm) {
    if (!pm) return [];
    return (pm.serviceSettings?.prompts ?? [])
        .filter(p => (p.identifier ?? '').startsWith(TRG_PRESET_PREFIX))
        .map(p => p.name);
}

/** Fires a toastr listing all active TRG presets. No-op if none exist or pm unavailable. */
export function reportTrgPresets() {
    const names = listTrgPresets(promptManager);
    if (!names.length) return;
    window.toastr?.info(
        names.map(n => `• ${n}`).join('\n'),
        'TRG presets active',
        { timeOut: 6000, extendedTimeOut: 2000 },
    );
}

// ── Action definition ─────────────────────────────────────────────────────────

const MODES = ['write', 'clear', 'remove'];

export const preset = {
    label: 'inject preset',
    templateFields: cfg => [cfg.name, cfg.content],
    defaultConfig: { name: '', content: '', mode: 'write', confirmCreate: false, confirmDestroy: false, confirmUpdate: false },

    async execute(config, { matchedKeyword, messageId, stCtx, vars, debug, highlighted = '' }) {
        const pm = promptManager;
        if (!pm) {
            trgWarn('preset: PromptManager unavailable — Chat Completion backend required');
            return;
        }

        const baseVars = {
            keyword: matchedKeyword ?? '',
            message: stCtx?.chat?.[messageId]?.mes ?? '',
            char:    name2 ?? '',
            user:    name1 ?? '',
        };

        const resolvedName = interpolate((config.name ?? '').trim(), baseVars, vars ?? {}).trim();
        if (!resolvedName) {
            trgWarn('preset: name is required');
            return;
        }

        const id   = presetId(resolvedName);
        const mode = MODES.includes(config.mode) ? config.mode : 'write';

        if (mode === 'remove') {
            if (config.confirmDestroy && !window.confirm(`Remove preset "${resolvedName}"?`)) return;
            const order      = pm.getPromptOrderForCharacter(pm.activeCharacter);
            const orderIdx   = order.findIndex(e => e.identifier === id);
            if (orderIdx !== -1) order.splice(orderIdx, 1);
            const prompts    = pm.serviceSettings?.prompts ?? [];
            const promptsIdx = prompts.findIndex(p => p.identifier === id);
            if (promptsIdx !== -1) prompts.splice(promptsIdx, 1);
            if (orderIdx !== -1 || promptsIdx !== -1) pm.saveServiceSettings();
            trgDev(debug, `  preset: removed "${resolvedName}"`);
            return;
        }

        if (mode === 'clear') {
            if (config.confirmUpdate && !window.confirm(`Clear preset "${resolvedName}"?`)) return;
            const prompt = pm.getPromptById(id);
            if (prompt) {
                prompt.content = '';
                pm.saveServiceSettings();
            }
            trgDev(debug, `  preset: cleared "${resolvedName}"`);
            return;
        }

        // mode === 'write' — check existence before ensuring, so confirm fires before any mutation
        const exists = !!pm.getPromptById(id);
        if (exists  && config.confirmUpdate && !window.confirm(`Update preset "${resolvedName}"?`)) return;
        if (!exists && config.confirmCreate && !window.confirm(`Create preset "${resolvedName}"?`)) return;

        const created = ensureTrgPreset(pm, id, resolvedName);
        if (created) {
            window.toastr?.info(`Preset created: "${resolvedName}"`, 'Triggeryze');
        }

        const rawContent = await resolveLbTokens(config.content ?? '', matchedKeyword ?? '', highlighted, vars, messageId);
        const content    = interpolate(rawContent, baseVars, vars ?? {});

        const prompt = pm.getPromptById(id);
        if (!prompt) return;
        prompt.content = content;
        pm.saveServiceSettings();
        trgDev(debug, `  preset [${created ? 'created' : 'updated'}]: "${resolvedName}"`);
    },

    renderConfig($el, config, onChange) {
        const s = (val, want) => val === want ? ' selected' : '';
        $el.html(`
<div class="trg-sc-wrap">
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">name</label>
        <input type="text" class="trg-cfg trg-preset-name text_pole"
            placeholder="preset name — supports {{variables}}"
            value="${esc(config.name ?? '')}" style="flex:1" />
    </div>
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">mode</label>
        <select class="trg-cfg trg-preset-mode">
            <option value="write"  ${s(config.mode, 'write' )}>write</option>
            <option value="clear"  ${s(config.mode, 'clear' )}>clear</option>
            <option value="remove" ${s(config.mode, 'remove')}>remove</option>
        </select>
    </div>
    <div class="trg-sc-row" style="gap:12px">
        <label class="trg-check-row"><input type="checkbox" class="trg-cfg trg-preset-confirm-create"  ${config.confirmCreate  ? 'checked' : ''} /> confirm create</label>
        <label class="trg-check-row"><input type="checkbox" class="trg-cfg trg-preset-confirm-update"  ${config.confirmUpdate  ? 'checked' : ''} /> confirm update</label>
        <label class="trg-check-row"><input type="checkbox" class="trg-cfg trg-preset-confirm-destroy" ${config.confirmDestroy ? 'checked' : ''} /> confirm remove</label>
    </div>
    <div class="trg-preset-content-wrap" ${config.mode !== 'write' ? 'style="display:none"' : ''}>
        <textarea class="trg-cfg trg-preset-content text_pole" rows="5"
            placeholder="Content — {{variables}} supported">${esc(config.content ?? '')}</textarea>
        <small class="trg-hint">Injected above chat history on the next generation. A toastr fires on first creation.</small>
    </div>
</div>`);

        const readConfig = () => ({
            name:           $el.find('.trg-preset-name').val().trim(),
            content:        $el.find('.trg-preset-content').val(),
            mode:           $el.find('.trg-preset-mode').val() ?? 'write',
            confirmCreate:  $el.find('.trg-preset-confirm-create').prop('checked'),
            confirmUpdate:  $el.find('.trg-preset-confirm-update').prop('checked'),
            confirmDestroy: $el.find('.trg-preset-confirm-destroy').prop('checked'),
        });

        $el.find('.trg-preset-mode').on('change', function () {
            $el.find('.trg-preset-content-wrap').toggle($(this).val() === 'write');
            onChange(readConfig());
        });
        $el.find('.trg-preset-name, .trg-preset-content').on('input', () => onChange(readConfig()));
        $el.find('.trg-preset-confirm-create, .trg-preset-confirm-update, .trg-preset-confirm-destroy').on('change', () => onChange(readConfig()));
    },
};
