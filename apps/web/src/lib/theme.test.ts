import { describe, expect, it } from "vitest";
import { cycleTheme, excalidrawAppearance, parseStoredTheme } from "./theme";

describe("parseStoredTheme", () => {
  it("accepts light, dark, and summer", () => {
    expect(parseStoredTheme("light")).toBe("light");
    expect(parseStoredTheme("dark")).toBe("dark");
    expect(parseStoredTheme("summer")).toBe("summer");
  });

  it("rejects unknown values", () => {
    expect(parseStoredTheme("neon")).toBeNull();
    expect(parseStoredTheme("")).toBeNull();
    expect(parseStoredTheme(null)).toBeNull();
  });
});

describe("excalidrawAppearance", () => {
  it("maps dark only to dark", () => {
    expect(excalidrawAppearance("dark")).toBe("dark");
    expect(excalidrawAppearance("light")).toBe("light");
    expect(excalidrawAppearance("summer")).toBe("light");
  });
});

describe("cycleTheme", () => {
  it("rotates dark → light → summer → dark", () => {
    expect(cycleTheme("dark")).toBe("light");
    expect(cycleTheme("light")).toBe("summer");
    expect(cycleTheme("summer")).toBe("dark");
  });
});
