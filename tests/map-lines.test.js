import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

import { resolveMapLines } from '../actions/map-lines.js';
import { getLocalVariable, getGlobalVariable } from '../../../../../scripts/variables.js';

afterEach(() => { vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// resolveMapLines — early exit
// ---------------------------------------------------------------------------

describe('resolveMapLines — early exit', () => {
    it('returns template unchanged when no {{mapLines is present', () => {
        expect(resolveMapLines('hello {{name}}', {})).toBe('hello {{name}}');
    });

    it('returns null unchanged', () => {
        expect(resolveMapLines(null, {})).toBe(null);
    });

    it('returns empty string unchanged', () => {
        expect(resolveMapLines('', {})).toBe('');
    });
});

// ---------------------------------------------------------------------------
// resolveMapLines — turn-variable source
// ---------------------------------------------------------------------------

describe('resolveMapLines — turn-variable source', () => {
    it('maps tab-delimited rows from a turn variable', () => {
        const vars = { ps_rows: 'main\t14\nworldInfoBefore\t18' };
        const tpl  = '{{mapLines: \\t : ps_rows}}{{.1}}|{{.2}}{{/mapLines}}';
        expect(resolveMapLines(tpl, vars)).toBe('main|14\nworldInfoBefore|18');
    });

    it('maps comma-delimited rows from a turn variable', () => {
        const vars = { data: 'a,1\nb,2' };
        const tpl  = '{{mapLines: , : data}}{{.1}}={{.2}}{{/mapLines}}';
        expect(resolveMapLines(tpl, vars)).toBe('a=1\nb=2');
    });

    it('returns empty string when source variable is missing', () => {
        const tpl = '{{mapLines: \\t : ps_rows}}{{.1}}{{/mapLines}}';
        expect(resolveMapLines(tpl, {})).toBe('');
    });

    it('returns empty string when source variable is whitespace only', () => {
        const tpl = '{{mapLines: \\t : ps_rows}}{{.1}}{{/mapLines}}';
        expect(resolveMapLines(tpl, { ps_rows: '   ' })).toBe('');
    });

    it('skips blank lines in source data', () => {
        const vars = { data: 'a\t1\n\nb\t2' };
        const tpl  = '{{mapLines: \\t : data}}{{.1}}{{/mapLines}}';
        expect(resolveMapLines(tpl, vars)).toBe('a\nb');
    });

    it('skips whitespace-only lines in source data', () => {
        const vars = { data: 'a\t1\n   \nb\t2' };
        const tpl  = '{{mapLines: \\t : data}}{{.1}}{{/mapLines}}';
        expect(resolveMapLines(tpl, vars)).toBe('a\nb');
    });

    it('references the first column with {{.1}} and the second with {{.2}}', () => {
        const vars = { data: 'hello\tworld' };
        const tpl  = '{{mapLines: \\t : data}}[{{.1}}][{{.2}}]{{/mapLines}}';
        expect(resolveMapLines(tpl, vars)).toBe('[hello][world]');
    });

    it('out-of-range column reference produces empty string for that field', () => {
        const vars = { data: 'a\tb' };
        const tpl  = '{{mapLines: \\t : data}}{{.3}}{{/mapLines}}';
        expect(resolveMapLines(tpl, vars)).toBe('');
    });

    it('joins multiple output rows with newlines', () => {
        const vars = { data: 'x\t1\ny\t2\nz\t3' };
        const tpl  = '{{mapLines: \\t : data}}{{.1}}={{.2}}{{/mapLines}}';
        expect(resolveMapLines(tpl, vars)).toBe('x=1\ny=2\nz=3');
    });

    it('trims leading and trailing whitespace from the body before applying column refs', () => {
        const vars = { data: 'a\t1' };
        const tpl  = '{{mapLines: \\t : data}}\n  {{.1}}-{{.2}}  \n{{/mapLines}}';
        expect(resolveMapLines(tpl, vars)).toBe('a-1');
    });

    it('returns empty string when args have fewer than two parts', () => {
        // Only one part after split — no source specified
        const tpl = '{{mapLines: \\t}}body{{/mapLines}}';
        expect(resolveMapLines(tpl, {})).toBe('');
    });
});

// ---------------------------------------------------------------------------
// resolveMapLines — chatvar:: / globalvar:: sources
// ---------------------------------------------------------------------------

describe('resolveMapLines — chatvar:: / globalvar:: sources', () => {
    it('resolves chatvar:: source via getLocalVariable', () => {
        vi.mocked(getLocalVariable).mockReturnValue('r1\tc1\nr2\tc2');
        const tpl = '{{mapLines: \\t : chatvar::myData}}{{.1}}|{{.2}}{{/mapLines}}';
        expect(resolveMapLines(tpl, {})).toBe('r1|c1\nr2|c2');
    });

    it('resolves globalvar:: source via getGlobalVariable', () => {
        vi.mocked(getGlobalVariable).mockReturnValue('x\t10\ny\t20');
        const tpl = '{{mapLines: \\t : globalvar::stats}}{{.1}}:{{.2}}{{/mapLines}}';
        expect(resolveMapLines(tpl, {})).toBe('x:10\ny:20');
    });

    it('returns empty string when chatvar:: resolves to null', () => {
        vi.mocked(getLocalVariable).mockReturnValue(null);
        const tpl = '{{mapLines: \\t : chatvar::missing}}{{.1}}{{/mapLines}}';
        expect(resolveMapLines(tpl, {})).toBe('');
    });
});

// ---------------------------------------------------------------------------
// resolveMapLines — surrounding text and multiple blocks
// ---------------------------------------------------------------------------

describe('resolveMapLines — surrounding text and multiple blocks', () => {
    it('preserves text before and after the block', () => {
        const vars = { data: 'a\t1' };
        const tpl  = 'prefix\n{{mapLines: \\t : data}}{{.1}}={{.2}}{{/mapLines}}\nsuffix';
        expect(resolveMapLines(tpl, vars)).toBe('prefix\na=1\nsuffix');
    });

    it('handles multiple mapLines blocks in the same template independently', () => {
        const vars = { a: 'x\t1', b: 'y\t2' };
        const tpl  = '{{mapLines: \\t : a}}{{.1}}{{/mapLines}}|{{mapLines: \\t : b}}{{.2}}{{/mapLines}}';
        expect(resolveMapLines(tpl, vars)).toBe('x|2');
    });
});
