/**
 * `transfer` — moving ENERGY between accounts: player-to-player transfer, pooling, and
 * selling, all kept ledger-native (every move is a balanced `LedgerEntry`, nothing tracked
 * outside the ledger except which pool members hold which shares).
 *
 * `transferEnergy` is the one primitive everything else composes: it debits one account's
 * `liabilities:energy:*` balance and credits another's, in a single entry, and by default
 * refuses to leave the source negative (the write-time half of `invariants.mjs`'s
 * no-negative-balance check — the check itself remains the audit-time half, for ledgers built
 * by other means). `fundAccount`/`spendFromAccount` are the two directions every transfer
 * needs a counterpart for: energy has to originate from *somewhere* (a real-money purchase's
 * `income:*`, or a game-internal earned-energy source) and can be spent *into* somewhere (an
 * in-game-use sink) without ever touching `income:*` or `expenses:payout:*` — matching the
 * spec's "internal accrual/spend never risks the payout invariant" framing exactly.
 *
 * A **pool** is an account like any other (its own `liabilities:energy:*` balance) plus a
 * pure, ledger-external record of member shares, used only to compute how a later
 * distribution splits — the shares themselves are never written to the ledger, only the
 * transfers they produce are.
 *
 * **Selling** energy is just `transferEnergy` with the agreed price recorded as a narration
 * memo — the ledger only ever moves ENERGY here. A sale settled through a real-money/crypto
 * backend is a separate, explicit step in settlement.mjs; this module never assumes one.
 *
 * Type shapes (`TransferOptions`, `PoolMember`, `Pool`) are declared in the co-located
 * transfer.d.ts, not here — this file is plain JavaScript, no TypeScript syntax, so it loads
 * correctly whether run directly or imported from inside a consumer's node_modules (Node's
 * type-stripping is unavailable for files under node_modules, which is why this package ships
 * .mjs rather than .mts as its runtime source).
 */
import { energyAccountPath } from "./accounts.mjs";
import * as decimal from "./decimal.mjs";

const MINOR = 1e6;
/** The place count `MINOR` represents: 1e6 minor units is exactly six decimal places. */
const MINOR_PLACES = 6;

/** Convert a decimal amount string to integer minor units for this module's pooling and
 *  balance arithmetic.
 *
 *  Unlike `ledger.mjs`, which weighs any commodity at its own precision, everything in this
 *  module is denominated in ENERGY, whose unit is fixed at six places — so integer minor
 *  units remain the right representation here, and the largest-remainder split in
 *  `poolDistribution` depends on them. What is *not* right is silently rounding an amount
 *  finer than that: a caller handing this module a wei-precision figure would previously have
 *  had it rounded to the nearest millionth (often to zero) and then transferred as if that
 *  were what they asked for. This refuses instead. Parsing is exact — no float is involved in
 *  deciding whether the amount fits. */
function toMinorUnits(amount) {
  let parsed;
  try {
    parsed = decimal.parse(amount);
  } catch {
    throw new RangeError(`transfer: not a numeric amount: "${amount}"`);
  }
  if (parsed.places > MINOR_PLACES) {
    throw new RangeError(
      `transfer: amount "${amount}" carries ${parsed.places} decimal places, finer than ENERGY's ${MINOR_PLACES}; refusing to round it`,
    );
  }
  return Number(decimal.rescale(parsed, MINOR_PLACES).units);
}

function fromMinorUnits(units) {
  return decimal.format({ units: BigInt(units), places: MINOR_PLACES });
}

function currentBalance(ledger, path, commodity) {
  const { balances } = ledger.audit();
  return toMinorUnits(balances[path]?.[commodity] ?? "0");
}

function assertFreshRef(ledger, op, ref) {
  if (ledger.has(ref)) throw new RangeError(`${op}: ref "${ref}" already recorded`);
}

function assertPositive(op, amount) {
  const units = toMinorUnits(amount);
  if (units <= 0) throw new RangeError(`${op}: amount must be positive, got "${amount}"`);
  return units;
}

/** Move `amount` of `commodity` from one account's ENERGY balance to another's, in a single
 *  balanced entry. Refuses a self-transfer, a non-positive amount, a reused ref, and (unless
 *  `allowCreditLine`) a transfer that would leave the source balance negative. */
export function transferEnergy(ledger, from, to, amount, commodity, ref, date, options = {}) {
  if (from === to) throw new RangeError(`transferEnergy: cannot transfer ${from} to itself`);
  const units = assertPositive("transferEnergy", amount);
  assertFreshRef(ledger, "transferEnergy", ref);
  const fromPath = energyAccountPath(from, commodity);
  if (options.allowCreditLine !== true) {
    const balance = currentBalance(ledger, fromPath, commodity);
    if (balance - units < 0) {
      throw new RangeError(
        `transferEnergy: ${from} holds ${fromMinorUnits(balance)} ${commodity}, cannot send ${amount}`,
      );
    }
  }
  const entry = {
    date,
    narration: options.narration ?? `transfer ${amount} ${commodity}: ${from} -> ${to}`,
    ref,
    postings: [
      { account: fromPath, amount: `-${amount}`, commodity },
      { account: energyAccountPath(to, commodity), amount, commodity },
    ],
  };
  ledger.record(entry);
}

/** Fund an account's ENERGY balance from an external source — the counterpart `transferEnergy`
 *  needs to originate energy in the first place. `source` is any chart-of-accounts path the
 *  caller already owns (e.g. `"income:premium"` for a real-money purchase, or
 *  `"equity:earned:onestone"` for a game-internal reward with no revenue implication). Never
 *  touches `liabilities:energy:*` on the source side, so it can't itself trip the
 *  no-negative-balance check on another player's account. */
export function fundAccount(ledger, source, to, amount, commodity, ref, date, narration) {
  assertPositive("fundAccount", amount);
  assertFreshRef(ledger, "fundAccount", ref);
  const entry = {
    date,
    narration: narration ?? `fund ${amount} ${commodity}: ${source} -> ${to}`,
    ref,
    postings: [
      { account: source, amount: `-${amount}`, commodity },
      { account: energyAccountPath(to, commodity), amount, commodity },
    ],
  };
  ledger.record(entry);
}

/** Debit an account's ENERGY balance for in-game use — the counterpart to `fundAccount`.
 *  `sink` is any chart-of-accounts path the caller owns (e.g.
 *  `"expenses:in-game-use:onestone"`); never `income:*` or `expenses:payout:*`, so ordinary
 *  spend can never touch the payout invariant. */
export function spendFromAccount(ledger, from, sink, amount, commodity, ref, date, options = {}) {
  const units = assertPositive("spendFromAccount", amount);
  assertFreshRef(ledger, "spendFromAccount", ref);
  const fromPath = energyAccountPath(from, commodity);
  if (options.allowCreditLine !== true) {
    const balance = currentBalance(ledger, fromPath, commodity);
    if (balance - units < 0) {
      throw new RangeError(
        `spendFromAccount: ${from} holds ${fromMinorUnits(balance)} ${commodity}, cannot spend ${amount}`,
      );
    }
  }
  const entry = {
    date,
    narration: options.narration ?? `spend ${amount} ${commodity}: ${from} -> ${sink}`,
    ref,
    postings: [
      { account: fromPath, amount: `-${amount}`, commodity },
      { account: sink, amount, commodity },
    ],
  };
  ledger.record(entry);
}

// ── pooling ──────────────────────────────────────────────────────────────────────────

/** A pool's own account id, namespaced like any other so its balance sits in the same chart
 *  as every player's. */
export function poolAccountId(namespace, poolLocalId) {
  return `${namespace}:pool-${poolLocalId}`;
}

function assertPositiveShares(m) {
  if (!(m.shares > 0)) throw new RangeError(`pool: ${m.account} must hold positive shares, got ${m.shares}`);
}

export function createPool(poolAccount, members = []) {
  for (const m of members) assertPositiveShares(m);
  return { account: poolAccount, members };
}

/** Pure update: set (or add) one member's share count, returning a new `Pool`. */
export function withMember(pool, member) {
  assertPositiveShares(member);
  const rest = pool.members.filter((m) => m.account !== member.account);
  return { account: pool.account, members: [...rest, member] };
}

export function totalShares(pool) {
  return pool.members.reduce((sum, m) => sum + m.shares, 0);
}

/** Split `amount` of a commodity across a pool's members, pro rata by share, at the ledger's
 *  own 1e6-minor-unit precision. Uses the largest-remainder method for the rounding leftover,
 *  so the sum of the split is always exactly `amount` — never a minor unit more or less. An
 *  empty pool (no members, or zero total shares) distributes nothing. */
export function poolDistribution(pool, amount) {
  const shares = totalShares(pool);
  const units = toMinorUnits(amount);
  if (shares <= 0 || pool.members.length === 0 || units <= 0) return new Map();
  const exact = pool.members.map((m) => ({ account: m.account, value: (units * m.shares) / shares }));
  const floors = exact.map((e) => ({
    account: e.account,
    floor: Math.floor(e.value),
    remainder: e.value - Math.floor(e.value),
  }));
  const bump = new Map(floors.map((f) => [f.account, f.floor]));
  let leftover = units - floors.reduce((sum, f) => sum + f.floor, 0);
  const byRemainder = [...floors].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < byRemainder.length && leftover > 0; i++, leftover--) {
    const acct = byRemainder[i].account;
    bump.set(acct, (bump.get(acct) ?? 0) + 1);
  }
  const out = new Map();
  for (const [acct, u] of bump) if (u > 0) out.set(acct, fromMinorUnits(u));
  return out;
}

/** A member contributing into a pool: an ordinary transfer into the pool's own account. */
export function contributeToPool(ledger, pool, from, amount, commodity, ref, date) {
  transferEnergy(ledger, from, pool.account, amount, commodity, ref, date, {
    narration: `pool contribution: ${from} -> ${pool.account}`,
  });
}

/** Split `amount` out of a pool's own balance across its members, pro rata by share — one
 *  transfer per member with a non-zero share of the split, each ref suffixed by the member's
 *  account id so the whole distribution is a set of independently idempotent postings. */
export function distributePool(ledger, pool, amount, commodity, refPrefix, date) {
  const split = poolDistribution(pool, amount);
  for (const [member, share] of split) {
    transferEnergy(ledger, pool.account, member, share, commodity, `${refPrefix}:${member}`, date, {
      narration: `pool distribution: ${pool.account} -> ${member}`,
    });
  }
}

// ── selling ──────────────────────────────────────────────────────────────────────────

/** Selling energy: a plain `transferEnergy` whose narration carries the agreed price as a
 *  memo. Kept ledger-native on purpose — the ledger only ever moves ENERGY here; if the sale
 *  is to be redeemed for real money/crypto through a settlement backend, that is a separate,
 *  explicit call into settlement.mjs, not implied by this one. */
export function sellEnergy(ledger, from, to, amount, commodity, priceMemo, ref, date) {
  transferEnergy(ledger, from, to, amount, commodity, ref, date, {
    narration: `sale (${priceMemo}): ${from} -> ${to}`,
  });
}
