/* Real-browser keyboard walkthrough. Not part of CI.
 * Needs Playwright with Chromium installed separately (it is NOT a project dependency).
 * Usage: node scripts/browser-walkthrough.cjs http://localhost:5173/ [screenshot-dir]
 * Uses only Tab, Shift+Tab, Enter, and Space after load. Exits 1 if any check fails. */
const { chromium } = require("playwright");

const url = process.argv[2] || "http://localhost:5173/";
const shotDir = process.argv[3];
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const consoleMsgs = [];
  const requests = [];
  page.on("console", (m) => { if (m.type() !== "debug") consoleMsgs.push(`${m.type()}: ${m.text()}`); }); // Vite client debug chatter ignored
  page.on("pageerror", (e) => consoleMsgs.push(`pageerror: ${e.message}`));
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(url);

  const active = () => page.evaluate(() => {
    const a = document.activeElement;
    return a ? { id: a.id, tag: a.tagName, eventId: a.getAttribute("data-event-id"), key: a.getAttribute("data-focus-key"), text: (a.textContent || "").trim() } : null;
  });
  async function tabUntil(pred, { back = false, max = 40 } = {}) {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press(back ? "Shift+Tab" : "Tab");
      if (pred(await active())) return true;
    }
    return false;
  }
  const field = (label) => page.evaluate((l) => {
    const dt = [...document.querySelectorAll("#inspector dt")].find((d) => d.textContent === l);
    return dt ? dt.nextElementSibling.textContent : null;
  }, label);
  const status = () => page.locator("#status").innerText();
  const rows = () => page.locator("tbody button[data-event-id]").evaluateAll((bs) => bs.map((b) => b.dataset.eventId));

  // Initial state
  check("initial: 0 applied, nothing selected, no table", (await status()).includes("Applied 0 of 6") && (await status()).includes("Selected: none") && (await page.locator("table").count()) === 0);

  // Step forward x4 with Enter, then once with Space
  check("Tab reaches Step forward", await tabUntil((a) => a && a.id === "btn-fwd"));
  for (let i = 0; i < 3; i++) await page.keyboard.press("Enter");
  check("position 3: e03 selected and OPEN", (await field("Event ID")) === "e03" && (await field("Call status (derived)")) === "Open (awaiting result)", await field("Call status (derived)"));
  check("position 3: no e04 / ENOENT anywhere in the page", !(await page.locator("body").innerText()).match(/e04|ENOENT|Failed/));
  await page.keyboard.press("Space");
  check("position 4 via Space: e04 selected, failure + ENOENT + linked call e03",
    (await field("Event ID")) === "e04" && (await field("Outcome (raw event)")) === "failure" && (await field("errorCode")) === "ENOENT" && (await field("Linked call")) === "e03 (read_file requirements.txt)");
  check("focus stayed on Step forward after activation", (await active()).id === "btn-fwd");

  // Answer 1: the failed call, found by keyboard in the table
  check("Tab reaches row e03", await tabUntil((a) => a && a.eventId === "e03", { max: 30 }));
  await page.keyboard.press("Enter");
  check("e03 inspector: read_file, requirements.txt, parent e02, raw outcome started, derived Failed",
    (await field("toolName")) === "read_file" && (await field("path")) === "requirements.txt" && (await field("Parent event")) === "e02" &&
    (await field("Outcome (raw event)")) === "started" && (await field("Call status (derived)")) === "Failed");
  const failedRows = await page.locator("tbody tr").evaluateAll((trs) => trs.filter((t) => t.lastElementChild.textContent === "Failed").map((t) => t.querySelector("button").dataset.eventId));
  check("only e03 is Failed in the table", JSON.stringify(failedRows) === '["e03"]', JSON.stringify(failedRows));

  // Answer 2: the handoff that led to it (follow the Parent link with the keyboard)
  check("Tab reaches the Parent event link", await tabUntil((a) => a && a.key === "ref:parent"));
  await page.keyboard.press("Enter");
  check("parent link opens e02: planner → implementer", (await field("Event ID")) === "e02" && (await field("Handoff")) === "planner → implementer", await field("Handoff"));
  check("focus not lost to <body> after following a link", (await active()).tag !== "BODY", JSON.stringify(await active()));

  // Answer 3: the explanation (back to e03, follow the Result link)
  check("Shift+Tab returns to row e03", await tabUntil((a) => a && a.eventId === "e03", { back: true, max: 30 }));
  await page.keyboard.press("Enter");
  check("Tab reaches the Result event link", await tabUntil((a) => a && a.key === "ref:result"));
  await page.keyboard.press("Enter");
  check("result link opens e04 with ENOENT", (await field("Event ID")) === "e04" && (await field("errorCode")) === "ENOENT");
  check("applied count unchanged by selection (still 4)", (await status()).includes("Applied 4 of 6") && (await status()).includes("Latest applied: e04"));

  // Later consequence
  check("Shift+Tab/Tab back to Step forward", await tabUntil((a) => a && a.id === "btn-fwd", { back: true, max: 40 }));
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  check("e06 reached; forward Step disabled", (await field("Event ID")) === "e06" && (await field("Outcome (raw event)")) === "blocked" && (await page.locator("#btn-fwd").isDisabled()));
  check("six rows revealed; exactly one tool_call (no retry)",
    (await rows()).length === 6 && (await page.locator("tbody tr").evaluateAll((trs) => trs.filter((t) => t.children[4].textContent === "tool_call").length)) === 1);
  if (shotDir) await page.screenshot({ path: `${shotDir}/m1-end-of-run.png` });

  // Reset by keyboard, then Play/Pause/select
  check("Tab/Shift+Tab reaches Reset", await tabUntil((a) => a && a.id === "btn-reset", { back: true, max: 60 }));
  await page.keyboard.press("Enter");
  check("Reset: 0 applied, nothing selected, no failure text", (await status()).includes("Applied 0 of 6") && (await status()).includes("Selected: none") && !(await page.locator("body").innerText()).match(/ENOENT|Failed/));
  check("Tab reaches Play", await tabUntil((a) => a && a.id === "btn-play"));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  check("0.5 s after Play: still 0 applied (1,000 ms interval)", (await status()).includes("Applied 0 of 6"));
  await page.waitForTimeout(1700);
  const mid = await status();
  check("~2.2 s after Play: 2 applied, playing, focus still on the Pause button", mid.includes("Applied 2 of 6") && mid.includes("Playing") && (await active()).id === "btn-play" && (await page.locator("#btn-play").innerText()) === "Pause", mid.replace(/\n/g, " "));
  await page.keyboard.press("Space"); // Pause
  const pausedAt = await status();
  await page.waitForTimeout(1500);
  check("Pause: count frozen", (await status()) === pausedAt && pausedAt.includes("Paused"));
  await page.keyboard.press("Enter"); // resume
  await page.waitForTimeout(700);
  check("resume: no immediate tick (fresh interval)", (await status()).includes("Applied 2 of 6"));
  await page.waitForTimeout(500);
  check("resume: tick ~1 s after resume", (await status()).includes("Applied 3 of 6"));
  check("Tab reaches a row button while playing; Enter pauses playback and keeps count", await tabUntil((a) => a && a.eventId === "e01"));
  await page.keyboard.press("Enter");
  const afterSel = await status();
  check("selecting e01: paused, applied unchanged, latest e03 vs selected e01", afterSel.includes("Paused") && afterSel.includes("Applied 3 of 6") && afterSel.includes("Latest applied: e03") && afterSel.includes("Selected: e01"), afterSel.replace(/\n/g, " "));

  // Layout at phone width
  await page.setViewportSize({ width: 375, height: 800 });
  check("no horizontal page scroll at 375 px", !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)));

  check("no console errors/warnings", consoleMsgs.length === 0, JSON.stringify(consoleMsgs));
  const origin = new URL(url).origin;
  check("no requests outside the page origin", requests.every((r) => r.startsWith(origin) || r.startsWith("data:")), JSON.stringify(requests.filter((r) => !r.startsWith(origin))));

  console.log(JSON.stringify({ browser: browser.version(), url, passed: results.filter((r) => r.ok).length, total: results.length, failed: results.filter((r) => !r.ok) }, null, 1));
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  -> " + r.detail}`);
  await browser.close();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
