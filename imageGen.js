/**
 * @file st-extensions/SillyTavern-Triggeryze/imageGen.js
 * @stamp {"utc":"2026-06-13T00:00:00.000Z"}
 * @architectural-role Image IO
 * @description
 * Image generation and upload for Triggeryze's imageGen action.
 * Mirrors Vistalyze's imageCache.js routing approach but reads config
 * from per-rule settings (source, model, comfyUiUrl) rather than shared
 * extension state. Self-contained — does not import from Vistalyze.
 * Upload targets /api/images/upload (ST's general image store).
 *
 * @api-declaration
 * SOURCE_LABELS                          — display name map for the source picker UI
 * loadModelsForSource(source)            → Promise<Array|null>
 * generatePreviewBlob(prompt, config)    → Promise<string>  (blob URL, no upload)
 * generateAndUpload(prompt, config, charName) → Promise<string>  (server path)
 *
 * @contract
 *   assertions:
 *     purity: IO
 *     state_ownership: []
 *     external_io: [ST SD proxy endpoints, /api/openai/generate-image,
 *                   /api/google/generate-image, /api/images/upload]
 */

import { getRequestHeaders } from '../../../../script.js';

// ─── Source routing tables ─────────────────────────────────────────────────────

const MODEL_ENDPOINTS = {
    pollinations: '/api/sd/pollinations/models',
    falai:        '/api/sd/falai/models',
    togetherai:   '/api/sd/together/models',
    chutes:       '/api/sd/chutes/models',
    electronhub:  '/api/sd/electronhub/models',
    nanogpt:      '/api/sd/nanogpt/models',
    aimlapi:      '/api/sd/aimlapi/models',
    openrouter:   '/api/openrouter/models/image',
};

const GENERATION_ENDPOINTS = {
    pollinations: '/api/sd/pollinations/generate',
    falai:        '/api/sd/falai/generate',
    bfl:          '/api/sd/bfl/generate',
    stability:    '/api/sd/stability/generate',
    openai:       '/api/openai/generate-image',
    google:       '/api/google/generate-image',
    togetherai:   '/api/sd/together/generate',
    chutes:       '/api/sd/chutes/generate',
    electronhub:  '/api/sd/electronhub/generate',
    nanogpt:      '/api/sd/nanogpt/generate',
    xai:          '/api/sd/xai/generate',
    zai:          '/api/sd/zai/generate',
    aimlapi:      '/api/sd/aimlapi/generate-image',
    openrouter:   '/api/openrouter/image/generate',
    huggingface:  '/api/sd/huggingface/generate',
};

const LOCAL_SOURCES = new Set(['extras', 'horde', 'auto', 'vlad', 'sdcpp', 'drawthings', 'novel']);

export const SOURCE_LABELS = {
    pollinations: 'Pollinations',
    falai:        'FAL AI',
    bfl:          'Black Forest Labs',
    stability:    'Stability AI',
    openai:       'OpenAI',
    google:       'Google',
    togetherai:   'Together AI',
    chutes:       'Chutes AI',
    electronhub:  'Electron Hub',
    nanogpt:      'NanoGPT',
    xai:          'xAI (Grok)',
    zai:          'Z AI',
    aimlapi:      'AIML API',
    openrouter:   'OpenRouter',
    huggingface:  'Hugging Face',
    comfy:        'ComfyUI',
};

// ─── ComfyUI via ST proxy ──────────────────────────────────────────────────────

function findPositivePromptNodeId(workflow) {
    const samplerClasses = ['KSampler', 'KSamplerAdvanced'];
    for (const [, node] of Object.entries(workflow)) {
        if (samplerClasses.includes(node.class_type)) {
            const positiveInput = node.inputs?.positive;
            if (Array.isArray(positiveInput)) return String(positiveInput[0]);
        }
    }
    for (const [nodeId, node] of Object.entries(workflow)) {
        if (node.class_type === 'CLIPTextEncode') return nodeId;
    }
    return null;
}

async function generateViaComfy(prompt, comfyUiUrl) {
    const workflowRes = await fetch('/api/sd/comfy/workflow', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });
    if (!workflowRes.ok) throw new Error('Could not load default ComfyUI workflow from ST. Make sure a workflow is saved in the Image Generation panel.');
    const workflow = await workflowRes.json();
    const nodeId = findPositivePromptNodeId(workflow);
    if (!nodeId) throw new Error('Could not find a CLIPTextEncode prompt node in the ComfyUI workflow.');
    workflow[nodeId].inputs.text = prompt;
    const genRes = await fetch('/api/sd/comfy/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ url: comfyUiUrl || '', prompt: JSON.stringify(workflow) }),
    });
    if (!genRes.ok) {
        const text = await genRes.text();
        throw new Error(`ComfyUI generation failed: ${text}`);
    }
    const data = await genRes.json();
    return { image: data.data, format: data.format ?? 'png' };
}

// ─── Request builders ──────────────────────────────────────────────────────────

function buildRequestBody(source, prompt, model) {
    switch (source) {
        case 'openai':
            return { prompt, model, n: 1, size: '1024x1024', response_format: 'b64_json' };
        case 'google':
            return { prompt, model, aspect_ratio: '1:1', api: 'makersuite' };
        case 'stability':
            return { model, payload: { prompt, negative_prompt: '', output_format: 'png' } };
        case 'xai':
            return { prompt, model, aspect_ratio: '1:1', resolution: 'HD' };
        default:
            return { prompt, model, negative_prompt: '', width: 1024, height: 1024, seed: -1 };
    }
}

// ─── Response normalizer ───────────────────────────────────────────────────────

async function normalizeImageResponse(res, source) {
    if (source === 'stability') {
        const image = await res.text();
        return { image, format: 'png' };
    }
    if (source === 'openai') {
        const data = await res.json();
        return { image: data?.data?.[0]?.b64_json, format: 'png' };
    }
    const data = await res.json();
    return { image: data?.image ?? data?.data, format: data?.format ?? 'png' };
}

// ─── Core generation ───────────────────────────────────────────────────────────

async function callImageProxy(prompt, config) {
    const source = config.source || 'pollinations';
    const model  = config.model  || '';

    if (source === 'comfy') return generateViaComfy(prompt, config.comfyUiUrl || '');

    if (LOCAL_SOURCES.has(source)) {
        throw new Error(`"${source}" requires a local server and is not supported. Choose a cloud-based source.`);
    }

    const endpoint = GENERATION_ENDPOINTS[source];
    if (!endpoint) throw new Error(`Unknown image source: "${source}".`);

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(buildRequestBody(source, prompt, model)),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Image generation failed (${source} ${res.status}): ${text}`);
    }

    return normalizeImageResponse(res, source);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function base64ToBlob(base64, format) {
    const binary = atob(base64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: `image/${format}` });
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns [{value, text}] if the source has a live model discovery endpoint, null otherwise.
 * Null signals the UI to render a free-text input instead of a select.
 */
export async function loadModelsForSource(source) {
    const endpoint = MODEL_ENDPOINTS[source];
    if (!endpoint) return null;
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return Array.isArray(data) && data.length > 0 ? data : null;
    } catch {
        return null;
    }
}

/**
 * Generates an image and returns a local blob URL. No file is uploaded or persisted.
 * Intended for the test button only.
 */
export async function generatePreviewBlob(prompt, config) {
    const { image, format } = await callImageProxy(prompt, config);
    return URL.createObjectURL(base64ToBlob(image, format));
}

/**
 * Generates an image, uploads it to ST's image store, and returns the server path.
 * charName is used as the subfolder (ch_name) for the upload.
 */
export async function generateAndUpload(prompt, config, charName) {
    const { image, format } = await callImageProxy(prompt, config);

    const body = {
        image,
        format,
        ch_name:  charName ?? 'triggeryze',
        filename: `trg_${Date.now()}`,
    };

    const res = await fetch('/api/images/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Image upload failed: ${res.status}`);
    }

    const data = await res.json();
    return data.path;
}
