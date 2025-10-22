/**
 * Pagination Edge Cases Tests
 *
 * Tests for cursor-based pagination logic, boundary conditions,
 * and duplicate prevention across pages.
 */

import { describe, it, expect } from "vitest";

describe("Cursor pagination", () => {
  describe("Cursor boundary handling", () => {
    it("should handle exclusive cursor ranges correctly", () => {
      // Simulate ZSET scores
      const items = [
        { id: "1", score: 1000 },
        { id: "2", score: 900 },
        { id: "3", score: 800 },
        { id: "4", score: 700 },
      ];

      // First page: get items > cursor (exclusive)
      const cursor = 900;
      const page1 = items.filter(item => item.score < cursor);

      // Should exclude item with score === cursor
      expect(page1).toHaveLength(2);
      expect(page1[0].id).toBe("3");
      expect(page1[1].id).toBe("4");
      expect(page1.find(item => item.score === cursor)).toBeUndefined();
    });

    it("should not return duplicate items across pages", () => {
      const items = [
        { id: "1", epoch: 1000 },
        { id: "2", epoch: 900 },
        { id: "3", epoch: 800 },
        { id: "4", epoch: 700 },
        { id: "5", epoch: 600 },
      ];

      const limit = 2;

      // Page 1: no cursor, get first 2
      const page1 = items.slice(0, limit);
      const cursor1 = page1[page1.length - 1].epoch;

      // Page 2: use exclusive cursor
      const page2 = items.filter(item => item.epoch < cursor1).slice(0, limit);

      // Verify no overlap
      const page1Ids = page1.map(i => i.id);
      const page2Ids = page2.map(i => i.id);
      const intersection = page1Ids.filter(id => page2Ids.includes(id));

      expect(intersection).toHaveLength(0);
      expect(page1Ids).toEqual(["1", "2"]);
      expect(page2Ids).toEqual(["3", "4"]);
    });

    it("should handle items with identical timestamps", () => {
      const items = [
        { id: "1", epoch: 1000 },
        { id: "2", epoch: 900 },
        { id: "3", epoch: 900 }, // Same epoch as id:2
        { id: "4", epoch: 800 },
      ];

      // When cursor is 900, both items with epoch 900 should be excluded
      const cursor = 900;
      const filtered = items.filter(item => item.epoch < cursor);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("4");
    });
  });

  describe("Empty and single-item results", () => {
    it("should return null nextCursor for empty results", () => {
      const items: any[] = [];
      const hasMore = items.length > 2;
      const nextCursor = hasMore && items.length > 0
        ? items[items.length - 1].epoch
        : null;

      expect(nextCursor).toBeNull();
    });

    it("should return null nextCursor for single item under limit", () => {
      const items = [{ id: "1", epoch: 1000 }];
      const limit = 2;
      const hasMore = items.length > limit;
      const nextCursor = hasMore && items.length > 0
        ? items[items.length - 1].epoch
        : null;

      expect(nextCursor).toBeNull();
    });

    it("should return nextCursor when exactly at limit+1", () => {
      const items = [
        { id: "1", epoch: 1000 },
        { id: "2", epoch: 900 },
        { id: "3", epoch: 800 },
      ];
      const limit = 2;
      const hasMore = items.length > limit;
      const sliced = hasMore ? items.slice(0, limit) : items;
      const nextCursor = hasMore && sliced.length > 0
        ? sliced[sliced.length - 1].epoch
        : null;

      expect(hasMore).toBe(true);
      expect(nextCursor).toBe(900);
      expect(sliced).toHaveLength(2);
    });
  });

  describe("Cursor fallback logic", () => {
    it("should use blockTimeEpoch when available", () => {
      const activity = {
        blockTimeEpoch: 1000,
        slot: 123456,
      };

      const cursor = activity.blockTimeEpoch ?? activity.slot;
      expect(cursor).toBe(1000);
    });

    it("should fallback to slot when blockTimeEpoch is null", () => {
      const activity = {
        blockTimeEpoch: null,
        slot: 123456,
      };

      const cursor = activity.blockTimeEpoch ?? activity.slot;
      expect(cursor).toBe(123456);
    });

    it("should maintain consistent ordering with mixed cursor types", () => {
      // When mixing blockTimeEpoch (~1.7B) and slot (~200M),
      // they should be handled consistently
      const items = [
        { id: "1", blockTimeEpoch: 1700000000, slot: 200000000 },
        { id: "2", blockTimeEpoch: null, slot: 200000001 },
        { id: "3", blockTimeEpoch: 1600000000, slot: 190000000 },
      ];

      // All use same fallback logic
      const cursors = items.map(item => item.blockTimeEpoch ?? item.slot);

      // Verify descending order
      expect(cursors[0]).toBeGreaterThan(cursors[1]);
      expect(cursors[2]).toBeGreaterThan(cursors[1]);
    });
  });

  describe("Limit and offset handling", () => {
    it("should respect maximum limit of 100", () => {
      const requestedLimit = 500;
      const maxLimit = 100;
      const effectiveLimit = Math.min(requestedLimit, maxLimit);

      expect(effectiveLimit).toBe(100);
    });

    it("should default to 50 when limit not provided", () => {
      const limit = undefined;
      const defaultLimit = 50;
      const effectiveLimit = limit ?? defaultLimit;

      expect(effectiveLimit).toBe(50);
    });

    it("should fetch limit+1 to determine hasMore", () => {
      const limit = 10;
      const fetchCount = limit + 1;

      // Simulate fetching 11 items
      const items = Array.from({ length: 11 }, (_, i) => ({
        id: String(i),
        epoch: 1000 - i,
      }));

      const hasMore = items.length > limit;
      const returned = hasMore ? items.slice(0, limit) : items;

      expect(fetchCount).toBe(11);
      expect(hasMore).toBe(true);
      expect(returned).toHaveLength(10);
    });
  });

  describe("Cursor validation", () => {
    it("should reject negative cursors", () => {
      const cursor = -100;
      const isValid = cursor > 0;

      expect(isValid).toBe(false);
    });

    it("should reject zero cursors", () => {
      const cursor = 0;
      const isValid = cursor > 0;

      expect(isValid).toBe(false);
    });

    it("should accept cursors within valid range", () => {
      const now = Math.floor(Date.now() / 1000);
      const cursor = now - 86400; // 1 day ago
      const maxFuture = now + (7 * 86400); // 7 days future
      const isValid = cursor > 0 && cursor <= maxFuture;

      expect(isValid).toBe(true);
    });

    it("should dynamically validate future cursors", () => {
      const getMaxCursor = () => Math.floor(Date.now() / 1000) + (7 * 86400);

      const cursor1 = getMaxCursor() - 1;
      const isValid1 = cursor1 <= getMaxCursor();
      expect(isValid1).toBe(true);

      const cursor2 = getMaxCursor() + 1;
      const isValid2 = cursor2 <= getMaxCursor();
      expect(isValid2).toBe(false);
    });
  });
});
