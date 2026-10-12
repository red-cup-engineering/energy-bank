import { test } from "node:test";
import assert from "node:assert/strict";
import { createLedger } from "./ledger.mjs";
import { verifyPayoutInvariant } from "./invariants.mjs";
import {
  mockBackend,
  zbdBackend,
  resolveBackend,
  availableBackends,
  authorizeSettlement,
} from "./settlement.mjs";

const DATE = "2026-08-19";

// ── mockBackend ──────────────────────────────────────────────────────────────────────

test("mockBackend: always configured, createIntent and settle never touch the network", async () => {
  assert.equal(mockBackend.configured, true);
  const intent = await mockBackend.createIntent({ id: "req-1", account: "onestone:account-a", amount: "5", commodity: "USD", direction: "purchase" });
  assert.equal(intent.provider, "mock");
  assert.equal(intent.requestId, "req-1");
  const result = await mockBackend.settle({ id: "req-1", account: "onestone:account-a", amount: "5", commodity: "USD", direction: "purchase" });
  assert.equal(result.cleared, true);
});

// ── zbdBackend (stub) ────────────────────────────────────────────────────────────────

test("zbdBackend: unconfigured with no apiKey", async () => {
  const backend = zbdBackend();
  assert.equal(backend.configured, false);
  await assert.rejects(() => backend.createIntent({ id: "r-1", account: "a", amount: "1", commodity: "SATS", direction: "purchase" }));
});

test("zbdBackend: configured when given an apiKey, but createIntent/settle still make no live network call and settle never clears", async () => {
  const backend = zbdBackend({ apiKey: "fake-key-for-shape-only" });
  assert.equal(backend.configured, true);
  const intent = await backend.createIntent({ id: "r-1", account: "onestone:account-a", amount: "1000", commodity: "SATS", direction: "purchase" });
  assert.equal(intent.provider, "zbd");
  assert.equal(intent.instructions["kind"], "lightning-invoice-stub");
  assert.match(String(intent.instructions["note"]), /STUB/i);
  const result = await backend.settle({ id: "r-1", account: "onestone:account-a", amount: "1000", commodity: "SATS", direction: "purchase" });
  assert.equal(result.cleared, false);
  assert.match(result.detail, /stub/i);
});

// ── registry ─────────────────────────────────────────────────────────────────────────

test("resolveBackend(): prefers the requested backend if it's configured", () => {
  const zbd = zbdBackend({ apiKey: "k" });
  const resolved = resolveBackend([mockBackend, zbd], "zbd");
  assert.equal(resolved.id, "zbd");
});

test("resolveBackend(): falls through to another configured backend if the requested one isn't configured", () => {
  const zbd = zbdBackend({ apiKey: "k" });
  const resolved = resolveBackend([mockBackend, zbd], "not-a-real-backend");
  assert.equal(resolved.id, "zbd");
});

test("resolveBackend(): falls all the way through to mock when nothing else is configured", () => {
  const resolved = resolveBackend([mockBackend, zbdBackend()]);
  assert.equal(resolved.id, "mock");
});

test("resolveBackend(): throws when not even mock is available", () => {
  assert.throws(() => resolveBackend([zbdBackend()]), RangeError);
});

test("availableBackends(): reports id + configured for each backend", () => {
  const list = availableBackends([mockBackend, zbdBackend()]);
  assert.deepEqual(list, [{ id: "mock", configured: true }, { id: "zbd", configured: false }]);
});

// ── authorizeSettlement ──────────────────────────────────────────────────────────────

test("authorizeSettlement(): purchase — records assets/income once cleared", async () => {
  const ledger = createLedger();
  const request = { id: "ord-1", account: "onestone:account-a", amount: "4.99", commodity: "USD", direction: "purchase" };
  const result = await authorizeSettlement(ledger, mockBackend, request, DATE);
  assert.equal(result.cleared, true);
  const { balances, balanced } = ledger.audit();
  assert.equal(balanced, true);
  assert.equal(balances["assets:cash:mock"]?.["USD"], "4.99");
  assert.equal(balances["income:settlement:mock"]?.["USD"], "-4.99");
});

test("authorizeSettlement(): is idempotent on a repeated request id", async () => {
  const ledger = createLedger();
  const request = { id: "ord-1", account: "onestone:account-a", amount: "4.99", commodity: "USD", direction: "purchase" };
  await authorizeSettlement(ledger, mockBackend, request, DATE);
  const second = await authorizeSettlement(ledger, mockBackend, request, DATE);
  assert.equal(second.cleared, true);
  assert.equal(second.detail, "already settled");
  assert.equal(ledger.all().length, 1);
});

test("authorizeSettlement(): an uncleared backend result never touches the ledger", async () => {
  const ledger = createLedger();
  const backend = zbdBackend({ apiKey: "k" }); // settle() always reports uncleared, per stub contract
  const request = { id: "ord-zbd-1", account: "onestone:account-a", amount: "1000", commodity: "SATS", direction: "purchase" };
  const result = await authorizeSettlement(ledger, backend, request, DATE);
  assert.equal(result.cleared, false);
  assert.equal(ledger.all().length, 0);
});

test("authorizeSettlement(): a payout within recognized revenue is authorized and recorded", async () => {
  const ledger = createLedger();
  await authorizeSettlement(ledger, mockBackend, { id: "rev-1", account: "onestone:account-a", amount: "10", commodity: "USD", direction: "purchase" }, DATE);
  const result = await authorizeSettlement(ledger, mockBackend, { id: "payout-1", account: "onestone:account-a", amount: "10", commodity: "USD", direction: "payout" }, DATE);
  assert.equal(result.cleared, true);
  assert.equal(verifyPayoutInvariant(ledger).holds, true);
});

test("authorizeSettlement(): refuses a payout that would exceed recognized revenue, and never mutates the ledger", async () => {
  const ledger = createLedger();
  await authorizeSettlement(ledger, mockBackend, { id: "rev-1", account: "onestone:account-a", amount: "10", commodity: "USD", direction: "purchase" }, DATE);
  const before = ledger.all().length;
  const result = await authorizeSettlement(ledger, mockBackend, { id: "payout-1", account: "onestone:account-a", amount: "11", commodity: "USD", direction: "payout" }, DATE);
  assert.equal(result.cleared, false);
  assert.match(result.detail, /refused/);
  assert.equal(ledger.all().length, before); // the refused entry was never appended
  assert.equal(ledger.has("payout-1"), false);
});

test("onchainBackend plans on paper, refuses without a mandate, and clears only a corroborated receipt", async () => {
  const { onchainBackend } = await import("./settlement.mjs");
  const act = { id: "act-1" };
  let mandated = false;
  const backend = onchainBackend({
    plan: () => act,
    authorize: () => (mandated ? { act: act.id, stage: "authorized", mandate: "grant-1", signer: "signer" } : { act: act.id, stage: "paper", refusals: [] }),
    settle: (_act, receipt) => (receipt?.readings?.length >= 2 ? { act: act.id, stage: "settled", transaction: receipt.transaction, corroboratedBy: ["a", "b"] } : { act: act.id, stage: "executed" }),
  });
  const intent = await backend.createIntent({ id: "r1" });
  assert.equal(intent.instructions.authorization.stage, "paper");
  assert.equal((await backend.settle({ id: "r1" }, {})).cleared, false);
  mandated = true;
  assert.equal((await backend.settle({ id: "r1" }, { receipt: { transaction: "0x1", readings: [{}] } })).cleared, false);
  assert.equal((await backend.settle({ id: "r1" }, { receipt: { transaction: "0x1", readings: [{}, {}] } })).cleared, true);
});
