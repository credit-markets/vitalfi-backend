/**
 * API Contract Tests
 */

import { describe, it, expect } from "vitest";
import type { VaultDTO, PositionDTO, ActivityDTO } from "../src/types/dto.js";

describe("API response shapes", () => {
  it("should match VaultDTO shape", () => {
    const vault: VaultDTO = {
      vaultPda: "test",
      vaultTokenAccount: "test",
      authority: "test",
      vaultId: "1",
      assetMint: "test",
      status: "Funding",
      cap: "1000",
      totalDeposited: "500",
      totalClaimed: "0",
      targetApyBps: 500,
      minDeposit: "100",
      fundingEndTs: "1234567890",
      maturityTs: "1234567890",
      slot: 123,
      updatedAt: new Date().toISOString(),
      updatedAtEpoch: Math.floor(Date.now() / 1000),
    };

    expect(vault).toHaveProperty("vaultPda");
    expect(vault).toHaveProperty("vaultTokenAccount");
    expect(vault).toHaveProperty("status");
    expect(vault).toHaveProperty("updatedAtEpoch");
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
      updatedAtEpoch: Math.floor(Date.now() / 1000),
    };

    expect(position).toHaveProperty("positionPda");
    expect(position).toHaveProperty("deposited");
    expect(position).toHaveProperty("updatedAtEpoch");
  });

  it("should match ActivityDTO shape", () => {
    const activity: ActivityDTO = {
      id: "test:deposit:123",
      txSig: "test",
      slot: 123,
      blockTime: new Date().toISOString(),
      blockTimeEpoch: Math.floor(Date.now() / 1000),
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
    expect(activity).toHaveProperty("blockTimeEpoch");
  });
});
