import { describe, it, expect } from "vitest";
import { renderMenu, windowFor } from "../src/ui/menu.js";

/** Strip ANSI so assertions run on visible content. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("windowFor", () => {
  it("shows everything when it fits", () => {
    expect(windowFor(3, 0, 8)).toEqual([0, 3]);
  });

  it("keeps the selection centered when overflowing", () => {
    // 20 items, height 8, selecting #10 → a window around it.
    const [start, end] = windowFor(20, 10, 8);
    expect(end - start).toBe(8);
    expect(start).toBeLessThanOrEqual(10);
    expect(end).toBeGreaterThan(10);
  });

  it("clamps the window at the end of the list", () => {
    const [start, end] = windowFor(20, 19, 8);
    expect(end).toBe(20);
    expect(start).toBe(12);
  });
});

describe("renderMenu", () => {
  const items = [
    { label: "/model", hint: "set the model" },
    { label: "/mode", hint: "permission mode" },
    { label: "/exit", hint: "quit" },
  ];

  it("marks the selected row and shows labels + hints", () => {
    const { rows } = renderMenu(items, 1);
    const text = rows.map(plain);
    expect(text.some((r) => r.includes("/model"))).toBe(true);
    expect(text.some((r) => r.includes("permission mode"))).toBe(true);
    // The selected row (index 1) carries the › marker.
    expect(text[1]).toContain("›");
    expect(text[0]).not.toContain("›");
  });

  it("reports no matches for an empty list", () => {
    const { rows } = renderMenu([], 0);
    expect(plain(rows[0]!)).toContain("no matches");
  });

  it("adds a '· N more' footer when the list overflows the height", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `/c${i}` }));
    const top = renderMenu(many, 0, 8).rows.map(plain).join("\n");
    expect(top).toContain("↓ 4 more");
    expect(top).not.toContain("↑");

    const bottom = renderMenu(many, 11, 8).rows.map(plain).join("\n");
    expect(bottom).toContain("↑ 4 earlier");
    expect(bottom).not.toContain("↓ 0");
  });

  it("shows both directions when the selection is in the middle", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `/c${i}` }));
    const joined = renderMenu(many, 10, 8).rows.map(plain).join("\n");
    expect(joined).toContain("↑");
    expect(joined).toContain("↓");
  });

  it("truncates rows so they do not wrap at the terminal edge", () => {
    const { rows } = renderMenu(
      [
        {
          label: "/mode",
          hint: "Show or set the permission mode (default|plan|acceptEdits|allowAll)",
        },
      ],
      0,
      8,
      40,
    );
    expect(plain(rows[0]!).length).toBeLessThanOrEqual(40);
  });

  it("renders non-selectable group headings without the selection marker", () => {
    const { rows } = renderMenu(
      [
        { label: "Profiles", selectable: false, tone: "dim" },
        { label: "work", hint: "openai · gpt-4o", tone: "green" },
        { label: "Actions", selectable: false, tone: "dim" },
        { label: "New profile" },
      ],
      1,
    );
    const text = rows.map(plain);
    expect(text[0]).toContain("Profiles");
    expect(text[0]).not.toContain("›");
    expect(text[2]).toContain("Actions");
    expect(text[2]).not.toContain("›");
    expect(text[1]).toContain("›");
  });
});
