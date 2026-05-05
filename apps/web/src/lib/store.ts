import { create } from "zustand";

/**
 * Workspace state.
 *
 * `imageBase64` used to live here and was regenerated on every Excalidraw
 * `onChange`, which meant a full PNG re-rasterize + base64 encode on every
 * stroke. The screenshot is only actually needed when sending to the API
 * (validate / chat). We now expose `captureSceneImage` instead, which the
 * Board registers on mount and consumers call lazily.
 */
type WorkspaceState = {
  sceneJson: string;
  setScene: (sceneJson: string) => void;
  /** Lazy PNG capture, registered by the Board. Returns base64 (no data: prefix), or undefined if no board is mounted / capture failed. */
  captureSceneImage: (() => Promise<string | undefined>) | null;
  setCaptureSceneImage: (fn: (() => Promise<string | undefined>) | null) => void;
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  sceneJson: "{}",
  setScene: (sceneJson) => set({ sceneJson }),
  captureSceneImage: null,
  setCaptureSceneImage: (fn) => set({ captureSceneImage: fn })
}));

export const workspaceLocalStorageKeys = (problemId: string) => ({
  scene: `workspace:${problemId}:scene`,
  interview: `workspace:${problemId}:interviewId`,
  tutor: `workspace:${problemId}:tutorSessionId`,
  estimation: `workspace:${problemId}:estimation`,
  phase: `workspace:${problemId}:phase`
});

// Clears the local working state for a problem (canvas + active chat session
// pointers). Server-side history (validations, interview/tutor messages) is
// untouched, so a previous attempt remains queryable.
export function clearWorkspaceLocalState(problemId: string) {
  const keys = workspaceLocalStorageKeys(problemId);
  localStorage.removeItem(keys.scene);
  localStorage.removeItem(keys.interview);
  localStorage.removeItem(keys.tutor);
  localStorage.removeItem(keys.estimation);
  localStorage.removeItem(keys.phase);
}
