/**
 * `settlement` — the pluggable boundary between the ENERGY ledger and real money/crypto,
 * lifted directly from flickering-delve's `PaymentProvider` (already close to fully generic:
 * `id`, `configured`, `createIntent`, `settle`), generalized from `Order`/`Sku` into an
 * arbitrary `SettlementRequest` and extended with the payout direction flickering-delve never
 * needed.
 *
 * Two backends ship here:
 *   - `mockBackend` — clears instantly, always `configured`; the default in dev/test so the
 *     ledger is fully exercisable without any real payment processor.
 *   - `zbdBackend` — a ZBD/Lightning-**shaped** adapter STUB, matching flickering-delve's
 *     stripe/hive adapters' exact four-method interface and their "configured reflects
 *     whether credentials were supplied" convention. It performs **no live network call in
 *     either direction, ever** — `createIntent` throws if unconfigured and otherwise returns
 *     a structurally Lightning-invoice-shaped (but explicitly stub-labeled) result; `settle`
 *     always reports uncleared. Wiring it to the real ZBD API (an invoice-create POST in
 *     `createIntent`, a webhook or poll in `settle`, matching `hiveProvider`'s polling
 *     pattern) is future work, not attempted here.
 *
 * `onchainBackend` is the third implementation of this exact interface: a movement is a declared
 * treasury act (organizing accounting/treasury), planned on paper, authorized only by a standing
 * mandate and cleared only on a receipt two readings corroborate; it holds no key and calls no
 * network, and nothing that calls `authorizeSettlement` changes.
 *
 * `authorizeSettlement` is the one place this module touches the ledger, and it deliberately
 * stays narrow: it records real-money bookkeeping only, entirely in the *backend's own*
 * commodity (`assets:cash:<backend>`, `income:settlement:<backend>`,
 * `expenses:payout:<backend>`) — it never posts to `liabilities:energy:*`. Reducing a
 * player's ENERGY balance for a redemption is a separate, explicit `transfer.mjs` call the
 * caller makes alongside this one; keeping the two apart means settlement.mjs never has to
 * know ENERGY's exchange rate against any given backend's commodity. Before recording a
 * `"payout"` entry, it simulates the entry against a scratch copy of the ledger and refuses
 * (returns `cleared: false`) if posting it would break `invariants.mjs`'s payout invariant —
 * this is the concrete enforcement point the spec calls for: "a settlement backend calls this
 * … before authorizing any redemption."
 *
 * Type shapes (`SettlementRequest`, `IntentResult`, `SettleResult`, `SettlementBackend`,
 * `ZbdConfig`) are declared in the co-located settlement.d.ts, not here — this file is plain
 * JavaScript, no TypeScript syntax, so it loads correctly whether run directly or imported
 * from inside a consumer's node_modules (Node's type-stripping is unavailable for files under
 * node_modules, which is why this package ships .mjs rather than .mts as its runtime source).
 */
import { createLedger } from "./ledger.mjs";
import { verifyPayoutInvariant } from "./invariants.mjs";

// ── mock (dev / test) ────────────────────────────────────────────────────────────────

export const mockBackend = {
  id: "mock",
  configured: true,
  async createIntent(request) {
    return {
      provider: "mock",
      requestId: request.id,
      instructions: { kind: "mock", note: "dev backend — settles instantly, no real money moves" },
    };
  },
  async settle() {
    return { cleared: true, detail: "mock cleared" };
  },
};

// ── zbd (Lightning-shaped STUB — no live network calls) ────────────────────────────────

/** A ZBD/Lightning-shaped settlement backend STUB. Same four-method shape as flickering-
 *  delve's `stripeProvider`/`hiveProvider`; `configured` only reflects whether credentials
 *  were supplied. Neither method makes a network call under any configuration — this is
 *  deliberately unfinished plumbing standing in the correct shape, not a working integration. */
export function zbdBackend(config = {}) {
  const configured = typeof config.apiKey === "string" && config.apiKey.length > 0;
  return {
    id: "zbd",
    configured,
    async createIntent(request) {
      if (!configured) throw new Error("zbd: not configured (no apiKey)");
      return {
        provider: "zbd",
        requestId: request.id,
        instructions: {
          kind: "lightning-invoice-stub",
          amount: request.amount,
          commodity: request.commodity,
          note: "STUB — no live network call was made; wire to the real ZBD API before use",
        },
      };
    },
    async settle() {
      return { cleared: false, detail: "zbd: settlement is a stub — no live network call was made" };
    },
  };
}

// ── on-chain (declared, receipted acts — never signs, never broadcasts) ──────────────────

/** An on-chain settlement backend whose every movement is a declared treasury act (organizing
 *  accounting/treasury): `createIntent` returns the act's plan, on paper, as its signer would run
 *  it; `settle` clears only an act a standing mandate authorized (`authorize(act)` reads
 *  `stage: "authorized"`) whose receipt two independent readings of the chain corroborate
 *  (`settle(act, evidence)` reads `stage: "settled"`). It holds no key and makes no network call:
 *  the mandate's named signer executes the act, and the readings are witnessed elsewhere.
 *  `configured` says whether a mandate covers this backend at all. */
export function onchainBackend({ id = "onchain", configured = false, plan, authorize, settle }) {
  if (typeof plan !== "function" || typeof authorize !== "function" || typeof settle !== "function") {
    throw new TypeError("onchainBackend: plan, authorize and settle are required");
  }
  return {
    id,
    configured,
    async createIntent(request) {
      const act = plan(request);
      const authorization = authorize(act);
      return {
        provider: id,
        requestId: request.id,
        instructions: { kind: "treasury-act", act, authorization, note: authorization.stage === "authorized" ? `execute only through ${authorization.signer ?? "the mandate's signer"}` : "paper: no mandate covers this act" },
      };
    },
    async settle(request, evidence = {}) {
      const act = plan(request);
      const authorization = authorize(act);
      if (authorization.stage !== "authorized") return { cleared: false, detail: `${id}: no mandate authorizes ${act.id}` };
      const settlement = settle(act, evidence.receipt);
      if (settlement.stage !== "settled") return { cleared: false, detail: `${id}: ${act.id} is ${settlement.stage}, not corroborated by two readings` };
      return { cleared: true, detail: `${id}: ${settlement.transaction} corroborated by ${settlement.corroboratedBy.join(", ")} under ${authorization.mandate}` };
    },
  };
}

// ── registry ─────────────────────────────────────────────────────────────────────────

/** The best backend for a request: the requested one if configured, else the first other
 *  configured backend, else `mock` if present. Mirrors flickering-delve's `Payments.resolve`. */
export function resolveBackend(backends, requestedId) {
  if (requestedId !== undefined) {
    const found = backends.find((b) => b.id === requestedId);
    if (found !== undefined && found.configured) return found;
  }
  const configured = backends.find((b) => b.configured && b.id !== "mock");
  if (configured !== undefined) return configured;
  const mock = backends.find((b) => b.id === "mock");
  if (mock !== undefined) return mock;
  throw new RangeError("resolveBackend: no backend available (not even mock)");
}

export function availableBackends(backends) {
  return backends.map((b) => ({ id: b.id, configured: b.configured }));
}

// ── ledger integration ──────────────────────────────────────────────────────────────

function settlementEntry(request, date, backendId) {
  const { id, amount, commodity, direction } = request;
  const postings =
    direction === "purchase"
      ? [
          { account: `assets:cash:${backendId}`, amount, commodity },
          { account: `income:settlement:${backendId}`, amount: `-${amount}`, commodity },
        ]
      : [
          { account: `expenses:payout:${backendId}`, amount, commodity },
          { account: `assets:cash:${backendId}`, amount: `-${amount}`, commodity },
        ];
  return { date, narration: `${backendId} ${direction}: ${request.account} (${id})`, ref: id, postings };
}

/** Settle a request against a backend, and — only once actually cleared — record the
 *  real-money side to the ledger, idempotently keyed on `request.id`. A `"payout"` is
 *  simulated against a scratch copy of the ledger first and refused if it would break
 *  `verifyPayoutInvariant`; nothing about `ledger` is mutated when refused. */
export async function authorizeSettlement(ledger, backend, request, date, evidence) {
  if (ledger.has(request.id)) return { cleared: true, detail: "already settled" };
  const result = await backend.settle(request, evidence);
  if (!result.cleared) return result;

  const entry = settlementEntry(request, date, backend.id);
  if (request.direction === "payout") {
    const scratch = createLedger([...ledger.all(), entry]);
    const check = verifyPayoutInvariant(scratch);
    if (!check.holds) return { cleared: false, detail: `refused: ${check.detail}` };
  }
  ledger.record(entry);
  return result;
}
