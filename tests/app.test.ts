// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApp } from "../src/app";
import { PROTO_IDS, QUOTE_IDS, ev, fixtureJson, fixtureText, loadTrace, mutated, trace5 } from "./helpers";

let root: HTMLElement;

describe("diagnostic polish", () => {
  it("reveals the causal handoff only after the failure and preserves replay position when selected", () => {
    step(3);
    expect(root.querySelector("[data-cause-target]")).toBeNull();
    step();
    const cause = root.querySelector<HTMLButtonElement>("[data-cause-target]")!;
    expect(cause.dataset["causeTarget"]).toBe("e02");
    cause.click();
    expect(field("Event ID")).toBe("e02");
    expect($("#status").textContent).toContain("Applied 4 of 6");
    expect(field("Handoff")).toBe("planner → implementer");
    click("#btn-reset");
    expect(root.querySelector("[data-cause-target]")).toBeNull();
  });
  it("keeps role, readable type and status available in the compact table", () => {
    step(4);
    const row = rowBtn("e03")!.closest("tr")!;
    expect(row.querySelector(".mobile-event-meta")!.textContent).toContain("implementer");
    expect(row.querySelector(".mobile-event-meta")!.textContent).toContain("tool call");
    expect(row.lastElementChild!.textContent).toBe("Failed");
    expect(root.querySelector("time")!.getAttribute("datetime")).toBe("2026-11-07T12:00:00.000Z");
    expect(field("Timestamp (UTC)")).toBe("2026-11-07T12:00:03.000Z");
  });
});
const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
const click = (sel: string) => $(sel).click();
const rowBtn = (id: string) => root.querySelector<HTMLButtonElement>(`.table-wrap button[data-event-id="${id}"]`);
const rowIds = () => [...root.querySelectorAll<HTMLButtonElement>("tbody button[data-event-id]")].map((b) => b.dataset["eventId"]);
const step = (n = 1) => { for (let i = 0; i < n; i++) click("#btn-fwd"); };
/** Text of the <dd> for a <dt> label inside the inspector (or null if the row is absent). */
const field = (label: string): string | null => {
  const dt = [...$("#inspector").querySelectorAll("dt")].find((d) => d.textContent === label);
  return dt ? dt.nextElementSibling!.textContent : null;
};
const inspectorLink = (label: string): HTMLButtonElement => {
  const dt = [...$("#inspector").querySelectorAll("dt")].find((d) => d.textContent === label)!;
  return dt.nextElementSibling!.querySelector<HTMLButtonElement>("button")!;
};

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app")!;
  vi.useFakeTimers();
  mountApp(root, loadTrace());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("initial state", () => {
  it("is paused before e01 with nothing applied, shown, or selected", () => {
    expect($("#status").textContent).toContain("Applied 0 of 6.");
    expect($("#status").textContent).toContain("Paused.");
    expect($("#status").textContent).toContain("Selected: none.");
    expect(root.querySelector("table")).toBeNull();
    expect($("#inspector").textContent).toContain("No event is selected");
    expect($("#btn-play").textContent).toBe("Play");
    expect($<HTMLButtonElement>("#btn-back").disabled).toBe(true);
    expect($<HTMLButtonElement>("#btn-fwd").disabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("names the inspector region", () => {
    const labelId = $("#inspector").getAttribute("aria-labelledby")!;
    expect(root.querySelector(`#${labelId}`)!.textContent).toBe("Event inspector");
  });
});

describe("table semantics", () => {
  it("has a caption, scoped column headers, row headers, and named row buttons", () => {
    step(2);
    expect($("table caption").textContent).toBe("Run synthetic-001: 2 of 6 events revealed, ordered by sequence");
    expect([...root.querySelectorAll('thead th[scope="col"]')].map((c) => c.textContent)).toEqual([
      "Seq", "Event ID", "Time (UTC)", "Role", "Type", "Outcome (raw)", "Status",
    ]);
    expect(root.querySelectorAll('tbody th[scope="row"]')).toHaveLength(2);
    expect(rowBtn("e02")!.getAttribute("aria-label")).toBe("Inspect event e02, handoff");
  });
  it("lists only revealed events", () => {
    step(3);
    expect(rowIds()).toEqual(["e01", "e02", "e03"]);
  });
  it("moves focus between rows with ArrowDown / ArrowUp", () => {
    step(3);
    rowBtn("e01")!.focus();
    rowBtn("e01")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(rowBtn("e02"));
    rowBtn("e02")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(rowBtn("e01"));
  });
});

describe("no future leakage in the DOM", () => {
  it("at position 3 nothing about e04..e06, ENOENT, or failure appears anywhere", () => {
    step(3);
    const text = root.textContent!;
    for (const secret of ["e04", "e05", "e06", "ENOENT", "Failed", "failure", "blocked", "reviewer"]) expect(text).not.toContain(secret);
  });
  it("revealed events never link to unrevealed ones", () => {
    step(3);
    expect(root.querySelectorAll('button[data-event-id="e04"]')).toHaveLength(0);
    expect(field("Result event")).toBe("none");
  });
});

describe("step selects the applied event", () => {
  it("selects each new event and marks it with aria-current", () => {
    step();
    expect(rowBtn("e01")!.getAttribute("aria-current")).toBe("true");
    step();
    expect(rowBtn("e02")!.getAttribute("aria-current")).toBe("true");
    expect(rowBtn("e01")!.hasAttribute("aria-current")).toBe(false);
    expect(field("Event ID")).toBe("e02");
  });
});

describe("inspector content for e02 / e03 / e04", () => {
  it("e02 shows planner -> implementer and the task message", () => {
    step(2);
    expect(field("Event ID")).toBe("e02");
    expect(field("Sequence")).toBe("2");
    expect(field("Timestamp (UTC)")).toBe("2026-11-07T12:00:01.000Z");
    expect(field("Agent role")).toBe("planner");
    expect(field("Event type")).toBe("handoff");
    expect(field("Outcome (raw event)")).toBe("success");
    expect(field("Handoff")).toBe("planner → implementer");
    expect(field("toAgentRole")).toBe("implementer");
    expect(field("message")).toBe("Read requirements.txt and prepare the patch.");
    expect(field("Parent event")).toBe("e01");
  });

  it("e03 is OPEN at position 3 with read_file, requirements.txt, and parent e02; raw outcome is started", () => {
    step(3);
    expect(field("Event ID")).toBe("e03");
    expect(field("toolName")).toBe("read_file");
    expect(field("path")).toBe("requirements.txt");
    expect(field("Parent event")).toBe("e02");
    expect(field("Outcome (raw event)")).toBe("started");
    expect(field("Call status (derived)")).toBe("Open (awaiting result)");
    const row = rowBtn("e03")!.closest("tr")!;
    expect(row.lastElementChild!.textContent).toBe("Open (awaiting result)");
  });

  it("e03 is FAILED at position 4 (text, not color alone) while its raw outcome stays started", () => {
    step(4);
    rowBtn("e03")!.click();
    expect(field("Outcome (raw event)")).toBe("started");
    expect(field("Call status (derived)")).toBe("Failed");
    expect(field("Result event")).toBe("e04");
    expect(rowBtn("e03")!.closest("tr")!.lastElementChild!.textContent).toBe("Failed");
    expect(rowBtn("e03")!.closest("tr")!.lastElementChild!.classList.contains("call-failed")).toBe(true);
  });

  it("e04 shows failure, ENOENT, the error message, and the linked call e03", () => {
    step(4);
    expect(field("Event ID")).toBe("e04");
    expect(field("Outcome (raw event)")).toBe("failure");
    expect(field("errorCode")).toBe("ENOENT");
    expect(field("message")).toBe("Synthetic failure: requirements.txt does not exist in the fixture workspace.");
    expect(field("Linked call")).toBe("e03 (read_file requirements.txt)");
    expect(field("Parent event")).toBe("e03");
    expect(field("Related event")).toBe("e03");
  });

  it("references to revealed events are selectable and navigate", () => {
    step(4);
    inspectorLink("Linked call").click();
    expect(field("Event ID")).toBe("e03");
    inspectorLink("Parent event").click();
    expect(field("Event ID")).toBe("e02");
    expect($("#status").textContent).toContain("Latest applied: e04.");
    expect($("#status").textContent).toContain("Selected: e02.");
    expect($("#inspector").textContent).toContain("not the latest applied event");
  });
});

describe("selecting a revealed event", () => {
  it("pauses playback, opens its inspector, and does not change the applied count", () => {
    $("#btn-play").click();
    vi.advanceTimersByTime(2000);
    expect($("#btn-play").textContent).toBe("Pause");
    rowBtn("e01")!.click();
    expect(field("Event ID")).toBe("e01");
    expect($("#status").textContent).toContain("Applied 2 of 6.");
    expect($("#status").textContent).toContain("Paused.");
    expect($("#status").textContent).toContain("Latest applied: e02.");
    expect($("#status").textContent).toContain("Selected: e01.");
    expect($("#btn-play").textContent).toBe("Play");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect($("#status").textContent).toContain("Applied 2 of 6.");
  });
});

describe("playback through the UI", () => {
  it("Play advances one event per 1,000 ms; Pause stops; resume is a fresh interval", () => {
    $("#btn-play").click();
    vi.advanceTimersByTime(1000);
    expect(rowIds()).toEqual(["e01"]);
    $("#btn-play").click(); // Pause
    expect($("#btn-play").textContent).toBe("Play");
    vi.advanceTimersByTime(5000);
    expect(rowIds()).toEqual(["e01"]);
    $("#btn-play").click(); // resume
    vi.advanceTimersByTime(999);
    expect(rowIds()).toEqual(["e01"]);
    vi.advanceTimersByTime(1);
    expect(rowIds()).toEqual(["e01", "e02"]);
  });
  it("repeated clicks alternate Play/Pause and never stack timers", () => {
    for (let i = 0; i < 7; i++) $("#btn-play").click();
    expect(vi.getTimerCount()).toBe(1);
  });
  it("after e06 playback stops, forward Step and Play are disabled", () => {
    $("#btn-play").click();
    vi.advanceTimersByTime(7000);
    expect(rowIds()).toHaveLength(6);
    expect($("#status").textContent).toContain("Paused.");
    expect($<HTMLButtonElement>("#btn-fwd").disabled).toBe(true);
    expect($<HTMLButtonElement>("#btn-play").disabled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(field("Event ID")).toBe("e06");
  });
  it("does not move focus on playback ticks", () => {
    const play = $<HTMLButtonElement>("#btn-play");
    play.focus();
    play.click();
    vi.advanceTimersByTime(3000);
    expect(document.activeElement).toBe(play);
  });
  it("keeps focus on a revealed link while ticks re-render the table and inspector", () => {
    step(2);
    rowBtn("e02")!.focus();
    $("#btn-play").click(); // Play without moving focus
    rowBtn("e02")!.focus();
    vi.advanceTimersByTime(1000);
    expect((document.activeElement as HTMLElement).getAttribute("data-event-id")).toBe("e02");
  });
});

describe("reset and seek", () => {
  it("Reset cancels playback, clears selection and the failure state", () => {
    $("#btn-play").click();
    vi.advanceTimersByTime(4000);
    expect(root.textContent).toContain("Failed");
    click("#btn-reset");
    expect(vi.getTimerCount()).toBe(0);
    expect($("#status").textContent).toContain("Applied 0 of 6.");
    expect($("#status").textContent).toContain("Selected: none.");
    expect(root.querySelector("table")).toBeNull();
    expect(root.textContent).not.toContain("Failed");
    expect(root.textContent).not.toContain("ENOENT");
  });
  it("the slider seeks, pauses, and updates a selection that falls beyond the prefix", () => {
    step(5);
    const slider = $<HTMLInputElement>("#pos");
    slider.value = "3";
    slider.dispatchEvent(new Event("input"));
    expect(rowIds()).toEqual(["e01", "e02", "e03"]);
    expect(field("Event ID")).toBe("e03");
    expect(field("Call status (derived)")).toBe("Open (awaiting result)");
    expect(slider.getAttribute("aria-valuetext")).toBe("3 of 6 events applied");
  });
  it("Step back removes the failure state", () => {
    step(4);
    click("#btn-back");
    expect(root.textContent).not.toContain("ENOENT");
    expect(field("Event ID")).toBe("e03");
    expect(field("Call status (derived)")).toBe("Open (awaiting result)");
  });
});

describe("diagnostic walkthrough (button activation; real Tab/Enter is verified in the browser script)", () => {
  it("identifies the handoff, the failed call, and the explanation, with event IDs", () => {
    step(4);
    // 1. Failed tool call: the only row whose derived status says Failed.
    const failedRows = [...root.querySelectorAll("tbody tr")].filter((r) => r.lastElementChild!.textContent === "Failed");
    expect(failedRows).toHaveLength(1);
    const failedId = failedRows[0]!.querySelector("button")!.dataset["eventId"];
    expect(failedId).toBe("e03");
    rowBtn("e03")!.click();
    expect([field("toolName"), field("path"), field("Agent role")]).toEqual(["read_file", "requirements.txt", "implementer"]);
    // 2. The handoff that led to it: e03's parent.
    expect(field("Parent event")).toBe("e02");
    inspectorLink("Parent event").click();
    expect([field("Event ID"), field("Event type"), field("Handoff")]).toEqual(["e02", "handoff", "planner → implementer"]);
    // 3. The event explaining the failure: e03's result.
    rowBtn("e03")!.click();
    inspectorLink("Result event").click();
    expect([field("Event ID"), field("errorCode")]).toEqual(["e04", "ENOENT"]);
    expect(field("message")).toContain("requirements.txt does not exist");
    // Later consequence, and the two traps.
    step(2);
    rowBtn("e05")!.click();
    expect(field("Handoff")).toBe("implementer → reviewer");
    expect(field("Parent event")).toBe("e04");
    rowBtn("e06")!.click();
    expect(field("Outcome (raw event)")).toBe("blocked");
    rowBtn("e03")!.click();
    expect(field("Parent event")).not.toBe("e05");
    expect(root.querySelectorAll('tbody button[data-event-id]')).toHaveLength(6);
    expect([...root.querySelectorAll("tbody tr")].filter((r) => r.children[4]!.textContent === "tool_call")).toHaveLength(1); // no retry
  });
});

describe("loading and failure behavior", () => {
  async function load(text: string) {
    vi.useRealTimers();
    const input = $<HTMLInputElement>("#file-input");
    Object.defineProperty(input, "files", { value: [new File([text], "t.json", { type: "application/json" })], configurable: true });
    input.dispatchEvent(new Event("change"));
    // Intermediate state is "No trace loaded." with no issues; the final state has issues or a loaded run.
    await vi.waitFor(() => expect($("#issues").textContent !== "" || $("#run-info").textContent!.startsWith("Run ")).toBe(true));
  }

  it("a failed load shows event/field errors and leaves no stale prior-run data", async () => {
    step(4);
    expect(root.textContent).toContain("ENOENT");
    const bad = mutated((t) => { delete ev(t, "e03").details.toolName; ev(t, "e02").timestamp = "2026-02-30T12:00:00.000Z"; });
    await load(JSON.stringify(bad));
    expect($("#issues").getAttribute("role")).toBe("alert");
    expect($("#issues").textContent).toContain("e03 · details.toolName");
    expect($("#issues").textContent).toContain("e02 · timestamp");
    expect(root.querySelector("table")).toBeNull();
    expect($("#run-info").textContent).toBe("No trace loaded.");
    expect($("#status").textContent).toContain("No trace loaded.");
    expect($<HTMLButtonElement>("#btn-fwd").disabled).toBe(true);
    expect($<HTMLButtonElement>("#btn-play").disabled).toBe(true);
    for (const stale of ["synthetic-001", "ENOENT", "requirements.txt", "e04", "Failed"]) expect($("#table-h").closest("section")!.textContent + $("#inspector").textContent! + $("#run-info").textContent).not.toContain(stale);
  });

  it("invalid JSON also clears the previous run", async () => {
    step(2);
    await load("{not json");
    expect($("#issues").textContent).toContain("INVALID_JSON");
    expect(root.querySelector("table")).toBeNull();
    expect($("#inspector").textContent).toContain("Open a valid trace file");
  });

  it("a valid load replaces the run and resets replay and selection", async () => {
    step(3);
    const next = mutated((t) => (t.runId = "other-run"));
    await load(JSON.stringify(next));
    expect($("#issues").textContent).toBe("");
    expect($("#run-info").textContent).toContain("other-run");
    expect($("#status").textContent).toContain("Applied 0 of 6.");
    expect(root.querySelector("table")).toBeNull();
    expect($("#inspector").textContent).toContain("No event is selected");
  });

  it("a shuffled file is normalized by sequence", async () => {
    await load(JSON.stringify(mutated((t) => (t.events = [...t.events].reverse()))));
    step(2);
    expect(rowIds()).toEqual(["e01", "e02"]);
  });

  it("renders untrusted values as text, never HTML", async () => {
    const t = mutated((x) => {
      ev(x, "e01").details.message = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
      ev(x, "e01").agentRole = "planner";
    });
    await load(JSON.stringify(t));
    step(1);
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("script")).toBeNull();
    expect(field("message")).toContain("<img src=x");
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("renders untrusted values in error messages as text", async () => {
    await load(JSON.stringify(mutated((x) => (ev(x, "e02").timestamp = "<img src=x onerror=alert(1)>"))));
    expect(root.querySelector("#issues img")).toBeNull();
    expect($("#issues").textContent).toContain("<img src=x");
  });

  it("makes no network requests", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    step(2);
    await load(fixtureText());
    expect(f).not.toHaveBeenCalled();
  });
});

describe("mounted with an invalid initial trace", () => {
  it("shows the issues and no trace", () => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById("app")!;
    mountApp(root, null, [{ code: "BAD_ENUM", path: "events[0].agentRole", eventId: "e01", field: "agentRole", message: "e01 · agentRole: bad" }]);
    expect($("#issues").textContent).toContain("BAD_ENUM");
    expect(root.querySelector("table")).toBeNull();
    expect($("#inspector").textContent).toContain("Open a valid trace file");
  });
});

it("fixture sanity: canonical run id", () => {
  expect(fixtureJson().runId).toBe("synthetic-001");
});


describe("arbitrary event IDs in the UI", () => {
  function mountWith(ids: Parameters<typeof trace5>[0]) {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById("app")!;
    mountApp(root, loadTrace(trace5(ids)));
  }
  const btn = (id: string) => [...root.querySelectorAll<HTMLButtonElement>("tbody button[data-event-id]")].find((b) => b.getAttribute("data-event-id") === id)!;
  const key = (el: HTMLElement, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

  it("ArrowDown/ArrowUp work when IDs contain quotes, brackets, and backslashes", () => {
    mountWith(QUOTE_IDS);
    step(5);
    btn(QUOTE_IDS.a).focus();
    for (const id of [QUOTE_IDS.b, QUOTE_IDS.c, QUOTE_IDS.d, QUOTE_IDS.e]) {
      key(document.activeElement as HTMLElement, "ArrowDown");
      expect(document.activeElement).toBe(btn(id));
    }
    for (const id of [QUOTE_IDS.d, QUOTE_IDS.c, QUOTE_IDS.b, QUOTE_IDS.a]) {
      key(document.activeElement as HTMLElement, "ArrowUp");
      expect(document.activeElement).toBe(btn(id));
    }
  });

  it("focus on a quote-containing ID survives a playback tick", () => {
    mountWith(QUOTE_IDS);
    step(2);
    btn(QUOTE_IDS.b).focus();
    $("#btn-play").click();
    btn(QUOTE_IDS.b).focus();
    vi.advanceTimersByTime(1000);
    expect(document.activeElement).toBe(btn(QUOTE_IDS.b));
  });

  it("selection, links, and derived status work for IDs like constructor and __proto__", () => {
    mountWith(PROTO_IDS);
    expect(() => step(3)).not.toThrow();
    expect(field("Event ID")).toBe("__proto__");
    expect(field("Call status (derived)")).toBe("Open (awaiting result)");
    step(1);
    expect(btn("__proto__").closest("tr")!.lastElementChild!.textContent).toBe("Failed");
    btn("__proto__").click();
    expect(field("Call status (derived)")).toBe("Failed");
    expect(field("Result event")).toBe("hasOwnProperty");
    inspectorLink("Result event").click();
    expect(field("errorCode")).toBe("ENOENT");
    expect(field("Linked call")).toBe("__proto__ (read_file x.txt)");
    expect(field("Referenced by (revealed events)")).toBe("none");
    btn("constructor").click();
    expect(field("Referenced by (revealed events)")).toBe("toString");
  });
});

describe("design pass: header, toolbar, status row, inspector, failure summary", () => {
  const failureBox = () => $("#failure-summary");
  const summaryBtn = (id: string) => [...failureBox().querySelectorAll<HTMLButtonElement>("button[data-summary-target]")].find((b) => b.dataset["summaryTarget"] === id)!;

  it("header shows title, run ID, a text Synthetic trace badge, and a labelled file control", () => {
    const h = $("header");
    expect(h.querySelector("h1")!.textContent).toBe("Trace Inspector");
    expect($("#run-info").textContent).toBe("Run synthetic-001 · 6 events");
    expect($("#trace-badge").textContent).toBe("Synthetic trace");
    expect(h.contains($("#file-input"))).toBe(true);
    const label = root.querySelector<HTMLLabelElement>('label[for="file-input"]')!;
    expect(label.textContent).toBe("Open trace file");
    expect(($("#file-input") as HTMLInputElement).type).toBe("file");
    expect($("#file-input").hasAttribute("hidden")).toBe(false); // visually hidden but focusable, never display:none/hidden
    expect($("#file-input").getAttribute("aria-describedby")).toBe("file-hint");
  });
  it("badge is text and says so when no trace is loaded", () => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById("app")!;
    mountApp(root, null);
    expect($("#trace-badge").textContent).toBe("No trace");
    expect($("#run-info").textContent).toBe("No trace loaded.");
  });
  it("toolbar: Play is the primary control, step/reset are one labelled group, slider has a visible label", () => {
    expect($("#btn-play").classList.contains("primary")).toBe(true);
    const group = $('[role="group"][aria-label="Step and reset"]');
    expect([...group.querySelectorAll("button")].map((b) => b.id)).toEqual(["btn-back", "btn-fwd", "btn-reset"]);
    expect(root.querySelector('label[for="pos"]')!.textContent).toBe("Replay position");
    step(2);
    expect($(".slider-value").textContent).toBe("2 / 6");
  });
  it("status is one live row with separate Latest applied and Selected segments", () => {
    expect($("#status").getAttribute("role")).toBe("status");
    expect($("#status").querySelectorAll("p")).toHaveLength(0);
    step(3);
    rowBtn("e01")!.click();
    expect($("#status").textContent).toBe("Applied 3 of 6.Paused.Latest applied: e03.Selected: e01.");
    click("#btn-play");
    expect($("#status").textContent).toContain("Playing.");
  });
  it("latest applied row carries a text tag, independent of the selected row", () => {
    step(3);
    rowBtn("e01")!.click();
    expect(root.querySelectorAll("tbody .tag")).toHaveLength(1);
    expect(rowBtn("e03")!.closest("tr")!.textContent).toContain("latest");
    expect(rowBtn("e01")!.closest("tr")!.classList.contains("selected")).toBe(true);
    expect(rowBtn("e01")!.closest("tr")!.textContent).not.toContain("latest");
  });
  it("two-column container and panels exist for the layout", () => {
    const layout = $(".layout");
    expect([...layout.children].map((c) => c.id || c.className)).toEqual(["panel", "inspector"]);
    expect($("#inspector").getAttribute("aria-labelledby")).toBe("insp-h");
  });
  it("inspector order: identity, then Details, then Links; outcome and call status are text chips", () => {
    step(4);
    rowBtn("e04")!.click();
    const kids = [...$("#inspector").children].map((c) => c.tagName + ":" + (c.className || c.textContent));
    expect(kids.slice(0, 2)).toEqual(["H2:Event inspector", "DL:ident"]);
    expect([...$("#inspector").querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Details", "Links"]);
    const identLabels = [...$("#inspector").querySelectorAll("dl.ident dt")].map((d) => d.textContent);
    expect(identLabels).toEqual(["Event ID", "Agent role", "Event type", "Outcome (raw event)"]);
    expect(field("Outcome (raw event)")).toBe("failure");
    expect(field("Parent event")).toBe("e03");
    expect(field("Linked call")).toContain("e03");
  });
  it("failure summary is absent before the failing result is applied and leaks nothing about it", () => {
    step(3);
    expect(failureBox().hidden).toBe(true);
    expect(failureBox().textContent).toBe("");
    expect(root.textContent).not.toContain("ENOENT");
    expect($("#status").textContent).not.toContain("Failures");
  });
  it("failure summary appears from e04, links to the failed call and explanation, and updates the inspector", () => {
    step(4);
    expect(failureBox().hidden).toBe(false);
    expect(failureBox().textContent).toContain("ENOENT");
    expect(failureBox().textContent).toContain("read_file(requirements.txt)");
    expect($("#status").textContent).toContain("Failures: 1.");
    summaryBtn("e03").click();
    expect(field("Event ID")).toBe("e03");
    expect(summaryBtn("e03").getAttribute("aria-current")).toBe("true");
    summaryBtn("e04").click();
    expect(field("Event ID")).toBe("e04");
  });
  it("failure summary disappears again on Step back, Reset, and seek", () => {
    step(4);
    click("#btn-back");
    expect(failureBox().hidden).toBe(true);
    step(1);
    expect(failureBox().hidden).toBe(false);
    click("#btn-reset");
    expect(failureBox().hidden).toBe(true);
    expect(failureBox().textContent).toBe("");
  });
  it("focus stays on the activated failure-summary link after the re-render", () => {
    step(4);
    summaryBtn("e04").focus();
    summaryBtn("e04").click();
    expect(document.activeElement).toBe(summaryBtn("e04"));
  });
  it("empty states say what to do next", () => {
    expect($(".table-wrap").textContent).toContain("Press Play or Step forward");
    expect($("#inspector").textContent).toContain("No event is selected");
    step(1);
    click("#btn-reset");
    expect($(".table-wrap").textContent).toContain("No events applied yet (0 of 6)");
  });
});
