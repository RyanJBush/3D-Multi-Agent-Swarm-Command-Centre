/* Scripted real-browser checks for the 3D view. Not CI, not human evaluation, and not evidence that 3D
 * is better than 2D. Needs Playwright + Chromium installed separately (not a project dependency) and
 * Python 3 with Pillow (used only to read pixels from canvas screenshots).
 * Usage: node scripts/browser-3d-walkthrough.cjs http://localhost:4173/ [output-dir] */
const { chromium } = require("playwright");
const { spawnSync } = require("child_process");
const fs = require("fs");

const url = process.argv[2] || "http://localhost:4173/";
const outDir = process.argv[3] || "/tmp";
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

/** RGB at points of a PNG file (Pillow). */
function pixels(file, pts) {
  const code = `import sys,json\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert('RGB')\npts=json.loads(sys.argv[2])\nprint(json.dumps([im.getpixel((int(x),int(y))) for x,y in pts]))\ncols=set(im.getdata());print(len(cols))`;
  const r = spawnSync("python3", ["-I", "-c", code, file, JSON.stringify(pts)], { encoding: "utf8" });
  const [a, b] = r.stdout.trim().split("\n");
  return { rgb: JSON.parse(a), distinct: Number(b) };
}

(async () => {
  const browser = await chromium.launch();
  const info = {};
  {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const consoleMsgs = [], requests = [];
    const glPerfNotes = [];
    page.on("console", (m) => {
      if (m.type() === "debug") return;
      // Chromium/SwiftShader driver perf notes caused by the script's own screenshot readbacks; counted, not hidden.
      if (m.type() === "warning" && /GL Driver Message .*ReadPixels/.test(m.text())) glPerfNotes.push(m.text());
      else consoleMsgs.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => consoleMsgs.push("pageerror: " + e.message));
    page.on("request", (r) => requests.push(r.url()));
    await page.goto(url);
    info.webgl = await page.evaluate(() => {
      const g = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
      if (!g) return null;
      const x = g.getExtension("WEBGL_debug_renderer_info");
      return { version: g.getParameter(g.VERSION), renderer: x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : "n/a" };
    });
    const active = () => page.evaluate(() => { const a = document.activeElement; return a ? { id: a.id, key: a.getAttribute("data-focus-key"), text: (a.textContent || "").trim() } : null; });
    async function tabUntil(pred, back = false, max = 60) {
      for (let i = 0; i < max; i++) { await page.keyboard.press(back ? "Shift+Tab" : "Tab"); if (pred(await active())) return true; }
      return false;
    }
    const field = (l) => page.evaluate((l) => { const dt = [...document.querySelectorAll("#inspector dt")].find((d) => d.textContent === l); return dt ? dt.nextElementSibling.textContent : null; }, l);
    const status = () => page.locator("#status").innerText();
    const points = () => page.locator("canvas.graph-canvas").getAttribute("data-pick-points").then(JSON.parse);
    async function clickAt(p) {
      const box = await page.locator("canvas.graph-canvas").boundingBox();
      await page.mouse.click(box.x + p[0], box.y + p[1]);
    }
    async function shot(name) { const f = `${outDir}/${name}.png`; await page.locator("canvas.graph-canvas").screenshot({ path: f }); return f; }

    // --- enter 3D by keyboard at position 0
    check("Tab reaches the Graph (3D) button", await tabUntil((a) => a && a.id === "btn-view-3d"));
    await page.keyboard.press("Enter");
    await page.waitForSelector("canvas.graph-canvas", { timeout: 15000 });
    check("3D view opened; Graph (3D) is pressed; table hidden", (await page.locator("#btn-view-3d").getAttribute("aria-pressed")) === "true" && (await page.locator(".table-wrap").isHidden()));
    const dims = await page.locator("canvas.graph-canvas").boundingBox();
    check("canvas has nonzero size", dims.width > 200 && dims.height > 200, JSON.stringify(dims));
    check("three fixed labelled nodes in text equivalent, all 'No events yet' at position 0",
      (await page.locator("button[data-node-role]").allInnerTexts()).join("|") === "planner — No events yet|implementer — No events yet|reviewer — No events yet");
    let pp = await points();
    check("pick points published for 3 nodes and no edges/failures at position 0", Object.keys(pp.nodes).length === 3 && Object.keys(pp.edges).length === 0 && Object.keys(pp.failures).length === 0);
    const blank = await shot("m1-3d-pos0");
    const px0 = pixels(blank, Object.values(pp.nodes));
    const dom = (c) => c.indexOf(Math.max(...c));
    check("rendered pixels: planner blue-dominant, implementer green-dominant, reviewer purple (r,b > g)",
      dom(px0.rgb[0]) === 2 && dom(px0.rgb[1]) === 1 && px0.rgb[2][0] > px0.rgb[2][1] && px0.rgb[2][2] > px0.rgb[2][1], JSON.stringify(px0.rgb));
    check("canvas is not blank (many distinct colors)", px0.distinct > 50, String(px0.distinct));

    // --- keyboard step to 2 (focus Step forward by Tab)
    check("Tab reaches Step forward", await tabUntil((a) => a && a.id === "btn-fwd", true, 80) || await tabUntil((a) => a && a.id === "btn-fwd", false, 80));
    await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
    check("position 2: edge e02 appears (text + canvas), no e05 anywhere", (await page.locator("button[data-edge-id]").allInnerTexts()).join() === "e02: planner → implementer" && !(await page.locator("#graph-wrap").innerText()).includes("e05"));
    pp = await points();
    check("pick points: edge e02 only", Object.keys(pp.edges).join() === "e02" && Object.keys(pp.failures).length === 0);
    const f2 = await shot("m1-3d-pos2");
    const px2 = pixels(f2, [pp.nodes.planner, pp.nodes.implementer]);
    check("selected agent node is highlighted (planner amber at position 2; implementer still green)", px2.rgb[0][0] > 180 && px2.rgb[0][2] < 120 && dom(px2.rgb[1]) === 1, JSON.stringify(px2.rgb));
    check("edge changes the rendered canvas", fs.readFileSync(f2).compare(fs.readFileSync(blank)) !== 0);

    // --- real mouse clicks on the canvas
    await clickAt(pp.nodes.implementer);
    check("click implementer node at position 2: 'No events yet', selection unchanged (e02)", (await page.locator("#graph-note").innerText()) === "implementer: No events yet." && (await field("Event ID")) === "e02");
    await clickAt(pp.nodes.planner);
    check("click planner node: its LATEST revealed event e02 (not e01)", (await field("Event ID")) === "e02" && (await page.locator("#graph-note").innerText()).includes("latest revealed event, e02"));
    await page.locator("#btn-fwd").focus(); await page.keyboard.press("Enter");
    pp = await points();
    await clickAt(pp.nodes.implementer);
    check("position 3: click implementer node selects e03", (await field("Event ID")) === "e03" && (await field("Call status (derived)")) === "Open (awaiting result)");
    check("position 3: no failure marker, no e04 text", (await page.locator("#graph-text").innerText()).includes("No failures revealed.") && !(await page.locator("#graph-wrap").innerText()).includes("e04"));

    // --- failure marker after e04
    await page.locator("#btn-fwd").focus(); await page.keyboard.press("Enter");
    pp = await points();
    check("position 4: failure marker published for e03 and described in text", Object.keys(pp.failures).join() === "e03" && (await page.locator("#graph-text").innerText()).includes("Failure marker: e03 read_file(requirements.txt) failed with ENOENT. Explained by e04."));
    const f4sel = await shot("m1-3d-pos4-e04-selected");
    const amber = pixels(f4sel, [pp.failures.e03]).rgb[0];
    check("failure marker is highlighted (amber) while e04 is selected", amber[0] > 200 && amber[1] > 120 && amber[2] < 120, JSON.stringify(amber));
    await page.locator('button[data-edge-id="e02"]').click(); // select something else so the marker shows its normal colour
    const f4 = await shot("m1-3d-pos4");
    const redish = pixels(f4, [pp.failures.e03]).rgb[0];
    check("failure marker is rendered red at its pick point when not selected", redish[0] > 150 && redish[1] < 90 && redish[2] < 90, JSON.stringify(redish));
    await clickAt(pp.failures.e03);
    check("click failure marker: failed call e03 (read_file, requirements.txt, derived Failed, raw started)",
      (await field("Event ID")) === "e03" && (await field("toolName")) === "read_file" && (await field("path")) === "requirements.txt" && (await field("Call status (derived)")) === "Failed" && (await field("Outcome (raw event)")) === "started");
    // keyboard path to the explanation
    check("Tab reaches 'Explanation e04'", await tabUntil((a) => a && a.key === "fail:Explanation:e04"));
    await page.keyboard.press("Enter");
    check("Enter on 'Explanation e04': e04, failure, ENOENT, linked call e03", (await field("Event ID")) === "e04" && (await field("Outcome (raw event)")) === "failure" && (await field("errorCode")) === "ENOENT" && (await field("Linked call")) === "e03 (read_file requirements.txt)");

    // --- e02 handoff via the canvas edge
    await clickAt(pp.edges.e02);
    check("click edge e02: planner → implementer handoff in the shared inspector", (await field("Event ID")) === "e02" && (await field("Handoff")) === "planner → implementer" && (await field("message")) === "Read requirements.txt and prepare the patch.");
    check("e03's parent is e02, not e05", await (async () => { await page.locator('button[data-failure-target="e03"]').click(); return (await field("Parent event")) === "e02"; })());

    // --- edges at 5, selected edge pixel highlight, selection pauses playback not tested here
    await page.locator("#btn-fwd").focus(); await page.keyboard.press("Enter");
    pp = await points();
    check("position 5: edges e02 and e05", Object.keys(pp.edges).join() === "e02,e05");
    await clickAt(pp.edges.e05);
    check("click edge e05: implementer → reviewer", (await field("Event ID")) === "e05" && (await field("Handoff")) === "implementer → reviewer" && (await field("Parent event")) === "e04");

    // --- view switching preserves position and selection
    const before = { status: await status(), inspector: await page.locator("#inspector").innerText() };
    await page.locator("#btn-view-2d").focus(); await page.keyboard.press("Enter");
    check("switch to 2D by keyboard: same position, same selected event, same inspector", (await status()) === before.status && (await page.locator("#inspector").innerText()) === before.inspector && (await page.locator("canvas.graph-canvas").count()) === 0);
    await page.locator("#btn-view-3d").focus(); await page.keyboard.press("Enter");
    await page.waitForSelector("canvas.graph-canvas");
    check("back to 3D: same position and selection", (await status()) === before.status && (await page.locator("#inspector").innerText()) === before.inspector);

    // --- playback in 3D: node pick pauses
    await page.locator("#btn-reset").focus(); await page.keyboard.press("Enter");
    await page.locator("#btn-play").focus(); await page.keyboard.press("Enter");
    await page.waitForTimeout(2300);
    check("Play in 3D: ~2 events after 2.3 s", (await status()).includes("Applied 2 of 6"), (await status()).replace(/\n/g, " "));
    pp = await points();
    await clickAt(pp.nodes.planner);
    const paused = await status();
    await page.waitForTimeout(1500);
    check("node click pauses playback; count frozen", paused.includes("Paused") && (await status()) === paused && paused.includes("Applied 2 of 6"));

    // --- layout at phone width
    await page.setViewportSize({ width: 375, height: 800 });
    await page.waitForTimeout(200);
    check("no horizontal page scroll at 375 px with 3D open", !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)));
    await page.setViewportSize({ width: 1100, height: 900 });

    check("no console errors or other warnings during normal 3D use", consoleMsgs.length === 0, JSON.stringify(consoleMsgs));
    info.glDriverReadPixelsWarnings = glPerfNotes.length;
    const origin = new URL(url).origin;
    check("all requests same-origin (incl. the lazy 3D chunk)", requests.every((r) => r.startsWith(origin) || r.startsWith("data:")), JSON.stringify(requests.filter((r) => !r.startsWith(origin))));
    info.lazyChunkRequested = requests.filter((r) => /assets\/.*\.js/.test(r)).map((r) => r.split("/").pop());

    // --- forced real context loss
    await page.locator("#btn-fwd").focus(); await page.keyboard.press("Enter"); // position 3 selected e03
    const bf = { status: await status() };
    await page.evaluate(() => {
      const c = document.querySelector("canvas.graph-canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      gl.getExtension("WEBGL_lose_context").loseContext();
    });
    await page.waitForFunction(() => document.querySelector("#view-alert").textContent.includes("lost its WebGL context"), null, { timeout: 5000 });
    check("context loss: alert shown, 2D table visible, 3D closed", (await page.locator("#btn-view-2d").getAttribute("aria-pressed")) === "true" && (await page.locator(".table-wrap").isVisible()) && (await page.locator("canvas.graph-canvas").count()) === 0);
    check("context loss: replay position and selection preserved", (await status()) === bf.status && (await page.locator("#status").innerText()).includes("Selected:"));
    await page.locator('tbody button[data-event-id="e02"]').click();
    check("after context loss, manual 2D selection works", (await field("Event ID")) === "e02");
    await page.locator("#btn-view-3d").focus(); await page.keyboard.press("Enter");
    await page.waitForSelector("canvas.graph-canvas", { timeout: 15000 });
    check("3D can be re-entered after context loss", (await page.locator("#view-alert").innerText()) === "");
    await page.close();
  }

  // --- real browser with WebGL disabled
  {
    const b2 = await chromium.launch({ args: ["--disable-3d-apis", "--disable-gpu", "--disable-webgl", "--disable-webgl2"] });
    const page = await b2.newPage({ viewport: { width: 1100, height: 900 } });
    await page.goto(url);
    info.webglDisabledProbe = await page.evaluate(() => { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); });
    for (let i = 0; i < 3; i++) await page.locator("#btn-fwd").click();
    await page.locator("#btn-view-3d").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#view-alert").textContent !== "", null, { timeout: 15000 });
    const alertText = await page.locator("#view-alert").innerText();
    check("WebGL disabled in the browser (probe)", info.webglDisabledProbe === false);
    check("init failure: alert explains, 2D stays active with state preserved", alertText.startsWith("3D view unavailable: WebGL is unavailable") && (await page.locator("#btn-view-2d").getAttribute("aria-pressed")) === "true" && (await page.locator("#status").innerText()).includes("Applied 3 of 6"), alertText);
    await page.locator('tbody button[data-event-id="e02"]').click();
    check("no-WebGL: 2D selection works", (await page.evaluate(() => [...document.querySelectorAll("#inspector dt")].find((d) => d.textContent === "Handoff").nextElementSibling.textContent)) === "planner → implementer");
    await b2.close();
  }

  info.browser = browser.version();
  console.log(JSON.stringify({ info, url, passed: results.filter((r) => r.ok).length, total: results.length, failed: results.filter((r) => !r.ok) }, null, 1));
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  -> " + r.detail}`);
  await browser.close();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
