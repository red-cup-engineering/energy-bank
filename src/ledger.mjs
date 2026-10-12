/**
 * `ledger` — an append-only, double-entry audit journal for the shared ENERGY economy.
 *
 * Lifted near-verbatim from flickering-delve-service's `ledger.mts` (already proven
 * game-agnostic once, via onestone's near-verbatim port): don't hand-roll bookkeeping, record
 * every transaction as a balanced double-entry transaction, and lean on the ecosystem to
 * *prove* the books — the journal renders to canonical hledger text and is independently
 * reduced into per-account balances on every audit. "Auditable" here means a third party can
 * replay that portable journal with standard ledger tooling and get the same balances — the
 * trace is the audit, never a cached running total.
 *
 * Append-only: entries are never mutated or deleted, only appended. `record()` refuses to
 * append an unbalanced entry, but the ledger can still be *constructed* from an arbitrary
 * initial entry list (mirroring the flickering-delve precedent exactly) — that is deliberate:
 * it is what lets `invariants.mjs`'s property tests build a deliberately malformed ledger to
 * confirm the checks actually catch it, without needing a second, unsafe write path.
 *
 * **Sign convention** (this package's own choice — nothing upstream fixes it, since no
 * existing game's ledger tracks a player-facing energy balance yet): debit-positive,
 * credit-negative, exactly as flickering-delve's existing postings already do for
 * `assets:cash:*` (positive) and `income:*` (negative). `liabilities:energy:<account>` is
 * treated as **debit-positive** in this ledger — a positive balance means "currently held by
 * this account" — which is *why* it can carry the literal name "liability" (the bank owes it
 * back) while still reading naturally as "how much energy this player has." `expenses:*`
 * (including `expenses:payout:<provider>`) is debit-positive, matching ordinary expense
 * accounting and the payout-invariant's own reference implementation. `income:*` is
 * credit-negative, matching flickering-delve's existing `income:premium` postings exactly.
 *
 * Type shapes (`Posting`, `LedgerEntry`, `AuditReport`, `Ledger`) are declared in the
 * co-located ledger.d.ts, not here — this file is plain JavaScript, no TypeScript syntax, so
 * it loads correctly whether run directly or imported from inside a consumer's node_modules
 * (Node's type-stripping is unavailable for files under node_modules, which is why this
 * package ships .mjs rather than .mts as its runtime source).
 */
import * as decimal from "./decimal.mjs";

const ZERO = decimal.parse("0");

/** Sum postings per commodity with exact decimal arithmetic, to check the double-entry
 *  invariant at whatever precision the commodity actually carries. Deliberately *not* scaled
 *  to a fixed minor unit: a wei is eighteen places out, and the previous 1e6-scaled-double
 *  check rounded it to zero, accepting a one-sided entry as balanced. `decimal.mjs` carries
 *  every amount as an exact BigInt rational, so cents, millis, satoshis, wei, and fractional
 *  share quantities are all weighed without rounding. */
function imbalances(postings) {
  const byCommodity = new Map();
  for (const p of postings) {
    let parsed;
    try {
      parsed = decimal.parse(p.amount);
    } catch {
      return [`non-numeric amount "${p.amount}"`];
    }
    byCommodity.set(p.commodity, decimal.add(byCommodity.get(p.commodity) ?? ZERO, parsed));
  }
  const bad = [];
  for (const [c, total] of byCommodity) {
    if (!decimal.isZero(total)) bad.push(`${c} off by ${decimal.format(total)}`);
  }
  return bad;
}

/** Render entries to canonical hledger journal text — the portable, replayable artifact. */
export function journalText(entries) {
  const out = [];
  for (const e of entries) {
    out.push(`${e.date} * ${e.narration}  ; ref:${e.ref}`);
    for (const p of e.postings) out.push(`    ${p.account}  ${p.amount} ${p.commodity}`);
    out.push("");
  }
  return out.join("\n");
}

/** The in-memory, append-only reference implementation of `Ledger`. */
export class MemoryLedger {
  #entries = [];

  constructor(initial = []) {
    this.#entries.push(...initial);
  }

  all() {
    return this.#entries;
  }

  /** Append a balanced entry. Throws if the postings do not net to zero per commodity — an
   *  unbalanced transaction is a bug, and we refuse to record bad books. */
  record(entry) {
    if (entry.postings.length === 0) throw new RangeError(`ledger: entry ${entry.ref} has no postings`);
    const bad = imbalances(entry.postings);
    if (bad.length > 0) throw new RangeError(`ledger: unbalanced entry ${entry.ref}: ${bad.join("; ")}`);
    this.#entries.push(entry);
  }

  /** Whether an entry with this ref already exists (idempotency for retried writes). */
  has(ref) {
    return this.#entries.some((e) => e.ref === ref);
  }

  /** Audit the books by replaying every immutable posting, returning independently-computed
   *  balances and a balanced/malformed verdict alongside the portable hledger journal. */
  audit() {
    const journal = journalText(this.#entries);
    const balances = {};
    let malformed = 0;
    for (const entry of this.#entries) {
      if (imbalances(entry.postings).length > 0) { malformed++; continue; }
      for (const posting of entry.postings) {
        const row = (balances[posting.account] ??= {});
        const prior = row[posting.commodity] === undefined ? ZERO : decimal.parse(row[posting.commodity]);
        row[posting.commodity] = decimal.format(decimal.add(prior, decimal.parse(posting.amount)));
      }
    }
    return { entries: this.#entries.length, balanced: malformed === 0, malformed, balances, journal };
  }

  toJSON() {
    return this.#entries;
  }
}

/** Build a `Ledger`. `initial` seeds the entry list without validation — the same
 *  no-validation-on-construct behavior `MemoryLedger`'s constructor documents above. */
export function createLedger(initial = []) {
  return new MemoryLedger(initial);
}
