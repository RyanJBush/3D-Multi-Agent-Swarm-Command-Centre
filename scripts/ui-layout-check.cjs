/* Scripted layout + diagnosis check for the UI pass. NOT a usability study and not part of CI.
 * Needs Playwright with Chromium (not a project dependency).
 * Usage: node scripts/ui-layout-check.cjs http://localhost:4173/ [screenshot-dir]
 * Measures layout facts at 1280 px and 375 px, then repeats the e02/e03/e04 diagnosis in the 2D and 3D views. */
const { chromium } = require("playwright");
const url = process.argv[2] || "http://localhost:4173/";
const shotDir = process.argv[3];
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

(async () => {
  const browser = await chromium.launch();
  const msgs = [];
  async function open(vp) {
    const page = await browser.newPage({ viewport: vp });
    page.on("console", (m) => { if (m.type() !== "debug") msgs.push(`${m.type()}: ${m.text()}`); });
    page.on("pageerror", (e) => msgs.push(`pageerror: ${e.message}`));
    await page.goto(url);
    return page;
  }
  const box = (page, sel) => page.locator(sel).first().boundingBox();
  const inspectorField = (page, label) => page.evaluate((l) => { const dt = [...document.querySelectorAll("#inspector dt")].find((d) => d.textContent === l); return dt ? dt.nextElementSibling.textContent : null; }, label);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  // ---- Desktop 1280 ----
  let page = await open({ width: 1280, height: 800 });
  const tb = await box(page, ".layout > section.panel:first-child"), ib = await box(page, "#inspector");
  const ratio = tb.width / (tb.width + ib.width);
  check("desktop: event view ~65% / inspector ~35%, side by side", Math.abs(ratio - 0.65) < 0.03 && Math.abs(tb.y - ib.y) < 2 && ib.x > tb.x + tb.width - 1, `event ${Math.round(tb.width)}px, inspector ${Math.round(ib.width)}px, share ${(ratio * 100).toFixed(1)}%`);
  check("desktop: no page-level horizontal overflow", (await overflow(page)) <= 0);
  const hb = await box(page, "header");
  check("desktop: compact header (<= 80 px) with title, run ID, badge, file control", hb.height <= 80 && (await page.locator("header h1").innerText()) === "Trace Inspector" && (await page.locator("#run-info").innerText()).includes("synthetic-001") && (await page.locator("#trace-badge").innerText()) === "Synthetic trace" && (await page.getByLabel("Open trace file").count()) === 1, `header ${Math.round(hb.height)}px`);
  const toolbar = await box(page, ".toolbar");
  check("desktop: toolbar + status row fit in <= 130 px", toolbar.height <= 130, `${Math.round(toolbar.height)}px`);
  const sl = await box(page, "#pos");
  check("desktop: progress slider is wide (>= 300 px)", sl.width >= 300, `${Math.round(sl.width)}px`);
  if (shotDir) await page.screenshot({ path: `${shotDir}/after-desktop-empty.png`, fullPage: true });

  // Keyboard: first Tab stops
  const order = [];
  for (let i = 0; i < 6; i++) { await page.keyboard.press("Tab"); order.push(await page.evaluate(() => document.activeElement.id || document.activeElement.textContent.trim())); }
  check("keyboard order: file control, Play, Step forward (Step back disabled at 0), Reset, slider", order.slice(0, 5).join(",") === "file-input,btn-play,btn-fwd,btn-reset,pos", order.join(" > "));
  await page.reload(); await page.keyboard.press("Tab"); // first Tab stop = the file control
  const focusRing = await page.evaluate(() => { const l = document.querySelector('label[for="file-input"]'); const cs = getComputedStyle(l); return { w: cs.outlineWidth, style: cs.outlineStyle }; });
  check("first Tab stop is the file input", (await page.evaluate(() => document.activeElement.id)) === "file-input");
  check("file control shows a visible focus indicator on its label", focusRing.style !== "none" && parseFloat(focusRing.w) >= 3, JSON.stringify(focusRing));
  await page.focus("#btn-play");
  const playRing = await page.evaluate(() => { const cs = getComputedStyle(document.getElementById("btn-play")); return { w: cs.outlineWidth, style: cs.outlineStyle }; });
  check("Play shows a visible focus indicator", playRing.style !== "none" && parseFloat(playRing.w) >= 3, JSON.stringify(playRing));

  // Diagnosis in 2D (same fixture, position 4)
  for (let i = 0; i < 4; i++) await page.locator("#btn-fwd").click();
  if (shotDir) await page.screenshot({ path: `${shotDir}/after-desktop-e04.png`, fullPage: true });
  check("2D: failure summary shows after e04 with ENOENT and read_file(requirements.txt)", (await page.locator("#failure-summary").isVisible()) && (await page.locator("#failure-summary").innerText()).includes("ENOENT"));
  await page.locator('button[data-event-id="e02"]').click();
  const h2 = await inspectorField(page, "Handoff");
  check("2D: prior handoff e02 = planner → implementer", (await inspectorField(page, "Event ID")) === "e02" && h2 === "planner → implementer", h2);
  await page.locator('#failure-summary button[data-summary-target="e03"]').click();
  check("2D: failed call e03 (read_file, derived Failed)", (await inspectorField(page, "Event ID")) === "e03" && (await inspectorField(page, "Call status (derived)")) === "Failed" && (await inspectorField(page, "toolName")) === "read_file");
  await page.locator('#failure-summary button[data-summary-target="e04"]').click();
  check("2D: explanation e04 (failure, ENOENT, linked call e03)", (await inspectorField(page, "Event ID")) === "e04" && (await inspectorField(page, "Outcome (raw event)")) === "failure" && (await page.locator("#inspector").innerText()).includes("ENOENT") && (await inspectorField(page, "Linked call")).includes("e03"));

  // Diagnosis in 3D (same controller, same state)
  await page.locator("#btn-view-3d").click();
  await page.waitForSelector("#graph-text button[data-edge-id]");
  await page.locator('button[data-edge-id="e02"]').click();
  check("3D: prior handoff e02 = planner → implementer", (await inspectorField(page, "Event ID")) === "e02" && (await inspectorField(page, "Handoff")) === "planner → implementer");
  await page.locator('#graph-text button[data-failure-target="e03"]').click();
  check("3D: failed call e03 (derived Failed)", (await inspectorField(page, "Event ID")) === "e03" && (await inspectorField(page, "Call status (derived)")) === "Failed");
  await page.locator('#graph-text button[data-failure-target="e04"]').click();
  check("3D: explanation e04 (failure, ENOENT)", (await inspectorField(page, "Event ID")) === "e04" && (await page.locator("#inspector").innerText()).includes("ENOENT"));
  if (shotDir) { await page.waitForTimeout(500); await page.screenshot({ path: `${shotDir}/after-desktop-3d.png`, fullPage: true }); }
  check("desktop 3D: no page-level horizontal overflow", (await overflow(page)) <= 0);
  await page.close();

  // ---- Mobile 375 ----
  page = await open({ width: 375, height: 812 });
  check("375: no page-level horizontal overflow (empty state)", (await overflow(page)) <= 0);
  const t2 = await box(page, ".layout > section.panel:first-child"), i2 = await box(page, "#inspector");
  check("375: panels stack (inspector below event view, full width)", i2.y >= t2.y + t2.height - 1 && Math.abs(i2.width - t2.width) < 2, `event ${Math.round(t2.width)}px @y${Math.round(t2.y)}, inspector ${Math.round(i2.width)}px @y${Math.round(i2.y)}`);
  const s2 = await box(page, "#pos");
  check("375: slider still usable (>= 120 px)", s2.width >= 120, `${Math.round(s2.width)}px`);
  const small = await page.evaluate(() => [...document.querySelectorAll("button, label.btn")].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height < 32; }).map((b) => b.id || b.textContent));
  check("375: buttons are at least 32 px tall", small.length === 0, JSON.stringify(small));
  for (let i = 0; i < 4; i++) await page.locator("#btn-fwd").click();
  await page.locator('#failure-summary button[data-summary-target="e03"]').click();
  check("375: no page-level horizontal overflow at e04 with failure summary", (await overflow(page)) <= 0);
  if (shotDir) await page.screenshot({ path: `${shotDir}/after-mobile-e04.png`, fullPage: true });
  await page.locator("#btn-view-3d").click();
  await page.waitForSelector("#graph-text button[data-edge-id]");
  check("375: no page-level horizontal overflow with 3D open", (await overflow(page)) <= 0);
  await page.close();

  check("no console errors/warnings", msgs.filter((m) => !/ReadPixels/.test(m)).length === 0, JSON.stringify(msgs));
  console.log(JSON.stringify({ browser: browser.version(), url, passed: results.filter((r) => r.ok).length, total: results.length }, null, 1));
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  [" + r.detail + "]" : ""}`);
  await browser.close();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
