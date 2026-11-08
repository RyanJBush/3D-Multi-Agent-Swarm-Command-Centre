// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGraph } from "../src/graph";
import { replayTo } from "../src/replay";
import { loadTrace } from "./helpers";

/**
 * Resource ledger. Only WebGLRenderer is replaced (jsdom has no WebGL); every GPU-owning Three.js
 * class the view uses is wrapped to record creation and disposal, so leaks show up as undisposed entries.
 */
const ledger = vi.hoisted(() => ({
  textures: [] as object[],
  materials: [] as object[],
  geometries: [] as object[],
  disposed: new Set<object>(),
  rendererDisposals: 0,
}));

vi.mock("three", async (importOriginal) => {
  const T = await importOriginal<typeof import("three")>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tracked = (Base: any, list: object[]): any =>
    class extends Base {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(...args: any[]) {
        super(...args);
        list.push(this);
      }
      dispose() {
        ledger.disposed.add(this);
        super.dispose();
      }
    };
  return {
    ...T,
    CanvasTexture: tracked(T.CanvasTexture, ledger.textures),
    SpriteMaterial: tracked(T.SpriteMaterial, ledger.materials),
    MeshBasicMaterial: tracked(T.MeshBasicMaterial, ledger.materials),
    MeshStandardMaterial: tracked(T.MeshStandardMaterial, ledger.materials),
    SphereGeometry: tracked(T.SphereGeometry, ledger.geometries),
    CylinderGeometry: tracked(T.CylinderGeometry, ledger.geometries),
    ConeGeometry: tracked(T.ConeGeometry, ledger.geometries),
    OctahedronGeometry: tracked(T.OctahedronGeometry, ledger.geometries),
    WebGLRenderer: class {
      setPixelRatio() {}
      setSize() {}
      render() {}
      dispose() {
        ledger.rendererDisposals++;
      }
    },
  };
});

const { createView3D, disposeObject3D } = await import("../src/view3d");
const { Group, Mesh, Sprite, SphereGeometry, MeshBasicMaterial, SpriteMaterial, CanvasTexture } = await import("three");

const trace = loadTrace();
const graphAt = (n: number) => buildGraph(replayTo(trace, n));
const live = (list: object[]) => list.filter((r) => !ledger.disposed.has(r)).length;
const handlers = { onPickNode() {}, onPickEdge() {}, onPickFailure() {}, onContextLost() {} };

beforeEach(() => {
  ledger.textures.length = ledger.materials.length = ledger.geometries.length = 0;
  ledger.disposed.clear();
  ledger.rendererDisposals = 0;
  const fake2d = { fillRect() {}, fillText() {}, measureText: () => ({ width: 10 }), fillStyle: "", font: "", textAlign: "", textBaseline: "" };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((type: string) => (type === "2d" ? fake2d : {})) as never);
});
afterEach(() => vi.restoreAllMocks());

describe("graphics resource ownership", () => {
  it("creates exactly one label texture per node at start, none disposed yet", async () => {
    const host = document.createElement("div");
    await createView3D(host, handlers);
    expect(ledger.textures).toHaveLength(3);
    expect(live(ledger.textures)).toBe(3);
  });

  it("disposes the previous dynamic labels' textures AND materials on every rebuild", async () => {
    const host = document.createElement("div");
    const view = await createView3D(host, handlers);
    view.update(graphAt(4), null); // edge e02 + failure marker -> 2 dynamic label textures
    expect(ledger.textures).toHaveLength(3 + 2);
    view.update(graphAt(5), null); // edges e02, e05 + failure marker -> 3 new dynamic label textures
    expect(ledger.textures).toHaveLength(3 + 2 + 3);
    // Only the 3 node labels and the 3 current dynamic labels may still be live.
    expect(live(ledger.textures)).toBe(3 + 3);
    const spriteMaterials = ledger.materials.filter((m) => (m as { isSpriteMaterial?: boolean }).isSpriteMaterial);
    expect(live(spriteMaterials)).toBe(3 + 3);
  });

  it("does not grow when the same graph is pushed repeatedly (no per-update leak)", async () => {
    const host = document.createElement("div");
    const view = await createView3D(host, handlers);
    view.update(graphAt(5), null);
    const baseline = { textures: live(ledger.textures), materials: live(ledger.materials), geometries: live(ledger.geometries) };
    expect(baseline.textures).toBe(3 + 3);
    for (let i = 0; i < 25; i++) view.update(graphAt(5), i % 2 ? "e02" : null);
    expect({ textures: live(ledger.textures), materials: live(ledger.materials), geometries: live(ledger.geometries) }).toEqual(baseline);
  });

  it("releases every dynamic resource when the graph empties", async () => {
    const host = document.createElement("div");
    const view = await createView3D(host, handlers);
    view.update(graphAt(6), null);
    view.update(graphAt(0), null);
    expect(live(ledger.textures)).toBe(3);
    expect(live(ledger.geometries)).toBe(3); // only the node spheres remain
  });

  it("dispose() releases everything it created: node-label textures and materials, geometries, materials, renderer", async () => {
    const host = document.createElement("div");
    const view = await createView3D(host, handlers);
    view.update(graphAt(6), "e03");
    view.update(graphAt(5), null);
    view.dispose();
    expect(live(ledger.textures)).toBe(0);
    expect(live(ledger.materials)).toBe(0);
    expect(live(ledger.geometries)).toBe(0);
    expect(ledger.rendererDisposals).toBe(1);
    expect(host.childElementCount).toBe(0);
  });

  it("dispose() is idempotent and update() after dispose creates nothing", async () => {
    const host = document.createElement("div");
    const view = await createView3D(host, handlers);
    view.dispose();
    const counts = [ledger.textures.length, ledger.materials.length, ledger.geometries.length];
    view.dispose();
    view.update(graphAt(6), null);
    expect(ledger.rendererDisposals).toBe(1);
    expect([ledger.textures.length, ledger.materials.length, ledger.geometries.length]).toEqual(counts);
  });
});

describe("disposeObject3D (ownership helper)", () => {
  const texture = () => new CanvasTexture(document.createElement("canvas"));

  it("disposes a mesh's geometry and material and a sprite's material and map texture, through nested children", () => {
    const root = new Group();
    const mesh = new Mesh(new SphereGeometry(1), new MeshBasicMaterial());
    const mat = new SpriteMaterial({ map: texture() });
    const label = new Sprite(mat);
    mesh.add(label); // label owned by the mesh, like the node labels
    root.add(mesh);
    disposeObject3D(root);
    for (const r of [mesh.geometry, mesh.material, mat, mat.map]) expect(ledger.disposed.has(r as object)).toBe(true);
  });

  it("handles material arrays", () => {
    const m1 = new MeshBasicMaterial();
    const m2 = new MeshBasicMaterial();
    const mesh = new Mesh(new SphereGeometry(1), [m1, m2]);
    disposeObject3D(mesh);
    expect(ledger.disposed.has(m1) && ledger.disposed.has(m2)).toBe(true);
  });

  it("disposes a resource shared by several objects only once", () => {
    const shared = new MeshBasicMaterial();
    const spy = vi.spyOn(shared, "dispose");
    const root = new Group();
    root.add(new Mesh(new SphereGeometry(1), shared), new Mesh(new SphereGeometry(1), shared));
    disposeObject3D(root);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not dispose the geometry that Three.js shares between all sprites", () => {
    const a = new Sprite(new SpriteMaterial());
    const b = new Sprite(new SpriteMaterial());
    expect(a.geometry).toBe(b.geometry); // premise: one geometry instance shared by all sprites
    const spy = vi.spyOn(a.geometry, "dispose"); // the ledger does not track this geometry, so spy on it directly
    disposeObject3D(a);
    expect(spy).not.toHaveBeenCalled();
  });

  it("tolerates objects with no resources", () => {
    expect(() => disposeObject3D(new Group())).not.toThrow();
  });
});
