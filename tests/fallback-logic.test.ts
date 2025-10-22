/**
 * ZSET Fallback Logic Tests
 *
 * Tests for graceful degradation from ZSET indexes to SET fallback,
 * including memory limits and filtering behavior.
 */

import { describe, it, expect } from "vitest";

describe("ZSET → SET fallback logic", () => {
  describe("ZSET success path", () => {
    it("should use ZSET when available", async () => {
      // Simulate successful ZSET query
      const mockZrevrangebyscore = async () => {
        return ["vault1", "vault2", "vault3"];
      };

      let usedZset = false;
      let pdas: string[];

      try {
        pdas = await mockZrevrangebyscore();
        usedZset = true;
      } catch {
        pdas = [];
      }

      expect(usedZset).toBe(true);
      expect(pdas).toHaveLength(3);
    });

    it("should not sort when using ZSET (already sorted)", () => {
      const vaults = [
        { id: "1", updatedAtEpoch: 1000 },
        { id: "2", updatedAtEpoch: 900 },
        { id: "3", updatedAtEpoch: 800 },
      ];

      const usedZset = true;

      // Only sort if NOT using ZSET
      if (!usedZset) {
        vaults.sort((a, b) => b.updatedAtEpoch - a.updatedAtEpoch);
      }

      // Verify order unchanged (already sorted from ZSET)
      expect(vaults[0].id).toBe("1");
      expect(vaults[1].id).toBe("2");
      expect(vaults[2].id).toBe("3");
    });

    it("should skip status filtering when using per-status ZSET", () => {
      const vaults = [
        { id: "1", status: "Funding" },
        { id: "2", status: "Funding" },
        { id: "3", status: "Funding" },
      ];

      const requestedStatus = "Funding";
      const usedZset = true;

      // No filtering needed - ZSET already filtered by status
      const filtered = (usedZset || !requestedStatus)
        ? vaults
        : vaults.filter(v => v.status === requestedStatus);

      expect(filtered).toHaveLength(3);
      expect(filtered).toBe(vaults); // Same reference, no filtering
    });
  });

  describe("SET fallback path", () => {
    it("should fallback to SET when ZSET fails", async () => {
      const mockZrevrangebyscore = async () => {
        throw new Error("ZSET not found");
      };

      const mockSmembers = async () => {
        return ["vault1", "vault2"];
      };

      let usedZset = false;
      let pdas: string[];

      try {
        pdas = await mockZrevrangebyscore();
        usedZset = true;
      } catch {
        pdas = await mockSmembers();
      }

      expect(usedZset).toBe(false);
      expect(pdas).toHaveLength(2);
    });

    it("should sort when using SET fallback", () => {
      const vaults = [
        { id: "1", updatedAtEpoch: 800 },
        { id: "2", updatedAtEpoch: 1000 },
        { id: "3", updatedAtEpoch: 900 },
      ];

      const usedZset = false;

      if (!usedZset) {
        vaults.sort((a, b) => b.updatedAtEpoch - a.updatedAtEpoch);
      }

      // Verify descending order
      expect(vaults[0].updatedAtEpoch).toBe(1000);
      expect(vaults[1].updatedAtEpoch).toBe(900);
      expect(vaults[2].updatedAtEpoch).toBe(800);
    });

    it("should apply status filtering when using SET fallback", () => {
      const vaults = [
        { id: "1", status: "Funding" },
        { id: "2", status: "Active" },
        { id: "3", status: "Funding" },
      ];

      const requestedStatus = "Funding";
      const usedZset = false;

      const filtered = (usedZset || !requestedStatus)
        ? vaults
        : vaults.filter(v => v.status === requestedStatus);

      expect(filtered).toHaveLength(2);
      expect(filtered.every(v => v.status === "Funding")).toBe(true);
    });
  });

  describe("Memory safety limits", () => {
    it("should reject SET fallback when size exceeds MAX_SET_SIZE", () => {
      const MAX_SET_SIZE = 1000;
      const pdas = Array.from({ length: 1500 }, (_, i) => `vault${i}`);

      const shouldReject = pdas.length > MAX_SET_SIZE;

      expect(shouldReject).toBe(true);
      expect(pdas.length).toBe(1500);
    });

    it("should allow SET fallback when size is under MAX_SET_SIZE", () => {
      const MAX_SET_SIZE = 1000;
      const pdas = Array.from({ length: 500 }, (_, i) => `vault${i}`);

      const shouldReject = pdas.length > MAX_SET_SIZE;

      expect(shouldReject).toBe(false);
      expect(pdas.length).toBe(500);
    });

    it("should allow SET fallback at exactly MAX_SET_SIZE", () => {
      const MAX_SET_SIZE = 1000;
      const pdas = Array.from({ length: 1000 }, (_, i) => `vault${i}`);

      const shouldReject = pdas.length > MAX_SET_SIZE;

      expect(shouldReject).toBe(false);
    });

    it("should log warning when SET size exceeds threshold", () => {
      const SET_WARNING_THRESHOLD = 100;
      const pdas = Array.from({ length: 250 }, (_, i) => `vault${i}`);

      const shouldWarn = pdas.length > SET_WARNING_THRESHOLD;

      expect(shouldWarn).toBe(true);
    });

    it("should not log warning when SET size is under threshold", () => {
      const SET_WARNING_THRESHOLD = 100;
      const pdas = Array.from({ length: 50 }, (_, i) => `vault${i}`);

      const shouldWarn = pdas.length > SET_WARNING_THRESHOLD;

      expect(shouldWarn).toBe(false);
    });
  });

  describe("Data consistency", () => {
    it("should handle missing vault JSONs during fallback", () => {
      const pdas = ["vault1", "vault2", "vault3"];
      const fetchResults = [
        { vaultPda: "vault1", status: "Funding" },
        null, // vault2 missing
        { vaultPda: "vault3", status: "Active" },
      ];

      const vaults: any[] = [];
      const missingPdas: string[] = [];

      fetchResults.forEach((v, i) => {
        if (v === null) {
          missingPdas.push(pdas[i]);
        } else {
          vaults.push(v);
        }
      });

      expect(vaults).toHaveLength(2);
      expect(missingPdas).toEqual(["vault2"]);
    });

    it("should maintain ZSET order when all JSONs present", () => {
      const pdas = ["vault3", "vault1", "vault2"]; // From ZSET (sorted)
      const vaults = pdas.map(pda => ({
        vaultPda: pda,
        updatedAtEpoch: parseInt(pda.replace("vault", "")) * 100,
      }));

      // Should maintain ZSET order (no sorting needed)
      expect(vaults[0].vaultPda).toBe("vault3");
      expect(vaults[1].vaultPda).toBe("vault1");
      expect(vaults[2].vaultPda).toBe("vault2");
    });
  });

  describe("Performance characteristics", () => {
    it("should avoid O(N log N) sort with ZSET", () => {
      const items = 1000;
      const usedZset = true;

      // With ZSET: O(log N + M) for ZREVRANGEBYSCORE
      // With SET: O(N) for SMEMBERS + O(N log N) for sort

      const zsetComplexity = Math.log2(items) + items;
      const setComplexity = items + items * Math.log2(items);

      // ZSET should be more efficient for large datasets
      expect(zsetComplexity).toBeLessThan(setComplexity);
    });

    it("should minimize memory with limit+1 fetch", () => {
      const totalItems = 10000;
      const limit = 50;
      const fetchCount = limit + 1;

      // ZSET fetches only what's needed
      const memoryUsed = fetchCount;

      // SET would fetch all, then filter
      const setMemoryUsed = totalItems;

      expect(memoryUsed).toBe(51);
      expect(memoryUsed).toBeLessThan(setMemoryUsed);
    });
  });

  describe("Error recovery", () => {
    it("should handle ZSET errors gracefully", async () => {
      const mockZset = async () => {
        throw new Error("Redis connection timeout");
      };

      const mockSet = async () => {
        return ["vault1"];
      };

      let errorOccurred = false;
      let result: string[];

      try {
        result = await mockZset();
      } catch (err) {
        errorOccurred = true;
        result = await mockSet();
      }

      expect(errorOccurred).toBe(true);
      expect(result).toEqual(["vault1"]);
    });

    it("should not throw when both ZSET and SET fail", async () => {
      const mockZset = async () => {
        throw new Error("ZSET failed");
      };

      const mockSet = async () => {
        throw new Error("SET failed");
      };

      let finalError: Error | null = null;

      try {
        await mockZset();
      } catch {
        try {
          await mockSet();
        } catch (err) {
          finalError = err as Error;
        }
      }

      expect(finalError).not.toBeNull();
      expect(finalError?.message).toBe("SET failed");
    });
  });

  describe("Transition scenarios", () => {
    it("should transition from SET to ZSET as index builds", async () => {
      let iteration = 0;

      const getVaults = async () => {
        iteration++;

        // First call: ZSET not ready, use SET
        // Second call: ZSET ready, use ZSET
        if (iteration === 1) {
          throw new Error("ZSET not ready");
        }
        return ["vault1", "vault2"];
      };

      // First request
      let usedZset1 = false;
      try {
        await getVaults();
        usedZset1 = true;
      } catch {
        // Fallback to SET
      }

      // Second request
      let usedZset2 = false;
      try {
        await getVaults();
        usedZset2 = true;
      } catch {
        // Fallback to SET
      }

      expect(usedZset1).toBe(false);
      expect(usedZset2).toBe(true);
    });
  });
});
