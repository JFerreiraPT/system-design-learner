/**
 * Verification script: feeds a realistic scene built from the actual
 * system-design library into `projectSceneJson` and prints the resulting
 * nodes/edges. Not part of the build — intended for one-off validation.
 *
 * Run with:
 *   pnpm --filter @sdl/web exec tsx scripts/verify-projection.ts
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectSceneJson } from "../src/lib/sceneProjection";

const __dirname = dirname(fileURLToPath(import.meta.url));

type LibElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  groupIds?: string[];
  containerId?: string | null;
  boundElements?: unknown;
};

type LibItem = { name: string; elements: LibElement[] };

const libPath = resolve(__dirname, "../public/libraries/system-design.excalidrawlib");
const lib = JSON.parse(readFileSync(libPath, "utf8")) as { libraryItems: LibItem[] };

// Pick a representative subset of icons.
const wantedNames = [
  "Client",
  "Load balancer",
  "Service",
  "Search index",
  "Blob store"
];
const items = wantedNames
  .map((n) => lib.libraryItems.find((it) => it.name === n))
  .filter((it): it is LibItem => Boolean(it));

if (items.length !== wantedNames.length) {
  console.warn(
    "Missing items:",
    wantedNames.filter((n) => !lib.libraryItems.some((i) => i.name === n))
  );
}

// Simulate dragging each library item onto the canvas at its own offset and
// inside its own group (Excalidraw assigns a fresh `groupIds` entry on drop).
let elIdCounter = 1;
const placedElements: any[] = [];
const droppedNodeIds: string[] = []; // first (rectangle) element id of each dropped item
items.forEach((item, idx) => {
  const groupId = `g_${idx}`;
  const dx = idx * 200;
  const dy = idx % 2 === 0 ? 0 : 120;
  const idMap = new Map<string, string>();
  for (const el of item.elements) {
    const newId = `el_${elIdCounter++}`;
    idMap.set(el.id, newId);
    placedElements.push({
      ...el,
      id: newId,
      x: (el.x ?? 0) + dx,
      y: (el.y ?? 0) + dy,
      groupIds: [groupId],
      // Excalidraw doesn't auto-bind text to its rectangle on drop, so we
      // intentionally keep containerId/boundElements null (mirrors reality).
      containerId: null,
      boundElements: null
    });
  }
  // Track the rectangle of this dropped item as a connectable node.
  const rect = placedElements
    .slice(-item.elements.length)
    .find((e) => e.type === "rectangle");
  if (rect) droppedNodeIds.push(rect.id);
});

// Add a few free-floating annotation texts.
placedElements.push({
  id: `el_${elIdCounter++}`,
  type: "text",
  x: 50,
  y: 400,
  width: 200,
  height: 24,
  text: "Note: writes go through the LB",
  groupIds: [],
  containerId: null,
  boundElements: null
});

// Add arrows between the dropped rectangles.
function arrow(from: string, to: string, label?: string) {
  const id = `el_${elIdCounter++}`;
  placedElements.push({
    id,
    type: "arrow",
    x: 0,
    y: 0,
    width: 100,
    height: 0,
    startBinding: { elementId: from, focus: 0, gap: 4 },
    endBinding: { elementId: to, focus: 0, gap: 4 },
    boundElements: label
      ? [{ id: `${id}_label`, type: "text" }]
      : null
  });
  if (label) {
    placedElements.push({
      id: `${id}_label`,
      type: "text",
      x: 0,
      y: 0,
      width: 60,
      height: 20,
      text: label,
      containerId: id,
      boundElements: null
    });
  }
}
arrow(droppedNodeIds[0]!, droppedNodeIds[1]!, "https");
arrow(droppedNodeIds[1]!, droppedNodeIds[2]!);
arrow(droppedNodeIds[2]!, droppedNodeIds[3]!, "index");
arrow(droppedNodeIds[2]!, droppedNodeIds[4]!, "store blob");

const sceneJson = JSON.stringify({ elements: placedElements });

const summary = projectSceneJson(sceneJson);

console.log("=== sceneProjection on system-design library scene ===\n");
console.log(`Input elements: ${placedElements.length}`);
console.log(`Output: ${summary.nodes.length} node(s), ${summary.edges.length} edge(s)\n`);
console.log("Nodes:");
for (const n of summary.nodes) {
  console.log(`  ${n.id.padEnd(4)} ${(n.kind ?? "").padEnd(10)} ${n.label}`);
}
console.log("\nEdges:");
for (const e of summary.edges) {
  console.log(
    `  ${e.from} -> ${e.to}${e.label ? ` (${e.label})` : ""}`
  );
}
console.log("\nSummary text:");
console.log(`  ${summary.summaryText}\n`);

// Crude sanity assertions
const expectedLabels = new Set(wantedNames);
const labelHits = summary.nodes.filter((n) => expectedLabels.has(n.label));
if (labelHits.length === wantedNames.length) {
  console.log(
    `OK: every dropped library item resolved to a node with the right label (${labelHits.length}/${wantedNames.length}).`
  );
} else {
  console.error(
    `FAIL: expected ${wantedNames.length} labelled nodes, got ${labelHits.length}.`
  );
  console.error("Missing:", [...expectedLabels].filter((l) => !labelHits.some((n) => n.label === l)));
  process.exitCode = 1;
}

if (summary.edges.length === 4) {
  console.log("OK: 4 edges projected (matches the 4 arrows).");
} else {
  console.error(`FAIL: expected 4 edges, got ${summary.edges.length}.`);
  process.exitCode = 1;
}

const expectedEdgeLabels = ["https", "index", "store blob"];
const seenEdgeLabels = summary.edges.map((e) => e.label).filter(Boolean) as string[];
const allLabelsSeen = expectedEdgeLabels.every((l) => seenEdgeLabels.includes(l));
if (allLabelsSeen) {
  console.log("OK: edge labels carried through (https, index, store blob).");
} else {
  console.error("FAIL: missing edge labels. Got:", seenEdgeLabels);
  process.exitCode = 1;
}

// Edge labels must NOT also surface as standalone text nodes.
const duplicatedEdgeLabels = expectedEdgeLabels.filter((l) =>
  summary.nodes.some((n) => n.kind === "text" && n.label === l)
);
if (duplicatedEdgeLabels.length === 0) {
  console.log("OK: edge labels are not duplicated as standalone text nodes.");
} else {
  console.error(
    "FAIL: edge labels also appeared as text nodes:",
    duplicatedEdgeLabels
  );
  process.exitCode = 1;
}

// Free-floating annotation should still come through as a single text node.
const annotationCount = summary.nodes.filter(
  (n) => n.kind === "text" && n.label.startsWith("Note: writes")
).length;
if (annotationCount === 1) {
  console.log("OK: free-floating annotation kept as a text node.");
} else {
  console.error(
    `FAIL: expected 1 annotation text node, got ${annotationCount}.`
  );
  process.exitCode = 1;
}
