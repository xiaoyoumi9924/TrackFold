import { _electron } from 'playwright';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = mkdtempSync(path.join(os.tmpdir(), 'shiyin-missing-component-'));
const executablePath = process.env.SHIYIN_TEST_EXECUTABLE || path.resolve(process.env.SHIYIN_TEST_EXECUTABLE || 'release/unified-runtime/mac-arm64/拾音.app/Contents/MacOS/拾音');
const app = await _electron.launch({ executablePath, args: [], env: { ...process.env, SHIYIN_SEPARATOR_RUNTIME: path.join(root, 'missing'), SHIYIN_DESKTOP_DATA_DIR: path.join(root, 'profile'), SHIYIN_DESKTOP_OUTPUT_DIR: path.join(root, 'output') }, timeout: 45000 });
try {
  const page = await app.firstWindow();
  await page.locator('main').waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole("button", { name: "人声分离", exact: true }).click();
  await page.getByText('缺少人声分离运行组件。').waitFor();
  const result = await page.evaluate(async () => {
    const status = await (await fetch('/api/separation/status')).json();
    const response = await fetch('/api/jobs/example/separate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return { status, code: response.status, body: await response.json(), jobs: await (await fetch('/api/jobs')).json() };
  });
  assert.equal(result.status.available, false);
  assert.equal(result.code, 400);
  assert.match(result.body.error, /缺少人声分离运行组件/);
  assert.equal(result.jobs.length, 0);
  console.log('PASS missing component: settings explains limitation and separation creates no jobs');
} finally {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => app.quit());
  await closed;
}
