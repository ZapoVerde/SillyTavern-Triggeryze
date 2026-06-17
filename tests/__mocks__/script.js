// Stub for script.js — aliased by vitest.config.js resolve.alias.
// Provides no-op defaults for every symbol imported by the extension.
// Tests that need specific behaviour should override via vi.mock().
export const saveSettingsDebounced = () => {};
export const itemizedPrompts       = [];
export const name1                 = 'Char';
export const name2                 = 'User';
export const eventSource           = { on: () => {}, emit: () => {}, removeListener: () => {} };
export const event_types           = {};
export const generateQuietPrompt   = async () => '';
export const messageFormatting     = (text) => text;
export const addOneMessage         = async () => {};
export const updateMessageBlock    = () => {};
export const callPopup             = async () => null;
export const appendMediaToMessage  = () => {};
export const getRequestHeaders     = () => ({});
