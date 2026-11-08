import { ReplayController, type ReplaySnapshot } from "./controller";
import { buildGraph, latestEventForRole, type View3D, type View3DFactory } from "./graph";
import type { CallStatus } from "./replay";
import type { AgentRole, Trace, TraceEvent, ValidationIssue } from "./types";
import { formatIssue, validateTraceText } from "./validate";

type Tag = keyof HTMLElementTagNameMap;

/** Every value is set through textContent / setAttribute, never innerHTML. */
function el<K extends Tag>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

const display = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

const CALL_LABEL: Record<CallStatus, string> = { open: "Open (awaiting result)", failed: "Failed", succeeded: "Succeeded" };

/** Rebuild `container`'s contents, then restore focus to the element with the same data-focus-key. */
function keepFocus(container: HTMLElement, fallback: () => HTMLElement | null, rebuild: () => void): void {
  const active = document.activeElement;
  const hadFocus = active instanceof HTMLElement && container.contains(active);
  const key = hadFocus ? active.getAttribute("data-focus-key") : null;
  rebuild();
  if (!hadFocus) return;
  const match = key === null ? undefined : [...container.querySelectorAll<HTMLElement>("[data-focus-key]")].find((n) => n.getAttribute("data-focus-key") === key);
  (match ?? fallback())?.focus();
}

/** Loads the Three.js renderer only when the 3D view is first requested (keeps 2D independent of it). */
const defaultView3DFactory: View3DFactory = async (container, handlers) => {
  const mod = await import("./view3d");
  return mod.createView3D(container, handlers);
};

export interface AppOptions {
  /** Injectable for tests; defaults to the lazily loaded Three.js view. */
  readonly createView3D?: View3DFactory;
}

/** Mount the inspector. Everything stays in the page; no network calls are made. */
export function mountApp(root: HTMLElement, initial: Trace | null, initialIssues: readonly ValidationIssue[] = [], options: AppOptions = {}): void {
  const createView3D = options.createView3D ?? defaultView3DFactory;
  let trace: Trace | null = null;
  let controller: ReplayController | null = null;
  let unsubscribe: (() => void) | null = null;
  let issues: readonly ValidationIssue[] = [];
  let loadToken = 0;
  let view: "2d" | "3d" = "2d";
  let view3d: View3D | null = null;
  let viewToken = 0;
  let noteCount = -1;

  root.replaceChildren();

  // Header: title, run ID, trace badge, and the file control (a real, focusable <input type=file> with a styled label).
  const header = el("header", { class: "app-header" });
  const titleBlock = el("div", { class: "title-block" });
  const runInfo = el("p", { id: "run-info", class: "run-info" });
  titleBlock.append(el("h1", {}, "Trace Inspector"), runInfo);
  const traceBadge = el("span", { id: "trace-badge", class: "badge" });
  const fileInput = el("input", { id: "file-input", class: "visually-hidden", type: "file", accept: "application/json,.json", "aria-describedby": "file-hint" });
  const fileLabel = el("label", { for: "file-input", class: "btn" }, "Open trace file");
  const fileHint = el("span", { id: "file-hint", class: "note small" }, "JSON, read locally. Nothing is uploaded.");
  const fileBlock = el("div", { class: "file-block" });
  fileBlock.append(fileInput, fileLabel, fileHint);
  header.append(titleBlock, traceBadge, fileBlock);

  const issuesBox = el("div", { id: "issues", role: "alert" });

  // Replay toolbar: primary Play/Pause, grouped step/reset controls, labelled progress slider.
  const replaySection = el("section", { class: "toolbar", "aria-labelledby": "replay-h" });
  replaySection.append(el("h2", { id: "replay-h", class: "visually-hidden" }, "Replay controls"));
  const controls = el("div", { class: "controls" });
  const btnPlay = el("button", { type: "button", id: "btn-play", class: "primary" }, "Play");
  const stepGroup = el("div", { class: "btn-group", role: "group", "aria-label": "Step and reset" });
  const btnBack = el("button", { type: "button", id: "btn-back" }, "Step back");
  const btnFwd = el("button", { type: "button", id: "btn-fwd" }, "Step forward");
  const btnReset = el("button", { type: "button", id: "btn-reset" }, "Reset");
  stepGroup.append(btnBack, btnFwd, btnReset);
  const sliderWrap = el("div", { class: "slider-wrap" });
  const slider = el("input", { id: "pos", type: "range", min: "0", max: "0", step: "1", value: "0" });
  const sliderValue = el("span", { class: "slider-value", "aria-hidden": "true" });
  sliderWrap.append(el("label", { for: "pos" }, "Replay position"), slider, sliderValue);
  controls.append(btnPlay, stepGroup, sliderWrap);
  // One concise status row. Latest applied (replay head) and Selected (inspector) are labelled separately.
  const status = el("div", { id: "status", class: "status-row", role: "status", "aria-live": "polite" });
  const segApplied = el("span");
  const segPlayback = el("span");
  const segLatest = el("span");
  const segSelected = el("span");
  const segFailures = el("span", { class: "call-failed" });
  status.append(segApplied, segPlayback, segLatest, segSelected, segFailures);
  replaySection.append(controls, status);

  // Failure summary: built only from applied events (see renderFailureSummary).
  const failureBox = el("section", { id: "failure-summary", class: "failure-summary", "aria-labelledby": "failure-h", hidden: "" });

  const layout = el("div", { class: "layout" });
  const tableSection = el("section", { class: "panel", "aria-labelledby": "table-h" });
  const panelHead = el("div", { class: "panel-head" });
  const viewSwitch = el("div", { class: "btn-group", role: "group", "aria-label": "View" });
  const btnView2d = el("button", { type: "button", id: "btn-view-2d", "aria-pressed": "true" }, "Table (2D)");
  const btnView3d = el("button", { type: "button", id: "btn-view-3d", "aria-pressed": "false" }, "Graph (3D)");
  viewSwitch.append(btnView2d, btnView3d);
  panelHead.append(el("h2", { id: "table-h" }, "Revealed events"), viewSwitch);
  const viewAlert = el("div", { id: "view-alert", role: "alert" });
  const tableWrap = el("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": "Revealed events table, scrollable" });
  const graphWrap = el("div", { id: "graph-wrap", hidden: "" });
  tableSection.append(panelHead, viewAlert, tableWrap, graphWrap);
  const inspector = el("section", { id: "inspector", class: "panel", "aria-labelledby": "insp-h" });
  layout.append(tableSection, inspector);

  const main = el("main");
  main.append(issuesBox, replaySection, failureBox, layout);
  root.append(header, main);

  // ---------- rendering ----------
  function renderIssues(): void {
    issuesBox.replaceChildren();
    if (issues.length === 0) return;
    issuesBox.append(el("h2", {}, `Trace rejected: ${issues.length} validation ${issues.length === 1 ? "issue" : "issues"}. No trace is loaded.`));
    const ul = el("ul");
    for (const i of issues) ul.append(el("li", {}, formatIssue(i)));
    issuesBox.append(ul);
  }

  function focusRow(id: string): void {
    // Compare attribute values directly: event IDs are arbitrary strings and must never be spliced into a selector.
    [...tableWrap.querySelectorAll<HTMLElement>("button[data-event-id]")].find((b) => b.getAttribute("data-event-id") === id)?.focus();
  }

  function renderTable(s: ReplaySnapshot | null): void {
    keepFocus(tableWrap, () => btnReset, () => {
      tableWrap.replaceChildren();
      if (!trace || !s) {
        tableWrap.append(el("p", { class: "empty" }, "No trace loaded. Use Open trace file to load a trace JSON file."));
        return;
      }
      if (s.count === 0) {
        tableWrap.append(el("p", { class: "empty" }, `No events applied yet (0 of ${s.total}). Press Play or Step forward to reveal the first event.`));
        return;
      }
      const table = el("table");
      table.append(el("caption", {}, `Run ${trace.runId}: ${s.count} of ${s.total} events revealed, ordered by sequence`));
      const hr = el("tr");
      for (const h of ["Seq", "Event ID", "Time (UTC)", "Role", "Type", "Outcome (raw)", "Status"]) hr.append(el("th", { scope: "col" }, h));
      const thead = el("thead");
      thead.append(hr);
      table.append(thead);
      const tbody = el("tbody");
      for (const e of s.state.applied) {
        const classes = [e.eventId === s.selectedId ? "selected" : "", e.eventId === s.state.latestId ? "latest" : ""].filter(Boolean).join(" ");
        const tr = el("tr", classes ? { class: classes } : {});
        tr.append(el("td", {}, String(e.sequence)));
        const idCell = el("th", { scope: "row" });
        const btn = el("button", { type: "button", "data-event-id": e.eventId, "data-focus-key": `row:${e.eventId}`, "aria-label": `Inspect event ${e.eventId}, ${e.eventType}` }, e.eventId);
        if (e.eventId === s.selectedId) btn.setAttribute("aria-current", "true");
        btn.addEventListener("click", () => controller?.select(e.eventId));
        btn.addEventListener("keydown", (ev) => {
          if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
          const next = s.state.applied[s.state.applied.indexOf(e) + (ev.key === "ArrowDown" ? 1 : -1)];
          if (next) {
            ev.preventDefault();
            focusRow(next.eventId);
          }
        });
        idCell.append(btn);
        const mobileMeta = el("span", { class: "mobile-event-meta" });
        mobileMeta.append(el("span", {}, e.agentRole), el("span", {}, e.eventType.replaceAll("_", " ")));
        idCell.append(mobileMeta);
        if (e.eventId === s.state.latestId) idCell.append(document.createTextNode(" "), el("span", { class: "tag" }, "latest"));
        const time = el("time", { datetime: e.timestamp, title: e.timestamp }, e.timestamp.slice(11, 23));
        const timeCell = el("td", { class: "nowrap timestamp-cell" });
        timeCell.append(time);
        tr.append(idCell, timeCell, el("td", {}, e.agentRole), el("td", {}, e.eventType), el("td", {}, e.outcome));
        const call = s.state.calls.get(e.eventId);
        tr.append(call ? el("td", { class: `call-${call.status}`, title: "Derived from revealed tool results" }, CALL_LABEL[call.status]) : el("td", { class: `event-status outcome-${e.outcome}`, title: "Recorded event outcome" }, e.outcome));
        tbody.append(tr);
      }
      table.append(tbody);
      tableWrap.append(table);
    });
  }

  function dlRow(dl: HTMLElement, term: string, value: string | Node, grouped = false): void {
    const dd = el("dd");
    if (typeof value === "string") dd.textContent = value;
    else dd.append(value);
    if (grouped) {
      const g = el("div");
      g.append(el("dt", {}, term), dd);
      dl.append(g);
    } else dl.append(el("dt", {}, term), dd);
  }

  /** Text-supported outcome chip: the word is always shown; colour is only reinforcement. */
  const outcomeChip = (outcome: string): HTMLElement => el("span", { class: `chip outcome-${outcome}` }, outcome);

  function renderInspector(s: ReplaySnapshot | null): void {
    keepFocus(inspector, () => inspector.querySelector<HTMLElement>("h2"), () => {
      inspector.replaceChildren(el("h2", { id: "insp-h", tabindex: "-1" }, "Event inspector"));
      if (!trace || !s) {
        inspector.append(el("p", { class: "empty" }, "No trace loaded. Open a valid trace file to inspect events."));
        return;
      }
      const ev: TraceEvent | undefined = s.state.applied.find((e) => e.eventId === s.selectedId);
      if (!ev) {
        inspector.append(el("p", { class: "empty" }, s.count === 0 ? "Nothing applied yet. No event is selected. Step forward or press Play, then choose an event." : "No event selected. Choose a revealed event in the table, or follow a link in the failure summary."));
        return;
      }
      const revealed = new Set(s.state.applied.map((e) => e.eventId));
      const link = (id: string | null, key: string, extra = ""): Node => {
        if (id === null) return document.createTextNode("none");
        const wrap = el("span");
        if (revealed.has(id)) {
          const b = el("button", { type: "button", class: "link", "data-focus-key": key }, id);
          b.addEventListener("click", () => controller?.select(id));
          wrap.append(b);
        } else wrap.append(document.createTextNode(`${id} (not yet revealed)`));
        if (extra) wrap.append(document.createTextNode(` ${extra}`));
        return wrap;
      };
      if (s.state.latestId !== ev.eventId)
        inspector.append(el("p", { class: "note" }, `This is not the latest applied event. Latest applied: ${s.state.latestId}.`));
      const call = s.state.calls.get(ev.eventId);

      // 1. Identity: id, role, type, outcome (raw), derived call status.
      const ident = el("dl", { class: "ident" });
      dlRow(ident, "Event ID", el("strong", { class: "ident-id" }, ev.eventId), true);
      dlRow(ident, "Agent role", ev.agentRole, true);
      dlRow(ident, "Event type", ev.eventType, true);
      dlRow(ident, "Outcome (raw event)", outcomeChip(ev.outcome), true);
      if (call) dlRow(ident, "Call status (derived)", el("span", { class: `chip call-${call.status}` }, CALL_LABEL[call.status]), true);
      if (ev.eventType === "handoff") dlRow(ident, "Handoff", `${ev.agentRole} \u2192 ${display(ev.details["toAgentRole"])}`, true);
      inspector.append(ident);

      // 2. Details: position in the trace, then the event's own detail fields.
      inspector.append(el("h3", {}, "Details"));
      const details = el("dl", { class: "details" });
      dlRow(details, "Sequence", String(ev.sequence));
      dlRow(details, "Timestamp (UTC)", ev.timestamp);
      for (const [k, v] of Object.entries(ev.details)) dlRow(details, k, display(v));
      inspector.append(details);

      // 3. Causal / reference links (only to revealed events are clickable).
      inspector.append(el("h3", {}, "Links"));
      const links = el("dl", { class: "links" });
      if (call) dlRow(links, "Result event", link(call.resultId, "ref:result"));
      if (ev.eventType === "tool_result" && ev.relatedEventId !== null) {
        const linked = s.state.applied.find((e) => e.eventId === ev.relatedEventId);
        dlRow(links, "Linked call", link(ev.relatedEventId, "ref:call", linked ? `(${display(linked.details["toolName"])} ${display(linked.details["path"])})` : ""));
      }
      dlRow(links, "Parent event", link(ev.parentEventId, "ref:parent"));
      dlRow(links, "Related event", link(ev.relatedEventId, "ref:related"));
      const by = s.state.referencedBy.get(ev.eventId) ?? [];
      const byNode = el("span");
      if (by.length === 0) byNode.textContent = "none";
      by.forEach((id, i) => {
        if (i > 0) byNode.append(document.createTextNode(" "));
        byNode.append(link(id, `ref:by:${id}`));
      });
      dlRow(links, "Referenced by (revealed events)", byNode);
      inspector.append(links);
    });
  }

  /** Derived only from applied events (buildGraph reads state.applied/calls); empty before the failing result is applied. */
  function renderFailureSummary(s: ReplaySnapshot | null): void {
    const failures = s && trace ? buildGraph(s.state).failures : [];
    keepFocus(failureBox, () => btnReset, () => {
      failureBox.replaceChildren();
      failureBox.hidden = failures.length === 0;
      if (failures.length === 0 || !s) return;
      failureBox.append(el("h2", { id: "failure-h" }, failures.length === 1 ? "Failure summary" : `Failure summary (${failures.length})`));
      for (const f of failures) {
        const p = el("p", { class: "failure-line" });
        p.append(el("strong", { class: "call-failed" }, "Failed: "), document.createTextNode(`${f.role} ${f.toolName}(${f.path}) returned ${f.errorCode}. `));
        for (const [label, id] of [["Failed call", f.callId], ["Explanation", f.resultId]] as const) {
          const b = el("button", { type: "button", class: "link", "data-summary-target": id, "data-focus-key": `sum:${label}:${id}` }, `${label} ${id}`);
          if (id === s.selectedId) b.setAttribute("aria-current", "true");
          b.addEventListener("click", () => controller?.select(id));
          p.append(b, document.createTextNode(" "));
        }
        failureBox.append(p);
        // Follow explicit parent links only; a nearby handoff need not be causal.
        const byId = new Map(s.state.applied.map((e) => [e.eventId, e]));
        let ancestor = byId.get(f.callId);
        const visited = new Set<string>();
        while (ancestor?.parentEventId && !visited.has(ancestor.eventId)) {
          visited.add(ancestor.eventId);
          ancestor = byId.get(ancestor.parentEventId);
          if (ancestor?.eventType === "handoff") {
            const cause = el("p", { class: "causal-handoff" });
            const b = el("button", { type: "button", class: "link", "data-cause-target": ancestor.eventId, "data-focus-key": `cause:${f.callId}` }, `Prior handoff ${ancestor.eventId}`);
            const id = ancestor.eventId;
            b.addEventListener("click", () => controller?.select(id));
            cause.append(b, document.createTextNode(` · ${ancestor.agentRole} → ${display(ancestor.details["toAgentRole"])}`));
            failureBox.append(cause);
            break;
          }
        }
      }
    });
  }

  // ---------- 3D view (shares the same controller; holds no replay state of its own) ----------
  const canvasHost = el("div", { id: "graph-canvas-host" });
  const graphNote = el("p", { id: "graph-note", role: "status", "aria-live": "polite" });
  const graphText = el("div", { id: "graph-text" });

  function setViewButtons(): void {
    btnView2d.setAttribute("aria-pressed", String(view === "2d"));
    btnView3d.setAttribute("aria-pressed", String(view === "3d"));
    tableWrap.hidden = view === "3d";
    graphWrap.hidden = view !== "3d";
  }

  function leave3D(): void {
    viewToken++; // invalidates any in-flight load and stale handlers
    view3d?.dispose();
    view3d = null;
    view = "2d";
    graphWrap.replaceChildren();
    setViewButtons();
  }

  function activateNode(role: AgentRole): void {
    const s = controller?.snapshot;
    if (!controller || !s) return;
    const e = latestEventForRole(s.state, role);
    noteCount = s.count;
    if (!e) {
      graphNote.textContent = `${role}: No events yet.`; // nothing is selected or invented
      return;
    }
    graphNote.textContent = `${role}: selected its latest revealed event, ${e.eventId}.`;
    controller.select(e.eventId);
  }

  function renderGraph(s: ReplaySnapshot): void {
    if (s.count !== noteCount) graphNote.textContent = "";
    const g = buildGraph(s.state);
    keepFocus(graphText, () => btnView3d, () => {
      graphText.replaceChildren(el("h3", {}, "Agent graph (text equivalent of the 3D view)"));
      graphText.append(el("h4", {}, "Agents"));
      const nodes = el("ul");
      for (const n of g.nodes) {
        const li = el("li");
        const b = el("button", { type: "button", "data-node-role": n.role, "data-focus-key": `node:${n.role}` }, `${n.role} \u2014 ${n.latestEventId === null ? "No events yet" : `latest event ${n.latestEventId}`}`);
        if (n.latestEventId !== null && n.latestEventId === s.selectedId) b.setAttribute("aria-current", "true");
        b.addEventListener("click", () => activateNode(n.role));
        li.append(b);
        nodes.append(li);
      }
      graphText.append(nodes, el("h4", {}, "Handoffs"));
      if (g.edges.length === 0) graphText.append(el("p", {}, "No handoffs revealed yet."));
      else {
        const ul = el("ul");
        for (const e of g.edges) {
          const li = el("li");
          const b = el("button", { type: "button", "data-edge-id": e.eventId, "data-focus-key": `edge:${e.eventId}` }, `${e.eventId}: ${e.from} \u2192 ${e.to}`);
          if (e.eventId === s.selectedId) b.setAttribute("aria-current", "true");
          b.addEventListener("click", () => controller?.select(e.eventId));
          li.append(b);
          ul.append(li);
        }
        graphText.append(ul);
      }
      graphText.append(el("h4", {}, "Failures"));
      if (g.failures.length === 0) graphText.append(el("p", {}, "No failures revealed."));
      for (const f of g.failures) {
        const p = el("p", { class: "call-failed" }, `Failure marker: ${f.callId} ${f.toolName}(${f.path}) failed with ${f.errorCode}. Explained by ${f.resultId}. `);
        for (const [label, id] of [["Failed call", f.callId], ["Explanation", f.resultId]] as const) {
          const b = el("button", { type: "button", "data-failure-target": id, "data-focus-key": `fail:${label}:${id}` }, `${label} ${id}`);
          if (id === s.selectedId) b.setAttribute("aria-current", "true");
          b.addEventListener("click", () => controller?.select(id));
          p.append(b, document.createTextNode(" "));
        }
        graphText.append(p);
      }
    });
    view3d?.update(g, s.selectedId);
  }

  async function enter3D(): Promise<void> {
    if (!controller || view === "3d") return;
    const token = ++viewToken;
    view = "3d";
    viewAlert.textContent = "";
    graphWrap.replaceChildren(canvasHost, graphNote, graphText);
    canvasHost.replaceChildren();
    graphNote.textContent = "";
    setViewButtons();
    render();
    try {
      const v = await Promise.resolve().then(() =>
        token !== viewToken ? null : createView3D(canvasHost, {
          onPickNode: (role) => token === viewToken && activateNode(role),
          onPickEdge: (id) => token === viewToken && controller?.select(id),
          onPickFailure: (id) => token === viewToken && controller?.select(id),
          onContextLost: () => {
            if (token !== viewToken) return;
            leave3D();
            viewAlert.textContent = "The 3D view lost its WebGL context and was closed. Showing the 2D table; replay position and selection are unchanged.";
            render();
          },
        }),
      );
      if (token !== viewToken) {
        v?.dispose();
        return;
      }
      if (!v) return;
      view3d = v;
      render();
    } catch (err) {
      if (token !== viewToken) return;
      leave3D();
      viewAlert.textContent = `3D view unavailable: ${err instanceof Error ? err.message : String(err)} The 2D table is still available; replay position and selection are unchanged.`;
      render();
    }
  }

  function render(): void {
    const prev = document.activeElement;
    const s = controller?.snapshot ?? null;
    const total = s?.total ?? 0;
    const count = s?.count ?? 0;
    slider.max = String(total);
    slider.value = String(count);
    slider.setAttribute("aria-valuetext", `${count} of ${total} events applied`);
    slider.disabled = btnReset.disabled = !s;
    btnBack.disabled = !s || count === 0;
    btnFwd.disabled = !s || count >= total;
    btnPlay.disabled = !s || (!s.playing && count >= total);
    btnPlay.textContent = s?.playing ? "Pause" : "Play";
    sliderValue.textContent = `${count} / ${total}`;
    runInfo.textContent = trace ? `Run ${trace.runId} \u00b7 ${total} events` : "No trace loaded.";
    traceBadge.textContent = !trace ? "No trace" : trace.synthetic ? "Synthetic trace" : "Not synthetic";
    traceBadge.className = `badge ${!trace ? "badge-none" : trace.synthetic ? "badge-synthetic" : "badge-real"}`;
    if (!s || !trace) {
      segApplied.textContent = "No trace loaded.";
      segPlayback.textContent = segLatest.textContent = segSelected.textContent = segFailures.textContent = "";
      renderTable(null);
      renderFailureSummary(null);
      renderInspector(null);
    } else {
      segApplied.textContent = `Applied ${count} of ${total}.`;
      segPlayback.textContent = s.playing ? "Playing." : "Paused.";
      segLatest.textContent = `Latest applied: ${s.state.latestId ?? "none"}.`;
      segSelected.textContent = `Selected: ${s.selectedId ?? "none"}.`;
      const nFail = s.state.failedCalls.length;
      segFailures.textContent = nFail > 0 ? `Failures: ${nFail}.` : "";
      renderTable(s);
      renderFailureSummary(s);
      renderInspector(s);
      if (view === "3d") renderGraph(s);
    }
    btnView3d.disabled = !s;
    // A control that just became disabled cannot keep focus; move it somewhere predictable.
    if (prev instanceof HTMLButtonElement && prev.disabled && root.contains(prev)) btnReset.disabled ? fileInput.focus() : btnReset.focus();
  }

  // ---------- loading ----------
  /** Replace all run state. A failed load leaves no prior-run data behind. */
  function setLoaded(next: Trace | null, nextIssues: readonly ValidationIssue[]): void {
    leave3D();
    viewAlert.textContent = "";
    unsubscribe?.();
    controller?.dispose();
    trace = next;
    issues = nextIssues;
    controller = next ? new ReplayController(next) : null;
    unsubscribe = controller ? controller.subscribe(render) : null;
    renderIssues();
    render();
  }

  btnView2d.addEventListener("click", () => {
    if (view === "2d") return;
    leave3D();
    viewAlert.textContent = "";
    render();
  });
  btnView3d.addEventListener("click", () => void enter3D());
  btnReset.addEventListener("click", () => controller?.reset());
  btnBack.addEventListener("click", () => controller?.seek((controller.snapshot.count ?? 0) - 1));
  btnFwd.addEventListener("click", () => controller?.step());
  btnPlay.addEventListener("click", () => (controller?.snapshot.playing ? controller.pause() : controller?.play()));
  slider.addEventListener("input", () => controller?.seek(Number(slider.value)));
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const token = ++loadToken;
    setLoaded(null, []); // drop the previous run immediately; nothing stale can appear as the new trace
    const reader = new FileReader(); // local read only; nothing is transmitted
    reader.onload = () => {
      if (token !== loadToken) return;
      const r = validateTraceText(String(reader.result));
      setLoaded(r.ok ? r.trace : null, r.ok ? [] : r.issues);
    };
    reader.onerror = () => {
      if (token === loadToken) setLoaded(null, [{ code: "INVALID_JSON", path: "$", message: "Could not read the selected file." }]);
    };
    reader.readAsText(file);
  });

  setLoaded(initial, initialIssues);
}
