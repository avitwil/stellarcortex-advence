// FR-CODE-03 benchmark repository stays valid: exactly three tests fail as shipped, and the
// three intended one-line fixes make them pass. (A Bot fixing it is MC-P3-BENCH.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../../docs/bench/fr-code-03');
const run = (dir: string) => spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8' }).stdout;

describe('FR-CODE-03 benchmark repository', () => {
  it('has three seeded bugs with one-line fixes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advence-bench-'));
    fs.cpSync(SRC, dir, { recursive: true });
    expect(run(dir)).toMatch(/# pass 0[\s\S]*# fail 3/);
    const fix = (f: string, a: string, b: string) => fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(dir, f), 'utf8').replace(a, b));
    fix('text.js', ".replace(/^-/, '')", ".replace(/^-|-$/g, '')");
    fix('stats.js', '.sort()', '.sort((a, b) => a - b)');
    fix('duration.js', 'return total || null;', "return /^(\\d+[hms])+$/.test(text) ? total : null;");
    expect(run(dir)).toMatch(/# pass 3[\s\S]*# fail 0/);
  });
});
