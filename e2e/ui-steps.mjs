// UI phase of the e2e (Linux and Windows): drives the real Paseo web app with Playwright against the same
// daemon/plugin as e2e.mjs. Imported by e2e.mjs when --ui 1.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

export async function uiPhase(ctx) {
  const { step, note, rpc, mkAgent, hit, setUsage, jobOf, editJob, readJobs, readHistory, continues, writeSettings, waitFor, sleep, origin, out, API, DEFAULT_MARK } = ctx;
  const S = 'claude-ui';
  const isWin = process.platform === 'win32';
  const pwRoot = process.env.PW_ROOT ?? (isWin ? null : process.env.HOME + '/.npm/_npx/e41f203b7505f1fb/node_modules/');
  if (!pwRoot) throw new Error('--ui 1 on Windows needs PW_ROOT: the node_modules directory that holds playwright');
  // CHROME, else Playwright's Chromium on Linux and the Edge every Windows install ships (no browser download).
  const browserAt = process.env.CHROME ? { executablePath: process.env.CHROME }
    : isWin ? { channel: 'msedge' } : { executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' };
  const { chromium } = createRequire(pwRoot)('playwright');
  const { expect } = createRequire(pwRoot)('playwright/test');
  const browser = await chromium.launch({ headless: true, ...browserAt });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })).newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const shot = (name) => page.screenshot({ path: join(out, name + '.png'), fullPage: false }).catch(() => {});
  const iso = (ms) => new Date(ms).toISOString();
  // The pill reads "Resume 23:40", "Tmr 01:02" or "Wed 09:00" by day, "Check …", "Resume off", "Resuming…" or "Unavailable".
  const pill = () => page.getByRole('button', { name: 'Auto Resume', exact: true }).filter({ hasText: /^(Resume|Tmr|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Check|Resuming|Unavailable)\b/ });
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
  const openScreen = async () => {
    await page.goto(origin);
    await page.getByRole('button', { name: 'Auto Resume', exact: true }).first().click({ timeout: 60000 });
    await expect(page.getByRole('button', { name: /^Turn all (off|on)$/ })).toBeVisible({ timeout: 60000 });
  };
  // The section heading the screen files a reservation under, as client/format.ts dayLabel writes it.
  const dayLabel = (ms) => {
    const day = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const days = Math.round((day(ms) - day(Date.now())) / 86400000);
    return days <= 0 ? 'Today' : days === 1 ? 'Tomorrow' : new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };
  // Walks up from a row to its card, whose previous sibling is the day heading.
  const headingOf = (title) => page.getByRole('button', { name: new RegExp(`^Change time for ${title}, now `) }).evaluate((el) => {
    for (let n = el; n; n = n.parentElement) {
      const prev = n.previousElementSibling;
      if (prev && prev.children.length === 0 && prev.textContent) return prev.textContent;
    }
    return null;
  });

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

    // ---- item 15: the Auto Resume screen ------------------------------------------------------
    const T1 = 'UI screen row', T2 = 'UI screen later day';
    const r1 = await mkAgent(T1), r2 = await mkAgent(T2);
    await hit(r1, 'claude'); await hit(r2, 'claude');
    // Two days ahead, as a weekly reset would place it; jobs.json is reread by the store.
    const later = new Date(); later.setDate(later.getDate() + 2); later.setHours(10, 0, 0, 0);
    await editJob(r2.id, { resetAt: iso(later.getTime() - 120000), dueAt: iso(later.getTime()) });
    await guarded(15, 'screen groups reservations under their day', async () => {
      await openScreen();
      const want1 = dayLabel(Date.parse((await jobOf(r1.id)).dueAt)), want2 = dayLabel(later.getTime());
      assert.notEqual(want1, want2);
      await waitFor(async () => (await headingOf(T2).catch(() => null)) === want2, `${T2} under ${want2}`, 30000, 500);
      assert.equal(await headingOf(T1), want1);
      await shot('ui-7-screen');
      return `"${T1}" under ${want1}, "${T2}" under ${want2}`;
    });

    const NOTE = 'UI-ROW-NOTE-' + Math.random().toString(36).slice(2, 7);
    await guarded(15, 'screen row: +10m, Change time and extra instructions change only that reservation', async () => {
      await openScreen();
      const other = await jobOf(r2.id);
      const cur = (await jobOf(r1.id)).dueAt;
      await page.getByRole('button', { name: `Delay 10 minutes for ${T1}`, exact: true }).click();
      const bumped = iso(Date.parse(cur) + 600000);
      await waitFor(async () => (await jobOf(r1.id)).dueAt === bumped, '+10m applied', 20000, 300);
      const target = Date.parse(bumped) + 2 * 3600000 + 3 * 60000;
      const crosses = new Date(target).getDate() !== new Date().getDate();
      await page.getByRole('button', { name: new RegExp(`^Change time for ${T1}, now `) }).click();
      await page.getByRole('textbox', { name: `New time for ${T1}`, exact: true }).fill(hhmm(target));
      await page.getByRole('radio', { name: crosses ? 'Tomorrow' : 'Today', exact: true }).click();
      await page.getByRole('button', { name: 'Save time', exact: true }).click();
      await waitFor(async () => Math.abs(Date.parse((await jobOf(r1.id)).dueAt) - target) < 60000, 'Change time applied', 20000, 300);
      await page.getByRole('button', { name: `Add extra instructions for ${T1}`, exact: true }).click();
      await page.getByRole('textbox', { name: `Extra instructions for ${T1}`, exact: true }).fill(NOTE);
      await page.getByRole('button', { name: 'Save extra instructions', exact: true }).click();
      await waitFor(async () => (await jobOf(r1.id))?.note === NOTE, 'note saved', 20000, 300);
      await expect(page.getByText(`Extra Instructions : ${NOTE}`, { exact: true })).toBeVisible({ timeout: 15000 });
      await shot('ui-8-screen-row');
      assert.deepEqual(await jobOf(r2.id), other, 'the other reservation changed');
      return `+10m -> ${bumped.slice(11, 16)}Z, Change time -> ${(await jobOf(r1.id)).dueAt} (typed ${hhmm(target)}), note ${NOTE} shown on the row; "${T2}" unchanged`;
    });

    await guarded(15, 'screen row Open goes to its conversation', async () => {
      await openScreen();
      await page.getByRole('button', { name: `Open ${T1}`, exact: true }).click();
      await expect(page.getByTestId('workspace-tab-agent_' + r1.id)).toBeVisible({ timeout: 45000 });
      await expect(pill()).toBeVisible({ timeout: 45000 });
      return `conversation of "${T1}" opened with its Auto Resume pill`;
    });

    await guarded(15, 'Turn all off / Turn all on change every pending reservation on screen', async () => {
      await openScreen();
      const pending = async () => (await readJobs()).filter((j) => j.state === 'pending');
      const shown = (await pending()).length;
      await page.getByRole('button', { name: 'Turn all off', exact: true }).click();
      await expect(toast(`${shown} ${shown === 1 ? 'schedule' : 'schedules'} turned off`)).toBeVisible({ timeout: 30000 });
      await waitFor(async () => (await pending()).every((j) => !j.enabled), 'all off', 20000, 300);
      await expect(page.getByText('All turned off', { exact: true })).toBeVisible();
      await shot('ui-9-all-off');
      await page.getByRole('button', { name: 'Turn all on', exact: true }).click();
      await expect(toast(`${shown} ${shown === 1 ? 'schedule' : 'schedules'} turned on`)).toBeVisible({ timeout: 30000 });
      await waitFor(async () => (await pending()).every((j) => j.enabled), 'all on', 20000, 300);
      return `${shown} pending reservations turned off, "All turned off" shown, then all turned on again`;
    });

    await guarded(15, 'screen row switch off: skipped at its due time, extra instructions dropped, nothing sent', async () => {
      await openScreen();
      await page.getByRole('switch', { name: new RegExp(`^Continue ${T1} automatically at `) }).click();
      await waitFor(async () => (await jobOf(r1.id))?.enabled === false, 'switched off', 20000, 300);
      // The header detail; Recent activity's summary also ends in "· 1 skipped".
      await expect(page.getByText(/^Next (check )?at \d\d:\d\d( · \d+ waiting)? · 1 skipped$/)).toBeVisible({ timeout: 15000 });
      const sent0 = continues('claude').length;
      await editJob(r1.id, { resetAt: iso(Date.now() - 120000), dueAt: iso(Date.now() - 60000) });
      await waitFor(async () => (await readHistory()).some((h) => h.agentId === r1.id && h.outcome === 'skipped'), 'skipped', 240000, 1000);
      assert.equal(continues('claude').length, sent0, 'a continue was sent');
      assert.equal(await jobOf(r1.id), undefined);
      assert.ok(!(await readJobs()).some((j) => j.note === NOTE), 'note kept after the skip');
      return 'switch off -> "1 skipped" in the header; at the due time history skipped, row and its note gone, 0 continues';
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
