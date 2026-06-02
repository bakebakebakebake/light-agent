import { describe, it, expect } from "vitest";
import { beside, mascot, mascotTagline } from "../src/ui/mascot.js";

describe("mascot", () => {
  it("renders the original compact mascot", () => {
    const lines = mascot().split("\n");
    expect(lines).toHaveLength(5);
    expect(mascot()).toContain("◯");
    expect(lines[0]).toContain("╭───────╮");
  });

  it("keeps the product label separate from the art", () => {
    expect(mascotTagline()).toContain("Light-Agent");
    expect(mascot()).not.toContain("Light-Agent");
  });
});

describe("beside", () => {
  it("pads the narrower column and keeps row counts aligned", () => {
    const out = beside(["AA", "BB"], ["1", "2", "3", "4"], 2).split("\n");
    expect(out).toHaveLength(4);
    expect(out[0]).toBe("    1");
    expect(out[1]).toBe("AA  2");
    expect(out[2]).toBe("BB  3");
    expect(out[3]).toBe("    4");
  });
});
