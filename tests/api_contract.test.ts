/**
 * API Contract Tests
 */

import { describe, it, expect } from "vitest";
import type { VaultDTO, PositionDTO, ActivityDTO } from "../src/types/dto.js";

describe("API response shapes", () => {
  it("should match VaultDTO shape", () => {
    const vault: VaultDTO = {
      vaultPda: "test",
      authority: "test",
      vaultId: "1",
      assetMint: "test",
      status: "Funding",
      cap: "1000",
      totalDeposited: "500",
      fundingEndTs: "1234567890",
      maturityTs: "1234567890",
      slot: 123,
      updatedAt: new Date().toISOString(),
    };

    expect(vault).toHaveProperty("vaultPda");
    expect(vault).toHaveProperty("status");
  });

  it("should match PositionDTO shape", () => {
    const position: PositionDTO = {
      positionPda: "test",
      vaultPda: "test",
      owner: "test",
      deposited: "100",
      claimed: "0",
      slot: 123,
      updatedAt: new Date().toISOString(),
    };

    expect(position).toHaveProperty("positionPda");
    expect(position).toHaveProperty("deposited");
  });

  it("should match ActivityDTO shape", () => {
    const activity: ActivityDTO = {
      id: "test:deposit:123",
      txSig: "test",
      slot: 123,
      blockTime: new Date().toISOString(),
      type: "deposit",
      vaultPda: "test",
      positionPda: null,
      authority: null,
      owner: "test",
      amount: "100",
      assetMint: "test",
    };

    expect(activity).toHaveProperty("id");
    expect(activity).toHaveProperty("type");
  });
});
