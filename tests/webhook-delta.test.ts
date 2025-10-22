/**
 * Webhook Delta Calculation Tests
 *
 * Tests for amount delta calculations in webhook processing,
 * including vault and position state changes.
 */

import { describe, it, expect } from "vitest";

describe("Webhook delta calculations", () => {
  describe("Vault deposit deltas", () => {
    it("should calculate delta for deposit with previous state", () => {
      const oldVault = {
        totalDeposited: "1000",
        totalClaimed: "0",
      };

      const newVault = {
        totalDeposited: 1500n,
        totalClaimed: 0n,
      };

      const oldDeposited = BigInt(oldVault.totalDeposited || "0");
      const delta = newVault.totalDeposited - oldDeposited;

      expect(delta).toBe(500n);
      expect(delta.toString()).toBe("500");
    });

    it("should handle first deposit on existing vault (no previous state)", () => {
      type VaultState = {
        totalDeposited: bigint;
        totalClaimed: bigint;
      };
      const oldVault: VaultState | undefined = undefined;
      const newVault: VaultState = {
        totalDeposited: 1000n,
        totalClaimed: 0n,
      };

      type Action = "deposit" | "initializeVault" | "claim";
      const action: Action = "deposit";

      // When no previous state, use total deposited
      let amount: string | undefined;
      if (!oldVault && (action === "deposit" || action === "initializeVault")) {
        if (newVault.totalDeposited > 0n) {
          amount = newVault.totalDeposited.toString();
        }
      }

      expect(amount).toBe("1000");
    });

    it("should handle initializeVault with initial deposit", () => {
      type VaultState = {
        totalDeposited: bigint;
        totalClaimed: bigint;
      };
      const oldVault: VaultState | undefined = undefined;
      const newVault: VaultState = {
        totalDeposited: 5000n,
        totalClaimed: 0n,
      };

      type Action = "deposit" | "initializeVault" | "claim";
      const action: Action = "initializeVault";

      // Check if action is a deposit type action
      const depositActions: Action[] = ["deposit", "initializeVault"];
      const isDepositAction = depositActions.includes(action);

      let amount: string | undefined;
      if (!oldVault && isDepositAction) {
        if (newVault.totalDeposited > 0n) {
          amount = newVault.totalDeposited.toString();
        }
      }

      expect(amount).toBe("5000");
    });

    it("should not capture amount if delta is zero", () => {
      const oldVault = {
        totalDeposited: "1000",
        totalClaimed: "0",
      };

      const newVault = {
        totalDeposited: 1000n, // No change
        totalClaimed: 0n,
      };

      const oldDeposited = BigInt(oldVault.totalDeposited);
      const delta = newVault.totalDeposited - oldDeposited;

      let amount: string | undefined;
      if (delta > 0n) {
        amount = delta.toString();
      }

      expect(delta).toBe(0n);
      expect(amount).toBeUndefined();
    });

    it("should not capture negative delta", () => {
      const oldVault = {
        totalDeposited: "1000",
        totalClaimed: "0",
      };

      const newVault = {
        totalDeposited: 500n, // Decreased (should not happen normally)
        totalClaimed: 0n,
      };

      const oldDeposited = BigInt(oldVault.totalDeposited);
      const delta = newVault.totalDeposited - oldDeposited;

      let amount: string | undefined;
      if (delta > 0n) {
        amount = delta.toString();
      }

      expect(delta).toBe(-500n);
      expect(amount).toBeUndefined();
    });
  });

  describe("Vault claim deltas", () => {
    it("should calculate delta for claim with previous state", () => {
      const oldVault = {
        totalDeposited: "10000",
        totalClaimed: "2000",
      };

      const newVault = {
        totalDeposited: 10000n,
        totalClaimed: 3500n,
      };

      const oldClaimed = BigInt(oldVault.totalClaimed || "0");
      const delta = newVault.totalClaimed - oldClaimed;

      expect(delta).toBe(1500n);
      expect(delta.toString()).toBe("1500");
    });

    it("should handle first claim on matured vault", () => {
      const oldVault = {
        totalDeposited: "10000",
        totalClaimed: "0",
      };

      const newVault = {
        totalDeposited: 10000n,
        totalClaimed: 5000n,
      };

      const oldClaimed = BigInt(oldVault.totalClaimed || "0");
      const delta = newVault.totalClaimed - oldClaimed;

      expect(delta).toBe(5000n);
    });
  });

  describe("Position deposit deltas", () => {
    it("should calculate delta for position deposit", () => {
      const oldPosition = {
        deposited: "1000",
        claimed: "0",
      };

      const newPosition = {
        deposited: 2000n,
        claimed: 0n,
      };

      const oldDeposited = BigInt(oldPosition.deposited || "0");
      const delta = newPosition.deposited - oldDeposited;

      expect(delta).toBe(1000n);
    });

    it("should handle first deposit to new position", () => {
      const oldPosition = undefined;
      const newPosition = {
        deposited: 500n,
        claimed: 0n,
      };

      const action: string = "deposit";

      let amount: string | undefined;
      if (!oldPosition && action === "deposit") {
        if (newPosition.deposited > 0n) {
          amount = newPosition.deposited.toString();
        }
      }

      expect(amount).toBe("500");
    });
  });

  describe("Position claim deltas", () => {
    it("should calculate delta for position claim", () => {
      const oldPosition = {
        deposited: "10000",
        claimed: "3000",
      };

      const newPosition = {
        deposited: 10000n,
        claimed: 5000n,
      };

      const oldClaimed = BigInt(oldPosition.claimed || "0");
      const delta = newPosition.claimed - oldClaimed;

      expect(delta).toBe(2000n);
    });

    it("should handle multiple partial claims", () => {
      // First claim
      let oldClaimed = 0n;
      let newClaimed = 1000n;
      let delta1 = newClaimed - oldClaimed;

      // Second claim
      oldClaimed = newClaimed;
      newClaimed = 2500n;
      let delta2 = newClaimed - oldClaimed;

      expect(delta1).toBe(1000n);
      expect(delta2).toBe(1500n);
    });
  });

  describe("Edge cases and error scenarios", () => {
    it("should handle null previous values", () => {
      const oldVault = {
        totalDeposited: null,
        totalClaimed: null,
      };

      const newVault = {
        totalDeposited: 1000n,
        totalClaimed: 0n,
      };

      const oldDeposited = BigInt(oldVault.totalDeposited || "0");
      const delta = newVault.totalDeposited - oldDeposited;

      expect(delta).toBe(1000n);
    });

    it("should handle string to BigInt conversion", () => {
      const oldValue = "123456789012345678901234567890"; // Very large number
      const newValue = 123456789012345678901234567900n;

      const delta = newValue - BigInt(oldValue);

      expect(delta).toBe(10n);
    });

    it("should preserve precision with u64 max values", () => {
      const u64Max = "18446744073709551615";
      const bigIntValue = BigInt(u64Max);

      expect(bigIntValue.toString()).toBe(u64Max);
    });

    it("should handle zero deposits correctly", () => {
      const oldVault = {
        totalDeposited: "0",
        totalClaimed: "0",
      };

      const newVault = {
        totalDeposited: 0n,
        totalClaimed: 0n,
      };

      const delta = newVault.totalDeposited - BigInt(oldVault.totalDeposited);

      expect(delta).toBe(0n);
    });
  });

  describe("Action type handling", () => {
    it("should capture amount for deposit action", () => {
      const action: string = "deposit";
      const oldDeposited = 1000n;
      const newDeposited = 1500n;

      let amount: string | undefined;
      if (action === "deposit" || action === "initializeVault") {
        const delta = newDeposited - oldDeposited;
        if (delta > 0n) {
          amount = delta.toString();
        }
      }

      expect(amount).toBe("500");
    });

    it("should capture amount for initializeVault action", () => {
      const action: string = "initializeVault";
      const oldDeposited = 0n;
      const newDeposited = 10000n;

      let amount: string | undefined;
      if (action === "deposit" || action === "initializeVault") {
        const delta = newDeposited - oldDeposited;
        if (delta > 0n) {
          amount = delta.toString();
        }
      }

      expect(amount).toBe("10000");
    });

    it("should capture amount for claim action", () => {
      const action: string = "claim";
      const oldClaimed = 2000n;
      const newClaimed = 4000n;

      let amount: string | undefined;
      if (action === "claim") {
        const delta = newClaimed - oldClaimed;
        if (delta > 0n) {
          amount = delta.toString();
        }
      }

      expect(amount).toBe("2000");
    });

    it("should not capture amount for other actions", () => {
      const action: string = "funding_finalized";
      const oldDeposited = 1000n;
      const newDeposited = 1000n;

      let amount: string | undefined;
      if (action === "deposit" || action === "initializeVault") {
        const delta = newDeposited - oldDeposited;
        if (delta > 0n) {
          amount = delta.toString();
        }
      }

      expect(amount).toBeUndefined();
    });
  });
});
