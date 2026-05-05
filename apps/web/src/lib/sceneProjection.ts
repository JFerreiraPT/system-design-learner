import type { SceneSummary } from "@sdl/shared";

/**
 * Projects a raw Excalidraw scene into a compact `{ nodes, edges, summaryText }`
 * shape suitable for sending to chat models.
 *
 * Why: raw scene JSON is huge (`appState`, `files`, ids, version stamps, group
 * arrays...) and forces the model to reconstruct the diagram from coordinates
 * and id references. A graph projection is ~10–50x smaller and far easier for
 * the model to reason about.
 */

type ExcalidrawElement = {
  id: string;
  type: string;
  isDeleted?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  containerId?: string | null;
  boundElements?: Array<{ id: string; type: string }> | null;
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
  customData?: Record<string, unknown> | null;
  groupIds?: string[];
};

const SHAPE_TYPES = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "image",
  "freedraw"
]);

const ARROW_TYPES = new Set(["arrow", "line"]);

const EMPTY_SUMMARY: SceneSummary = {
  nodes: [],
  edges: [],
  summaryText: "Empty board."
};

export function projectSceneJson(sceneJson: string | undefined): SceneSummary {
  if (!sceneJson || sceneJson === "{}") return EMPTY_SUMMARY;

  let parsed: { elements?: ExcalidrawElement[] } | null = null;
  try {
    parsed = JSON.parse(sceneJson);
  } catch {
    return EMPTY_SUMMARY;
  }

  const elements = (parsed?.elements ?? []).filter((el) => !el.isDeleted);
  if (elements.length === 0) return EMPTY_SUMMARY;

  return projectElements(elements);
}

function projectElements(elements: ExcalidrawElement[]): SceneSummary {
  const byId = new Map<string, ExcalidrawElement>();
  for (const el of elements) byId.set(el.id, el);

  const textElements = elements.filter((el) => el.type === "text");
  const shapeElements = elements.filter((el) => SHAPE_TYPES.has(el.type));
  const arrowElements = elements.filter((el) => ARROW_TYPES.has(el.type));

  // Resolve labels for shapes:
  // 1. text element with containerId === shape.id (Excalidraw "bound" text)
  // 2. text element listed in shape.boundElements
  // 3. nearest standalone text element overlapping the shape's bbox
  const shapeLabels = new Map<string, string>();
  const consumedTextIds = new Set<string>();

  for (const shape of shapeElements) {
    const bound = textElements.find(
      (t) => t.containerId === shape.id && !consumedTextIds.has(t.id)
    );
    if (bound?.text) {
      shapeLabels.set(shape.id, normalizeLabel(bound.text));
      consumedTextIds.add(bound.id);
      continue;
    }
    const fromBoundElements = shape.boundElements
      ?.filter((b) => b.type === "text")
      .map((b) => byId.get(b.id))
      .find((t): t is ExcalidrawElement =>
        Boolean(t && t.text && !consumedTextIds.has(t.id))
      );
    if (fromBoundElements?.text) {
      shapeLabels.set(shape.id, normalizeLabel(fromBoundElements.text));
      consumedTextIds.add(fromBoundElements.id);
      continue;
    }
    const overlapping = textElements.find(
      (t) => !consumedTextIds.has(t.id) && bboxIntersects(shape, t)
    );
    if (overlapping?.text) {
      shapeLabels.set(shape.id, normalizeLabel(overlapping.text));
      consumedTextIds.add(overlapping.id);
    }
  }

  // Consume arrow-bound text labels up-front so they don't surface again as
  // standalone "text" nodes — they will be emitted as edge labels instead.
  for (const arrow of arrowElements) {
    const arrowText = arrow.boundElements
      ?.filter((b) => b.type === "text")
      .map((b) => byId.get(b.id))
      .find((t): t is ExcalidrawElement => Boolean(t?.text));
    if (arrowText) consumedTextIds.add(arrowText.id);
  }

  const nodes = shapeElements.map((shape, idx) => ({
    id: shortId(shape.id, idx),
    label: shapeLabels.get(shape.id) ?? `${capitalize(shape.type)} ${idx + 1}`,
    kind: shape.type
  }));

  // Standalone text elements (not consumed by a shape or arrow) become
  // "label" nodes — usually free-floating annotations.
  for (const t of textElements) {
    if (consumedTextIds.has(t.id) || !t.text) continue;
    nodes.push({
      id: shortId(t.id, nodes.length),
      label: normalizeLabel(t.text),
      kind: "text"
    });
  }

  // Map original element ids -> short ids for edge lookup.
  const idMap = new Map<string, string>();
  for (let i = 0; i < shapeElements.length; i++) {
    idMap.set(shapeElements[i]!.id, nodes[i]!.id);
  }
  let textCursor = shapeElements.length;
  for (const t of textElements) {
    if (consumedTextIds.has(t.id) || !t.text) continue;
    idMap.set(t.id, nodes[textCursor]!.id);
    textCursor++;
  }

  const edges: SceneSummary["edges"] = [];
  for (const arrow of arrowElements) {
    const fromOriginal = arrow.startBinding?.elementId;
    const toOriginal = arrow.endBinding?.elementId;
    const from = fromOriginal ? idMap.get(fromOriginal) : undefined;
    const to = toOriginal ? idMap.get(toOriginal) : undefined;
    if (!from || !to) continue;

    let label: string | undefined;
    const arrowText = arrow.boundElements
      ?.filter((b) => b.type === "text")
      .map((b) => byId.get(b.id))
      .find((t): t is ExcalidrawElement => Boolean(t?.text));
    if (arrowText?.text) label = normalizeLabel(arrowText.text);

    edges.push({ from, to, label });
  }

  return {
    nodes,
    edges,
    summaryText: buildSummaryText(nodes, edges)
  };
}

function buildSummaryText(
  nodes: SceneSummary["nodes"],
  edges: SceneSummary["edges"]
) {
  if (nodes.length === 0) return "Empty board.";
  const componentLine = `${nodes.length} component${nodes.length === 1 ? "" : "s"}: ${nodes
    .slice(0, 16)
    .map((n) => n.label)
    .join(", ")}${nodes.length > 16 ? ", …" : ""}`;
  if (edges.length === 0) {
    return `${componentLine}. No connections drawn yet.`;
  }
  const labelById = new Map(nodes.map((n) => [n.id, n.label] as const));
  const edgeStrings = edges.slice(0, 24).map((e) => {
    const fromLabel = labelById.get(e.from) ?? e.from;
    const toLabel = labelById.get(e.to) ?? e.to;
    return e.label ? `${fromLabel} —[${e.label}]→ ${toLabel}` : `${fromLabel} → ${toLabel}`;
  });
  const more = edges.length > 24 ? `, +${edges.length - 24} more` : "";
  return `${componentLine}. ${edges.length} connection${edges.length === 1 ? "" : "s"}: ${edgeStrings.join("; ")}${more}.`;
}

function normalizeLabel(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80) || "(unnamed)";
}

function shortId(originalId: string, idx: number): string {
  // Keep ids small but unique-ish in the projection. We don't need to round-trip,
  // so a sequential `n0/n1/...` is enough and saves tokens.
  void originalId;
  return `n${idx}`;
}

function bboxIntersects(a: ExcalidrawElement, b: ExcalidrawElement): boolean {
  const ax = a.x ?? 0;
  const ay = a.y ?? 0;
  const aw = a.width ?? 0;
  const ah = a.height ?? 0;
  const bx = b.x ?? 0;
  const by = b.y ?? 0;
  const bw = b.width ?? 0;
  const bh = b.height ?? 0;
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
