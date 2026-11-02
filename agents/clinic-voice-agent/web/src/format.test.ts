import { describe, expect, it } from "vitest";
import { duration, ms, pipelineLabel, statusLabel, usd } from "./format";

describe("format", () => {
  it("shows milliseconds under a second and seconds above", () => {
    expect(ms(412.6)).toBe("413 ms");
    expect(ms(1530)).toBe("1.53 s");
    expect(ms(null)).toBe("–");
  });
  it("formats cost and length", () => {
    expect(usd(0)).toBe("$0");
    expect(usd(0.01234, 3)).toBe("$0.012");
    expect(duration(75)).toBe("1m 15s");
    expect(duration(9.4)).toBe("9s");
  });
  it("names pipelines and statuses in plain words", () => {
    expect(pipelineLabel("text:gemini-3.8-flash")).toBe("Simulation · gemini-3.8-flash");
    expect(statusLabel("caller_hung_up")).toBe("Caller hung up");
    expect(statusLabel(null)).toBe("In progress");
  });
});
