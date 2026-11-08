// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebGLUnavailableError, createView3D, probeWebGL, watchContextLoss } from "../src/view3d";

afterEach(() => vi.restoreAllMocks());

describe("WebGL initialization failure", () => {
  it("probeWebGL throws a typed error when no context can be created", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(() => probeWebGL()).toThrow(WebGLUnavailableError);
    expect(() => probeWebGL()).toThrow(/WebGL is unavailable/);
  });
  it("probeWebGL also treats a throwing getContext as unavailable", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => probeWebGL()).toThrow(WebGLUnavailableError);
  });
  it("probeWebGL passes when a context exists", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
    expect(() => probeWebGL()).not.toThrow();
  });
  it("createView3D rejects and leaves the container empty", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const host = document.createElement("div");
    await expect(createView3D(host, { onPickNode() {}, onPickEdge() {}, onPickFailure() {}, onContextLost() {} })).rejects.toBeInstanceOf(WebGLUnavailableError);
    expect(host.childElementCount).toBe(0);
  });
});

describe("context loss", () => {
  it("reports loss once, prevents the default, and stops after unsubscribe", () => {
    const canvas = document.createElement("canvas");
    const onLost = vi.fn();
    const off = watchContextLoss(canvas, onLost);
    const ev = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(ev);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    off();
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(onLost).toHaveBeenCalledTimes(1);
  });
});
