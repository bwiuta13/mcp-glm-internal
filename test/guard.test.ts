import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ensureGuardHome } from '../src/runner.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.ts';

// Lấy đường dẫn codex từ config thật; bỏ qua test nếu máy chưa cấu hình.
function codexBin(): string | null {
  try { return loadConfig().binaries.codex; } catch { return null; }
}

test('rules chặn git commit và git push, cho qua lệnh vô hại', (t) => {
  const bin = codexBin();
  if (!bin) return t.skip('chưa có ~/.mcp-coding-glm/config.json');

  const home = ensureGuardHome(mkdtempSync(join(tmpdir(), 'mcg-guard-')));
  const rules = join(home, 'rules', 'guard.rules');

  const decide = (cmd: string[]): string => {
    const out = execFileSync(bin, ['execpolicy', 'check', '--rules', rules, '--', ...cmd], {
      encoding: 'utf8',
    });
    return JSON.parse(out).decision ?? 'none';
  };

  assert.equal(decide(['git', 'commit', '-m', 'x']), 'forbidden');
  assert.equal(decide(['git', 'push', 'origin', 'main']), 'forbidden');
  assert.notEqual(decide(['git', 'status']), 'forbidden');
  assert.notEqual(decide(['npm', 'test']), 'forbidden');
});
