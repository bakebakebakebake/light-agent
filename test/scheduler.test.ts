import { describe, expect, it } from "vitest";
import {
  computeNextRunAt,
  validateScheduleSpec,
} from "../src/scheduler/store.js";

describe("scheduler store helpers", () => {
  it("validates once schedules into ISO timestamps", () => {
    const iso = validateScheduleSpec("once", "2026-06-03T20:30:00+08:00");
    expect(iso).toMatch(/^2026-06-03T12:30:00\.000Z$/);
  });

  it("validates daily schedules", () => {
    expect(validateScheduleSpec("daily", "09:30")).toBe("09:30");
  });

  it("validates weekly schedules", () => {
    expect(validateScheduleSpec("weekly", "mon@09:30")).toBe("mon@09:30");
  });

  it("computes the next daily run after the reference time", () => {
    const next = computeNextRunAt("daily", "09:30", "2026-06-03T10:00:00.000Z");
    expect(next).toBeTruthy();
    const scheduled = new Date(next!);
    expect(scheduled.getFullYear()).toBe(2026);
    expect(scheduled.getMonth()).toBe(5);
    expect(scheduled.getDate()).toBe(4);
    expect(scheduled.getHours()).toBe(9);
    expect(scheduled.getMinutes()).toBe(30);
    expect(scheduled.getSeconds()).toBe(0);
  });
});
