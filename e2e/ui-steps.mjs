// UI phase of the e2e (Linux only): drives the real Paseo web app with Playwright against the same
// daemon/plugin as e2e.mjs. Imported by e2e.mjs when --ui 1.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

export async function uiPhase(ctx) {
  const { step, note, rpc, mkAgent, hit, setUsage, jobOf, editJob, readHistory, continues, writeSettings, waitFor, sleep, origin, out, API, DEFAULT_MARK } = ctx;
  const S = 'claude-ui';
  const pwRoot = process.env.PW_ROOT ?? (process.env.HOME + '/.npm/_npx/e41f203b7505f1fb/node_modules/');
  const chrome = process.env.CHROME ?? (process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome');
  const { chromium } = createRequire(pwRoot)('playwright');
  const { expect } = createRequire(pwRoot)('playwright/test');
  const browser = await chromium.launch({ headless: true, executablePath: chrome });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })).newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const shot = (name) => page.screenshot({ path: join(out, name + '.png'), fullPage: false }).catch(() => {});
  const iso = (ms) => new Date(ms).toISOString();
  const pill = () => page.getByRole('button', { name: 'Auto Resume', exact: true }).filter({ hasText: /^(Resume |Check |Resuming|Unavailable)/ });
  const toast = (t) => page.getByText(t, { exact: true });
  const openConversation = async (a) => {
    await page.goto(origin);
    await page.getByRole('button', { name: /^UAR E2E/ }).first().click({ timeout: 60000 });
    const tab = page.getByTestId('workspace-tab-agent_' + a.id);
    await tab.click({ timeout: 45000 });
  };
  const openPanel = async (a) => {
    await expect(pill()).toBeVisible({ timeout: 60000 });
    await pill().click();
    const panel = page.getByTestId('resume-conversation-' + a.id);
    await expect(panel).toBeVisible({ timeout: 15000 });
    return panel;
  };
  const dump = async (name) => { await shot('fail-' + name); await writeFile(join(out, 'fail-' + name + '.txt'), page.url() + '\n' + (await page.locator('body').ariaSnapshot().catch(() => ''))).catch(() => {}); };
  const guarded = (item, name, fn) => step(item, S, name, async () => { try { return await fn(); } catch (e) { await dump(`${item}-${name.slice(0, 12).replace(/\W+/g, '_')}`); throw e; } });
  const openSettings = async () => {
    await page.goto(origin);
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click({ timeout: 60000 });
    await page.getByRole('button', { name: 'Plugins', exact: true }).first().click();
    await page.getByRole('button', { name: 'Actions for usage-auto-resume', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Automatic resume' })).toBeVisible({ timeout: 60000 });
  };
  const hhmm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  try {
    // ---- item 4 in the UI: presets and Change time -----------------------------------------
    const u1 = await mkAgent('UI presets');
    let j1 = await hit(u1, 'claude');
    await guarded(4, 'composer pill: +10m / +30m / +1h and Change time', async () => {
      await openConversation(u1);
      const panel = await openPanel(u1);
      await shot('ui-1-pill');
      let cur = j1.dueAt; const seen = [];
      for (const [name, label, ms] of [['Delay 10 minutes', '+10m', 600000], ['Delay 30 minutes', '+30m', 1800000], ['Delay 1 hour', '+1h', 3600000]]) {
        await panel.getByRole('button', { name, exact: true }).click();
        const want = iso(Date.parse(cur) + ms);
        await waitFor(async () => (await jobOf(u1.id)).dueAt === want, `${label} applied`, 20000, 300);
        cur = want; seen.push(`${label}->${want.slice(11, 16)}Z`);
      }
      // Change time: the same day, 2h later, typed as the app shows it (device-local HH:MM).
      const target = Date.parse(cur) + 2 * 3600000 + 3 * 60000;
      const crosses = new Date(target).getDate() !== new Date().getDate();
      await panel.getByRole('button', { name: 'Change time', exact: true }).click();
      const box = panel.getByRole('textbox', { name: /^New time for / });
      await box.fill(hhmm(target));
      await panel.getByRole('radio', { name: crosses ? 'Tomorrow' : 'Today' }).click();
      await panel.getByRole('button', { name: 'Save time', exact: true }).click();
      await waitFor(async () => { const d = Date.parse((await jobOf(u1.id)).dueAt); return Math.abs(d - target) < 60000; }, 'Change time applied', 20000, 300);
      await shot('ui-2-after-change');
      return `${seen.join(', ')}, then Change time -> ${(await jobOf(u1.id)).dueAt} (typed ${hhmm(target)}); each moved the reservation's own due time`;
    });

    // ---- item 5 in the UI: extra instructions + custom prompt --------------------------------
    const u2 = await mkAgent('UI note and prompt');
    await guarded(5, 'extra instructions (composer) + custom continue prompt (settings) are sent together; note deleted', async () => {
      const j2 = await hit(u2, 'claude');
      const NOTE = 'UI-NOTE-' + Math.random().toString(36).slice(2, 7), CUSTOM = 'UI-CUSTOM-' + Math.random().toString(36).slice(2, 7) + ' go on.';
      await openConversation(u2);
      const panel = await openPanel(u2);
      await panel.getByRole('button', { name: 'Add extra instructions' }).click();
      await panel.getByRole('textbox', { name: /^Extra instructions for / }).fill(NOTE);
      await panel.getByRole('button', { name: 'Save extra instructions' }).click();
      await waitFor(async () => (await jobOf(u2.id))?.note === NOTE, 'note saved', 20000, 300);
      await openSettings();
      await shot('ui-3-settings');
      const prompt = page.getByRole('textbox', { name: 'Continue prompt' });
      await prompt.fill(CUSTOM);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await sleep(2500);
      const before = continues('claude', CUSTOM).length;
      await editJob(u2.id, { resetAt: iso(Date.now() - 120000), dueAt: iso(Date.now() - 60000) });
      await waitFor(async () => continues('claude', CUSTOM).length === before + 1, 'custom continue sent', 200000, 1000);
      const req = continues('claude', CUSTOM).at(-1);
      assert.ok(req.last.includes(NOTE) && req.last.includes('Additional instructions from the user for this continue:'));
      const after = await jobOf(u2.id);
      assert.ok(!after || !after.note, 'note kept after sending');
      await waitFor(async () => !(await jobOf(u2.id)), 'row cleared', 200000, 1000);
      // back to the default prompt
      await openSettings();
      await page.getByRole('button', { name: 'Reset to default' }).click().catch(() => {});
      await sleep(1000);
      await writeSettings('resume', 1, { continuePrompt: null });
      return `one continue carries the settings-screen prompt + heading + composer note (${NOTE}); note deleted after sending`;
    });

    // ---- item 6 in the UI: Resume now ---------------------------------------------------------
    const u3 = await mkAgent('UI resume now');
    await guarded(6, 'composer Resume now: toasts for used up / unverified, then one continue', async () => {
      const j3 = await hit(u3, 'claude');
      await openConversation(u3);
      let panel = await openPanel(u3);
      const resumeNow = async () => {
        await panel.getByRole('button', { name: 'Resume now', exact: true }).click();
        await expect(panel.getByText('Send the continue now?', { exact: true })).toBeVisible();
        await panel.getByRole('button', { name: 'Send', exact: true }).click();
      };
      const before = await jobOf(u3.id), sent0 = continues('claude').length;
      await setUsage({ usage: 'limited', until: iso(Date.now() + 40 * 60000) });
      await resumeNow();
      await expect(page.getByText(/^Usage is still used up until /)).toBeVisible({ timeout: 30000 });
      await shot('ui-4-used-up');
      assert.deepEqual(await jobOf(u3.id), before);
      await setUsage({ usage: 'auth' });
      await resumeNow();
      await expect(toast('Couldn’t verify the account. Check the CLI login.')).toBeVisible({ timeout: 30000 });
      assert.deepEqual(await jobOf(u3.id), before);
      assert.equal(continues('claude').length, sent0);
      await setUsage({});
      await resumeNow();
      await expect(toast('Continue sent')).toBeVisible({ timeout: 30000 });
      await waitFor(async () => continues('claude').length === sent0 + 1, 'continue sent', 200000, 1000);
      await sleep(5000);
      assert.equal(continues('claude').length, sent0 + 1);
      await waitFor(async () => !(await jobOf(u3.id)), 'row cleared', 200000, 1000);
      assert.equal((await readHistory()).find((e) => e.agentId === u3.id && e.outcome === 'continued')?.trigger, 'manual');
      return 'toasts "Usage is still used up until ..." and "Couldn’t verify the account..." with reservation unchanged and nothing sent; then "Continue sent", exactly 1 continue, history manual';
    });

    // ---- item 9 in the UI: provider switch ---------------------------------------------------
    const u4 = await mkAgent('UI provider off', 'claude-sub');
    await guarded(9, 'Settings switch turns Claude Sub off: its pending reservation is canceled at once', async () => {
      await hit(u4, 'claude');
      await openSettings();
      await expect(page.getByText(/1 pending reservation/)).toBeVisible({ timeout: 30000 });
      await shot('ui-5-settings-pending');
      await page.getByRole('switch', { name: /Claude Sub/ }).click();
      await waitFor(async () => (await readHistory()).some((h) => h.agentId === u4.id && h.reason === 'provider_off'), 'provider_off', 60000, 500);
      assert.equal(await jobOf(u4.id), undefined);
      await page.getByRole('switch', { name: /Claude Sub/ }).click();
      await sleep(1500);
      return 'history canceled/provider_off right after the switch; switched back on';
    });

    // ---- item 12 in the UI: Recent activity -------------------------------------------------
    await guarded(12, 'Recent activity (UI) shows continued, resume-now, skipped, canceled outcomes', async () => {
      await page.goto(origin);
      await page.getByRole('button', { name: 'Auto Resume', exact: true }).first().click({ timeout: 60000 });
      const header = page.getByRole('button', { name: /^Recent activity in the last 24 hours/ });
      await expect(header).toBeVisible({ timeout: 60000 });
      const summary = await header.innerText();
      await header.click();
      const seen = [];
      for (const text of ['Continued · Resume now', 'Continued', 'Skipped · turned off', 'Canceled · provider turned off', 'Canceled · a newer message']) {
        const found = await page.getByText(text, { exact: true }).first().isVisible().catch(() => false);
        seen.push(`${text}:${found ? 'y' : 'n'}`);
      }
      await shot('ui-6-recent-activity');
      assert.ok(seen.filter((s) => s.endsWith(':y')).length >= 4, seen.join(' '));
      return `header "${summary.replace(/\s+/g, ' ')}"; rows ${seen.join(', ')}`;
    });
  } finally {
    if (pageErrors.length) note(0, S, 'browser page errors', pageErrors.slice(0, 5).join(' | '));
    await browser.close().catch(() => {});
  }
}
