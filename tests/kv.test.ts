/**
 * KV Operations Tests
 */

import { describe, it, expect } from "vitest";

describe("KV operations", () => {
  it("should serialize and deserialize JSON", () => {
    const data = { test: "value", number: 123 };
    const serialized = JSON.stringify(data);
    const deserialized = JSON.parse(serialized);

    expect(deserialized).toEqual(data);
  });

  it("should handle null values", () => {
    const value = null;
    expect(value).toBeNull();
  });
});
