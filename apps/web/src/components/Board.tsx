import { useEffect, useMemo, useRef } from "react";
import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw";
import { useWorkspaceStore } from "../lib/store";
import { useTheme } from "../lib/useTheme";

/** Largest dimension (px) we send to the multimodal model. The Excalidraw scene
 * is exported at native scale by default which can be 4-8MB for a busy board. */
const MAX_EXPORT_DIMENSION = 1280;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const value = reader.result?.toString() ?? "";
      // Strip the `data:image/...;base64,` prefix so the API can re-prefix as needed.
      const idx = value.indexOf(",");
      resolve(idx >= 0 ? value.slice(idx + 1) : value);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

type Props = {
  initialSceneJson?: string;
};

export function Board({ initialSceneJson }: Props) {
  const excalidrawRef = useRef<any>(null);
  const libraryLoadedRef = useRef(false);
  const setScene = useWorkspaceStore((s) => s.setScene);
  const setCaptureSceneImage = useWorkspaceStore((s) => s.setCaptureSceneImage);
  const { theme } = useTheme();

  const initialData = useMemo<any>(() => {
    if (!initialSceneJson) return undefined;
    try {
      const parsed = JSON.parse(initialSceneJson) as any;
      if (!Array.isArray(parsed.elements)) return undefined;
      return {
        elements: parsed.elements,
        files: parsed.files ?? {}
      };
    } catch {
      return undefined;
    }
  }, [initialSceneJson]);

  // Register a lazy screenshot capture function. Consumers (validate, chat send)
  // call this on demand, so we no longer rasterize on every keystroke.
  useEffect(() => {
    const capture = async (): Promise<string | undefined> => {
      const api = excalidrawRef.current;
      if (!api) return undefined;
      try {
        const elements = api.getSceneElements();
        if (!elements || elements.length === 0) return undefined;
        const appState = api.getAppState();
        const files = api.getFiles();
        const blob = await exportToBlob({
          elements,
          appState,
          files,
          mimeType: "image/png",
          getDimensions: (width: number, height: number) => {
            const longest = Math.max(width, height);
            const scale = longest > MAX_EXPORT_DIMENSION ? MAX_EXPORT_DIMENSION / longest : 1;
            return {
              width: Math.round(width * scale),
              height: Math.round(height * scale),
              scale
            };
          }
        });
        return await blobToBase64(blob);
      } catch {
        return undefined;
      }
    };
    setCaptureSceneImage(capture);
    return () => setCaptureSceneImage(null);
  }, [setCaptureSceneImage]);

  return (
    <div className="h-[calc(100vh-112px)] min-h-[640px]">
      <Excalidraw
        theme={theme}
        initialData={initialData}
        excalidrawAPI={(api) => {
          excalidrawRef.current = api;
          if (libraryLoadedRef.current) return;
          libraryLoadedRef.current = true;
          void fetch("/libraries/system-design.excalidrawlib")
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (!data) return;
              const items = data.libraryItems ?? data.library;
              if (Array.isArray(items) && items.length > 0) {
                return api.updateLibrary({
                  libraryItems: items,
                  merge: true
                });
              }
            })
            .catch(() => {
              libraryLoadedRef.current = false;
            });
        }}
        onChange={(elements, appState, files) => {
          const sceneJson = JSON.stringify({ elements, appState, files });
          setScene(sceneJson);
        }}
      />
    </div>
  );
}
