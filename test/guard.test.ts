import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ensureGuardHome, GUARD_RULES } from '../src/runner.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('rules chặn git commit và git push, cho qua lệnh vô hại', (t) => {
  // Giải binary NGAY TẠI ĐÂY, không đi qua config của người dùng. Test này là chuông báo
  // khi Codex nâng cấp đổi cú pháp rules, nên nó phải chạy được trên một clone sạch —
  // phụ thuộc vào ~/.mcp-coding-glm/config.json là tự tắt chuông vĩnh viễn.
  let bin = process.env.CODEX_BIN ?? '';
  if (!bin) {
    try {
      bin = execFileSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).trim();
    } catch {
      bin = '';
    }
  }
  if (!bin) {
    // Trên CI thì thiếu codex là lỗi, không phải lý do bỏ qua.
    assert.ok(!process.env.CI && !process.env.REQUIRE_CODEX, 'không tìm thấy binary codex');
    return t.skip('máy này không có codex');
  }

  // Neo theo dòng: thiếu /m thì một `.*` có thể vắt qua xuống dòng và khớp nhầm chữ
  // "forbidden" của rule bên cạnh, khiến rule bị hạ xuống "allow" mà test vẫn xanh.
  assert.match(GUARD_RULES, /^prefix_rule\(pattern=\["git","commit"\], decision="forbidden"/m);
  assert.match(GUARD_RULES, /^prefix_rule\(pattern=\["git","push"\], decision="forbidden"/m);

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
