import {
  AmbientLight, CanvasTexture, Color, ConeGeometry, CylinderGeometry, DirectionalLight, Group, Mesh,
  MeshStandardMaterial, MeshBasicMaterial, OctahedronGeometry, PerspectiveCamera, Quaternion, Raycaster, Scene, SphereGeometry,
  Sprite, SpriteMaterial, Vector2, Vector3, WebGLRenderer, type Material, type Object3D, type Texture,
} from "three";
import type { FailureMarker, GraphEdge, GraphModel, View3D, View3DHandlers } from "./graph";
import { ROLES, type AgentRole } from "./types";

/** Fixed node layout (scene units). Roles never move. */
const POSITIONS: Record<AgentRole, Vector3> = {
  planner: new Vector3(-3.2, -0.9, 0.6),
  implementer: new Vector3(0, 1.3, -0.6),
  reviewer: new Vector3(3.2, -0.9, 0.6),
};
const ROLE_COLOR: Record<AgentRole, number> = { planner: 0x3b82f6, implementer: 0x16a34a, reviewer: 0x9333ea };
const NODE_R = 0.5;
const SELECT_COLOR = 0xf59e0b;
const EDGE_COLOR = 0x64748b;
const FAIL_COLOR = 0xdc2626;

export class WebGLUnavailableError extends Error {
  constructor(detail: string) {
    super(`WebGL is unavailable (${detail}).`);
    this.name = "WebGLUnavailableError";
  }
}

/** Probe for a WebGL context without Three.js, so the failure is a clear typed error. */
export function probeWebGL(doc: Document = document): void {
  let ok = false;
  try {
    const c = doc.createElement("canvas");
    ok = !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    ok = false;
  }
  if (!ok) throw new WebGLUnavailableError("could not create a WebGL context");
}

/** Prevent default (so a restore is possible in principle) and report loss. Returns an unsubscribe. */
export function watchContextLoss(canvas: HTMLCanvasElement, onLost: () => void): () => void {
  const handler = (ev: Event) => {
    ev.preventDefault();
    onLost();
  };
  canvas.addEventListener("webglcontextlost", handler);
  return () => canvas.removeEventListener("webglcontextlost", handler);
}

function labelSprite(text: string, bg: string): Sprite {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = bg;
    g.fillRect(0, 0, 512, 128);
    g.fillStyle = "#ffffff";
    let px = 60;
    g.font = `bold ${px}px system-ui, sans-serif`;
    while (g.measureText(text).width > 472 && px > 24) {
      px -= 2;
      g.font = `bold ${px}px system-ui, sans-serif`;
    }
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, 256, 68, 472);
  }
  const s = new Sprite(new SpriteMaterial({ map: new CanvasTexture(c), depthTest: false }));
  s.scale.set(1.6, 0.4, 1);
  s.renderOrder = 10;
  return s;
}

/**
 * Ownership rule: whoever adds an object to the scene disposes it here. Releases, once each, every
 * geometry, material, and material texture (`map`) under `root`. Label sprites own a CanvasTexture
 * via their SpriteMaterial, so disposing the material alone would leak the texture. Sprite geometry is
 * the single instance Three.js shares between all sprites, so it is deliberately left alone.
 */
export function disposeObject3D(root: Object3D): void {
  const done = new Set<{ dispose(): void }>();
  const once = (r: { dispose(): void } | null | undefined) => {
    if (r && !done.has(r)) {
      done.add(r);
      r.dispose();
    }
  };
  root.traverse((o) => {
    const holder = o as Object3D & { geometry?: { dispose(): void }; material?: Material | Material[] };
    if (!(o instanceof Sprite)) once(holder.geometry);
    const mats = Array.isArray(holder.material) ? holder.material : [holder.material];
    for (const mat of mats) {
      if (!mat) continue;
      once(mat);
      once((mat as Material & { map?: Texture | null }).map);
    }
  });
}

/**
 * Three fixed labelled agent nodes, directed handoff edges for applied handoffs only, and a failure
 * marker. Renders on demand (no animation loop). Holds no replay state: `update()` receives a
 * GraphModel derived from the shared controller's state.
 */
export async function createView3D(container: HTMLElement, handlers: View3DHandlers): Promise<View3D> {
  probeWebGL();
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "3D agent graph. The text list below it is the keyboard-accessible equivalent.");
  canvas.className = "graph-canvas";
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (err) {
    throw new WebGLUnavailableError(err instanceof Error ? err.message : String(err));
  }
  container.append(canvas);

  const scene = new Scene();
  const world = new Group();
  world.rotation.set(0.18, -0.3, 0);
  scene.add(world, new AmbientLight(0xffffff, 1.6));
  const sun = new DirectionalLight(0xffffff, 2);
  sun.position.set(3, 6, 8);
  scene.add(sun);
  const camera = new PerspectiveCamera(45, 2, 0.1, 100);
  camera.position.set(0, 0.6, 8.2);
  camera.lookAt(0, 0.2, 0);

  const pickables: Object3D[] = [];
  const nodeMeshes = new Map<AgentRole, Mesh>();
  for (const role of ROLES) {
    const m = new Mesh(new SphereGeometry(NODE_R, 32, 24), new MeshStandardMaterial({ color: ROLE_COLOR[role] }));
    m.position.copy(POSITIONS[role]);
    m.userData = { kind: "node", role };
    const label = labelSprite(role, "#1f2937");
    label.position.set(0, -0.95, 0);
    m.add(label);
    world.add(m);
    pickables.push(m);
    nodeMeshes.set(role, m);
  }
  const dynamic = new Group(); // edges + marker; rebuilt on every update
  world.add(dynamic);

  const pickPoints: { nodes: Record<string, [number, number]>; edges: Record<string, [number, number]>; failures: Record<string, [number, number]> } = { nodes: {}, edges: {}, failures: {} };
  const worldPoints = { edges: new Map<string, Vector3>(), failures: new Map<string, Vector3>() };

  function clearDynamic(): void {
    for (const child of [...dynamic.children]) {
      dynamic.remove(child);
      disposeObject3D(child); // edge/marker meshes plus their label sprites' materials and textures
    }
    pickables.splice(ROLES.length); // keep only the three nodes
    worldPoints.edges.clear();
    worldPoints.failures.clear();
  }

  function addEdge(e: GraphEdge, index: number, selected: boolean): void {
    const a = POSITIONS[e.from].clone();
    const b = POSITIONS[e.to].clone();
    const lift = new Vector3(0, 0.28 * index, 0); // separate parallel handoffs between the same pair
    a.add(lift);
    b.add(lift);
    const dir = b.clone().sub(a).normalize();
    const start = a.clone().addScaledVector(dir, NODE_R);
    const end = b.clone().addScaledVector(dir, -NODE_R - 0.3);
    const len = start.distanceTo(end);
    const mid = start.clone().add(end).multiplyScalar(0.5);
    const color = new Color(selected ? SELECT_COLOR : EDGE_COLOR);
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir);

    const shaft = new Mesh(new CylinderGeometry(selected ? 0.09 : 0.06, selected ? 0.09 : 0.06, len, 12), new MeshBasicMaterial({ color }));
    shaft.position.copy(mid);
    shaft.quaternion.copy(q);
    const head = new Mesh(new ConeGeometry(0.2, 0.3, 16), new MeshBasicMaterial({ color }));
    head.position.copy(end.clone().addScaledVector(dir, 0.15));
    head.quaternion.copy(q);
    // Wider invisible-but-raycastable hit area so thin edges are clickable.
    const hit = new Mesh(new CylinderGeometry(0.28, 0.28, len, 8), new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    hit.position.copy(mid);
    hit.quaternion.copy(q);
    hit.userData = { kind: "edge", eventId: e.eventId };
    const tag = labelSprite(`Handoff ${e.eventId}`, "#172554");
    tag.scale.set(2.2, 0.55, 1);
    tag.position.copy(mid).add(new Vector3(0, 0.5, 0));
    dynamic.add(shaft, head, hit, tag);
    pickables.push(hit);
    worldPoints.edges.set(e.eventId, mid.clone());
  }

  function addFailure(f: FailureMarker, selected: boolean): void {
    const base = POSITIONS[f.role];
    const m = new Mesh(new OctahedronGeometry(0.28), new MeshStandardMaterial({ color: selected ? SELECT_COLOR : FAIL_COLOR, emissive: FAIL_COLOR, emissiveIntensity: 0.6 }));
    m.position.set(base.x + 0.9, base.y + 0.75, base.z);
    m.userData = { kind: "failure", callId: f.callId };
    const tag = labelSprite(`FAILED ${f.callId} → ${f.resultId}`, "#991b1b");
    tag.scale.set(2.4, 0.6, 1);
    tag.position.set(0, 0.6, 0);
    m.add(tag);
    dynamic.add(m);
    pickables.push(m);
    worldPoints.failures.set(f.callId, m.position.clone());
  }

  const size = { w: 0, h: 0 };
  function resize(): void {
    const w = Math.max(1, Math.round(container.clientWidth || 600));
    const h = 360;
    if (w === size.w && h === size.h) return;
    size.w = w;
    size.h = h;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    canvas.style.height = `${h}px`;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function project(p: Vector3): [number, number] {
    const v = world.localToWorld(p.clone()).project(camera);
    return [Math.round(((v.x + 1) / 2) * size.w), Math.round(((1 - v.y) / 2) * size.h)];
  }

  let last: { graph: GraphModel; selected: string | null } | null = null;
  function render(): void {
    if (disposed) return;
    resize();
    renderer.render(scene, camera);
    // Test hook: CSS-pixel centers of pickable objects, so scripted checks can click real pixels.
    pickPoints.nodes = {};
    pickPoints.edges = {};
    pickPoints.failures = {};
    for (const role of ROLES) pickPoints.nodes[role] = project(POSITIONS[role]);
    for (const [id, p] of worldPoints.edges) pickPoints.edges[id] = project(p);
    for (const [id, p] of worldPoints.failures) pickPoints.failures[id] = project(p);
    canvas.setAttribute("data-pick-points", JSON.stringify(pickPoints));
  }

  let disposed = false;
  const view: View3D = {
    update(graph, selected) {
      if (disposed) return;
      last = { graph, selected };
      clearDynamic();
      const seen = new Map<string, number>();
      for (const e of graph.edges) {
        const key = [e.from, e.to].sort().join("|");
        const idx = seen.get(key) ?? 0;
        seen.set(key, idx + 1);
        addEdge(e, idx, e.eventId === selected);
      }
      for (const f of graph.failures) addFailure(f, f.callId === selected || f.resultId === selected);
      for (const n of graph.nodes) {
        const mesh = nodeMeshes.get(n.role)!;
        const mat = mesh.material as MeshStandardMaterial;
        const isSel = n.latestEventId !== null && n.latestEventId === selected;
        mat.color.set(isSel ? SELECT_COLOR : ROLE_COLOR[n.role]);
        mesh.scale.setScalar(isSel ? 1.2 : 1);
      }
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unwatch();
      canvas.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("resize", onResize);
      clearDynamic();
      disposeObject3D(world); // the three node spheres and their label sprites (material + texture)
      world.clear();
      renderer.dispose();
      canvas.remove();
    },
  };

  const raycaster = new Raycaster();
  function onPointer(ev: PointerEvent): void {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const ndc = new Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -(((ev.clientY - r.top) / r.height) * 2 - 1));
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(pickables, false)[0];
    const d = hit?.object.userData as { kind?: string; role?: AgentRole; eventId?: string; callId?: string } | undefined;
    if (!d) return;
    if (d.kind === "node" && d.role) handlers.onPickNode(d.role);
    else if (d.kind === "edge" && d.eventId) handlers.onPickEdge(d.eventId);
    else if (d.kind === "failure" && d.callId) handlers.onPickFailure(d.callId);
  }
  const onResize = () => last && render();
  canvas.addEventListener("pointerdown", onPointer);
  window.addEventListener("resize", onResize);
  const unwatch = watchContextLoss(canvas, () => {
    if (!disposed) handlers.onContextLost();
  });
  render();
  return view;
}
