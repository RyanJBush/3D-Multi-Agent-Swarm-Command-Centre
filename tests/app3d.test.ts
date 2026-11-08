// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { mountApp } from "../src/app";
import type { GraphModel, View3D, View3DFactory, View3DHandlers } from "../src/graph";
import { loadTrace } from "./helpers";

interface FakeView { handlers: View3DHandlers; container: HTMLElement; update: Mock<(g: GraphModel, selected: string | null) => void>; dispose: Mock<() => void> }
let root: HTMLElement;
let views: FakeView[];
let factory: Mock<View3DFactory>;

const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
const text = (sel: string) => $(sel).textContent!;
const flush = () => vi.advanceTimersByTimeAsync(0);
const step = (n = 1) => { for (let i = 0; i < n; i++) $("#btn-fwd").click(); };
const rowBtn = (id: string) => [...root.querySelectorAll<HTMLButtonElement>("tbody button[data-event-id]")].find((b) => b.dataset["eventId"] === id)!;
const nodeBtn = (role: string) => root.querySelector<HTMLButtonElement>(`button[data-node-role="${role}"]`)!;
const edgeBtn = (id: string) => [...root.querySelectorAll<HTMLButtonElement>("button[data-edge-id]")].find((b) => b.dataset["edgeId"] === id)!;
const failBtn = (id: string) => [...root.querySelectorAll<HTMLButtonElement>("button[data-failure-target]")].find((b) => b.dataset["failureTarget"] === id)!;
const field = (label: string): string | null => {
  const dt = [...$("#inspector").querySelectorAll("dt")].find((d) => d.textContent === label);
  return dt ? dt.nextElementSibling!.textContent : null;
};
const lastGraph = (): GraphModel => views[views.length - 1]!.update.mock.lastCall![0] as GraphModel;
const lastSelected = () => views[views.length - 1]!.update.mock.lastCall![1] as string | null;
const edgeIds = () => [...root.querySelectorAll("button[data-edge-id]")].map((b) => (b as HTMLElement).dataset["edgeId"]);
const go3d = async () => { $("#btn-view-3d").click(); await flush(); };

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app")!;
  vi.useFakeTimers();
  views = [];
  factory = vi.fn<View3DFactory>(async (container, handlers) => {
    const v: FakeView = { handlers, container, update: vi.fn(), dispose: vi.fn() };
    views.push(v);
    return v satisfies View3D;
  });
  mountApp(root, loadTrace(), [], { createView3D: factory });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("view switching shares one replay state", () => {
  it("starts in 2D, without loading the 3D view", () => {
    expect($("#btn-view-2d").getAttribute("aria-pressed")).toBe("true");
    expect($("#btn-view-3d").getAttribute("aria-pressed")).toBe("false");
    expect($("#graph-wrap").hidden).toBe(true);
    expect(factory).not.toHaveBeenCalled();
  });

  it("shows three fixed labelled nodes immediately in 3D, even at position 0", async () => {
    await go3d();
    expect(factory).toHaveBeenCalledTimes(1);
    expect($("#graph-wrap").hidden).toBe(false);
    expect($<HTMLElement>(".table-wrap").hidden).toBe(true);
    expect(["planner", "implementer", "reviewer"].map((r) => nodeBtn(r).textContent)).toEqual([
      "planner — No events yet", "implementer — No events yet", "reviewer — No events yet",
    ]);
    expect(views[0]!.container).toBe($("#graph-canvas-host"));
  });

  it("preserves replay position and selected event across 2D -> 3D -> 2D", async () => {
    step(4);
    rowBtn("e02").click();
    const before = { status: text("#status"), inspector: text("#inspector") };
    await go3d();
    expect(text("#status")).toBe(before.status);
    expect(text("#inspector")).toBe(before.inspector);
    expect(field("Event ID")).toBe("e02");
    expect(lastSelected()).toBe("e02");
    $("#btn-view-2d").click();
    expect(text("#status")).toBe(before.status);
    expect(text("#inspector")).toBe(before.inspector);
    expect(rowBtn("e02").getAttribute("aria-current")).toBe("true");
    expect([...root.querySelectorAll("tbody button")].length).toBe(4);
  });

  it("replay controls drive the same state while 3D is showing", async () => {
    await go3d();
    step(3);
    expect(text("#status")).toContain("Applied 3 of 6.");
    $("#btn-view-2d").click();
    expect(root.querySelectorAll("tbody button")).toHaveLength(3);
    expect(field("Event ID")).toBe("e03");
  });

  it("pushes the derived graph and selection to the view on every change", async () => {
    await go3d();
    const calls = views[0]!.update.mock.calls.length;
    step(2);
    expect(views[0]!.update.mock.calls.length).toBeGreaterThan(calls);
    expect(lastSelected()).toBe("e02");
    expect(lastGraph().edges.map((e) => e.eventId)).toEqual(["e02"]);
  });

  it("disposes the view when leaving 3D and creates a fresh one when re-entering", async () => {
    await go3d();
    $("#btn-view-2d").click();
    expect(views[0]!.dispose).toHaveBeenCalledTimes(1);
    await go3d();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(views[1]!.dispose).not.toHaveBeenCalled();
  });

  it("repeated 3D clicks never create more than one view", async () => {
    $("#btn-view-3d").click();
    $("#btn-view-3d").click();
    await flush();
    $("#btn-view-3d").click();
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("leaving 3D while it is still loading disposes the view when it arrives", async () => {
    let resolve!: (v: View3D) => void;
    factory.mockImplementationOnce(() => new Promise<View3D>((r) => (resolve = r)));
    $("#btn-view-3d").click();
    await flush(); // factory has been called and is pending
    $("#btn-view-2d").click();
    const late = { update: vi.fn(), dispose: vi.fn() };
    resolve(late);
    await flush();
    expect(late.dispose).toHaveBeenCalledTimes(1);
    expect($("#btn-view-2d").getAttribute("aria-pressed")).toBe("true");
    expect(late.update).not.toHaveBeenCalled();
  });

  it("leaving 3D before the view even starts loading never calls the factory", async () => {
    $("#btn-view-3d").click();
    $("#btn-view-2d").click();
    await flush();
    expect(factory).not.toHaveBeenCalled();
    expect($("#btn-view-2d").getAttribute("aria-pressed")).toBe("true");
  });

  it("the 3D button is disabled when no trace is loaded", () => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById("app")!;
    mountApp(root, null, [], { createView3D: factory });
    expect($<HTMLButtonElement>("#btn-view-3d").disabled).toBe(true);
  });
});

describe("agent nodes", () => {
  it("selecting a node selects that agent's LATEST revealed event", async () => {
    await go3d();
    step(2);
    nodeBtn("planner").click();
    expect(field("Event ID")).toBe("e02"); // not e01
    expect(text("#graph-note")).toContain("planner: selected its latest revealed event, e02.");
    expect(nodeBtn("planner").getAttribute("aria-current")).toBe("true");
  });

  it("a node with no events shows 'No events yet' and invents nothing", async () => {
    await go3d();
    step(2);
    const before = text("#status");
    nodeBtn("implementer").click();
    expect(text("#graph-note")).toBe("implementer: No events yet.");
    expect(text("#status")).toBe(before);
    expect(field("Event ID")).toBe("e02"); // selection unchanged
  });

  it("a node with no events leaves a DIFFERENT earlier selection untouched (latest applied is e03)", async () => {
    await go3d();
    step(3);
    edgeBtn("e02").click(); // selection e02, while the latest applied event is e03
    nodeBtn("reviewer").click();
    expect(text("#graph-note")).toBe("reviewer: No events yet.");
    expect(text("#status")).toContain("Selected: e02.");
    expect(text("#status")).toContain("Latest applied: e03.");
    expect(field("Event ID")).toBe("e02");
  });

  it("at position 0 a node click preserves the current (empty) selection", async () => {
    await go3d();
    nodeBtn("planner").click();
    expect(text("#graph-note")).toBe("planner: No events yet.");
    expect(text("#status")).toContain("Selected: none.");
  });

  it("the 'No events yet' note clears once the replay position changes", async () => {
    await go3d();
    nodeBtn("reviewer").click();
    expect(text("#graph-note")).toContain("No events yet");
    step(1);
    expect(text("#graph-note")).toBe("");
  });

  it("picks from the 3D view behave the same as the text controls", async () => {
    await go3d();
    step(3);
    views[0]!.handlers.onPickNode("implementer");
    expect(field("Event ID")).toBe("e03");
    views[0]!.handlers.onPickNode("reviewer");
    expect(text("#graph-note")).toBe("reviewer: No events yet.");
    expect(field("Event ID")).toBe("e03");
  });

  it("selecting a node pauses playback and leaves the applied count unchanged", async () => {
    await go3d();
    $("#btn-play").click();
    vi.advanceTimersByTime(2000);
    views[0]!.handlers.onPickNode("planner");
    expect(text("#status")).toContain("Applied 2 of 6.");
    expect(text("#status")).toContain("Paused.");
    expect(field("Event ID")).toBe("e02");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reviewer's node reaches e06 at the end of the run", async () => {
    await go3d();
    step(6);
    nodeBtn("reviewer").click();
    expect(field("Event ID")).toBe("e06");
    expect(field("Outcome (raw event)")).toBe("blocked");
  });
});

describe("handoff edges", () => {
  it("appear only as their events are applied", async () => {
    await go3d();
    expect(edgeIds()).toEqual([]);
    expect(text("#graph-text")).toContain("No handoffs revealed yet.");
    step(1);
    expect(edgeIds()).toEqual([]);
    step(1);
    expect(edgeIds()).toEqual(["e02"]);
    expect(edgeBtn("e02").textContent).toBe("e02: planner → implementer");
    step(2);
    expect(edgeIds()).toEqual(["e02"]);
    expect(root.textContent).not.toContain("e05");
    expect(lastGraph().edges.map((e) => e.eventId)).toEqual(["e02"]);
    step(1);
    expect(edgeIds()).toEqual(["e02", "e05"]);
    expect(edgeBtn("e05").textContent).toBe("e05: implementer → reviewer");
    expect(lastGraph().edges.map((e) => e.eventId)).toEqual(["e02", "e05"]);
  });

  it("selecting an edge opens its event in the shared inspector", async () => {
    await go3d();
    step(5);
    edgeBtn("e05").click();
    expect([field("Event ID"), field("Handoff"), field("Parent event")]).toEqual(["e05", "implementer → reviewer", "e04"]);
    expect(field("message")).toBe("Diagnose the failed file read; no patch was produced.");
    edgeBtn("e02").click();
    expect([field("Event ID"), field("Handoff")]).toEqual(["e02", "planner → implementer"]);
    expect(field("message")).toBe("Read requirements.txt and prepare the patch.");
    expect(edgeBtn("e02").getAttribute("aria-current")).toBe("true");
  });

  it("an edge pick from the 3D view works, and an unrevealed edge cannot be picked", async () => {
    await go3d();
    step(3);
    views[0]!.handlers.onPickEdge("e02");
    expect(field("Event ID")).toBe("e02");
    views[0]!.handlers.onPickEdge("e05"); // not revealed
    expect(field("Event ID")).toBe("e02");
  });

  it("e05 is never offered as the handoff that preceded e03", async () => {
    await go3d();
    step(4);
    edgeBtn("e02").click();
    rowBtnFrom3D();
    function rowBtnFrom3D() { $("#btn-view-2d").click(); rowBtn("e03").click(); }
    expect(field("Parent event")).toBe("e02");
  });
});

describe("failure marker", () => {
  it("is absent before e04 and leaks nothing about it", async () => {
    await go3d();
    step(3);
    expect(text("#graph-text")).toContain("No failures revealed.");
    expect(lastGraph().failures).toEqual([]);
    for (const s of ["e04", "ENOENT", "Failure marker"]) expect(text("#graph-wrap")).not.toContain(s);
  });

  it("appears after e04 as text naming the failed call and its explanation", async () => {
    await go3d();
    step(4);
    expect(text("#graph-text")).toContain("Failure marker: e03 read_file(requirements.txt) failed with ENOENT. Explained by e04.");
    expect(lastGraph().failures.map((f) => [f.callId, f.resultId])).toEqual([["e03", "e04"]]);
  });

  it("gives access to the failed call e03 and the explanation e04", async () => {
    await go3d();
    step(4);
    failBtn("e03").click();
    expect([field("Event ID"), field("toolName"), field("path"), field("Call status (derived)"), field("Outcome (raw event)")]).toEqual(["e03", "read_file", "requirements.txt", "Failed", "started"]);
    failBtn("e04").click();
    expect([field("Event ID"), field("errorCode"), field("Linked call")]).toEqual(["e04", "ENOENT", "e03 (read_file requirements.txt)"]);
  });

  it("a pick on the 3D marker selects the failed call", async () => {
    await go3d();
    step(4);
    views[0]!.handlers.onPickFailure("e03");
    expect(field("Event ID")).toBe("e03");
  });

  it("disappears on Reset and when stepping back before e04", async () => {
    await go3d();
    step(5);
    $("#btn-back").click();
    $("#btn-back").click();
    expect(text("#graph-text")).toContain("No failures revealed.");
    step(1);
    expect(text("#graph-text")).toContain("Failure marker");
    $("#btn-reset").click();
    expect(text("#graph-text")).toContain("No failures revealed.");
    expect(root.textContent).not.toContain("ENOENT");
    expect(lastGraph().failures).toEqual([]);
  });
});

describe("keyboard / focus in the text equivalent", () => {
  it("keeps focus on a graph control across playback ticks", async () => {
    await go3d();
    step(2);
    edgeBtn("e02").focus();
    $("#btn-play").click();
    edgeBtn("e02").focus();
    vi.advanceTimersByTime(1000);
    expect(document.activeElement).toBe(edgeBtn("e02"));
  });
});

describe("fallback to 2D", () => {
  it("initialization failure: shows an alert, stays in 2D, keeps state, 2D selection works", async () => {
    step(3);
    factory.mockRejectedValueOnce(new Error("WebGL is unavailable (test)."));
    await go3d();
    expect($("#view-alert").getAttribute("role")).toBe("alert");
    expect(text("#view-alert")).toContain("3D view unavailable: WebGL is unavailable (test).");
    expect(text("#view-alert")).toContain("2D table is still available");
    expect($("#btn-view-2d").getAttribute("aria-pressed")).toBe("true");
    expect($("#btn-view-3d").getAttribute("aria-pressed")).toBe("false");
    expect($("#graph-wrap").hidden).toBe(true);
    expect($("#graph-wrap").childElementCount).toBe(0);
    expect(text("#status")).toContain("Applied 3 of 6.");
    rowBtn("e02").click();
    expect(field("Event ID")).toBe("e02");
  });

  it("a synchronous throw from the factory is handled the same way", async () => {
    factory.mockImplementationOnce(() => { throw new Error("sync boom"); });
    await go3d();
    expect(text("#view-alert")).toContain("3D view unavailable: sync boom");
    expect($("#btn-view-2d").getAttribute("aria-pressed")).toBe("true");
  });

  it("can retry 3D after a failure, which clears the alert", async () => {
    factory.mockRejectedValueOnce(new Error("nope"));
    await go3d();
    expect(text("#view-alert")).not.toBe("");
    await go3d();
    expect(text("#view-alert")).toBe("");
    expect($("#btn-view-3d").getAttribute("aria-pressed")).toBe("true");
  });

  it("context loss: returns to 2D with an alert, disposes the view, preserves position and selection", async () => {
    step(4);
    rowBtn("e03").click();
    await go3d();
    views[0]!.handlers.onContextLost();
    expect(text("#view-alert")).toContain("lost its WebGL context");
    expect($("#btn-view-2d").getAttribute("aria-pressed")).toBe("true");
    expect(views[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(text("#status")).toContain("Applied 4 of 6.");
    expect(text("#status")).toContain("Selected: e03.");
    rowBtn("e04").click();
    expect(field("Event ID")).toBe("e04");
  });

  it("ignores picks from a view that has been closed", async () => {
    step(3);
    await go3d();
    const stale = views[0]!.handlers;
    views[0]!.handlers.onContextLost();
    stale.onPickNode("planner");
    stale.onPickEdge("e02");
    expect(text("#status")).toContain("Selected: e03.");
  });

  it("manual 2D selection: leaving 3D by button disposes the view and 2D works", async () => {
    step(2);
    await go3d();
    $("#btn-view-2d").click();
    expect(views[0]!.dispose).toHaveBeenCalled();
    expect($("#graph-wrap").hidden).toBe(true);
    expect($(".table-wrap").hidden).toBe(false);
    rowBtn("e01").click();
    expect(field("Event ID")).toBe("e01");
  });

  it("loading a new trace closes the 3D view and returns to 2D", async () => {
    await go3d();
    vi.useRealTimers();
    const input = $<HTMLInputElement>("#file-input");
    Object.defineProperty(input, "files", { value: [new File(["{bad"], "t.json")], configurable: true });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(text("#issues")).toContain("INVALID_JSON"));
    expect(views[0]!.dispose).toHaveBeenCalledTimes(1);
    expect($("#graph-wrap").hidden).toBe(true);
    expect($<HTMLButtonElement>("#btn-view-3d").disabled).toBe(true);
  });
});

describe("real 3D module without WebGL (jsdom has none)", () => {
  it("falls back to 2D with an explanatory alert", async () => {
    vi.useRealTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById("app")!;
    mountApp(root, loadTrace()); // default factory: dynamic import of ./view3d
    step(2);
    $("#btn-view-3d").click();
    await vi.waitFor(() => expect(text("#view-alert")).toContain("3D view unavailable: WebGL is unavailable"), { timeout: 5000 });
    expect($("#btn-view-2d").getAttribute("aria-pressed")).toBe("true");
    expect(text("#status")).toContain("Applied 2 of 6.");
    expect(root.querySelectorAll("tbody button")).toHaveLength(2);
  });
});
