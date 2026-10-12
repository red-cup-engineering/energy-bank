/**
 * `decimal` — exact decimal arithmetic over the ledger's string amounts.
 *
 * Every amount in this package crosses module boundaries as a decimal *string*
 * (`"4.99"`, `"-10"`, `"0.000000000000000001"`), and every module that needed to compare or
 * total those strings previously did it by way of `Number(amount)` — an IEEE-754 double —
 * scaled by a fixed `1e6`. That is exact for the 2-dp and 3-dp commodities this package was
 * written against (USD, HIVE, HBD) and silently wrong for anything finer:
 *
 *   - 1 wei (`"0.000000000000000001"` ETH) scaled by 1e6 rounds to **0**, so a one-sided
 *     entry moving a wei netted to zero and was accepted as *balanced*. Value vanished and
 *     the books reported clean.
 *   - `10 ETH` against `-10.000000000000000001 ETH` netted to zero for the same reason.
 *   - Above ~9.007e15 minor units the accumulator leaves `Number.MAX_SAFE_INTEGER` and the
 *     sum drifts regardless of scale.
 *
 * The double-entry check is the one thing this package exists to guarantee, so it must not
 * depend on the magnitude or precision of the commodity being weighed. This module replaces
 * the scaled-double representation with an exact one: a decimal is carried as a `BigInt`
 * numerator over a power-of-ten denominator (`units / 10n ** places`), which represents any
 * finite decimal string exactly, at any precision, with no representable maximum. Wei, satoshis,
 * 18-decimal ERC-20s, and fractional share quantities all land exactly, alongside the cents
 * and millis that already worked.
 *
 * Amounts are never *rounded* here. Two decimals are compared by rescaling both to their
 * common (larger) place count first, which is always exact — scaling up multiplies by a power
 * of ten. Nothing in this module can lose a digit.
 *
 * `format` renders back to the package's established string shape: minimal representation,
 * trailing fractional zeros trimmed, no decimal point when the value is whole (`"10"`, `"-5"`,
 * `"0"`, `"7.98"`), matching what the previous `String(Math.round(x * 1e6) / 1e6)` produced
 * for the values it could represent.
 *
 * Plain JavaScript with no TypeScript syntax, and shapes declared in the co-located
 * decimal.d.ts, for the same reason as every other runtime file here: Node cannot type-strip
 * a file resolved from inside a consumer's `node_modules`.
 */

/** Matches a finite decimal literal: optional sign, digits, optional fractional part. */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** Parse a decimal string into an exact `{ units, places }`, where the value is
 *  `units / 10n ** BigInt(places)`. Throws on anything that is not a finite decimal —
 *  including `"NaN"`, `"Infinity"`, and exponent notation, none of which a ledger amount
 *  should ever be, and all of which `Number()` would previously have accepted or coerced. */
export function parse(amount) {
  const text = typeof amount === "string" ? amount.trim() : String(amount);
  if (!DECIMAL.test(text)) throw new RangeError(`decimal: not a finite decimal amount: "${amount}"`);
  const negative = text.startsWith("-");
  const body = text.replace(/^[+-]/, "");
  const [whole, fraction = ""] = body.split(".");
  const units = BigInt((whole === "" ? "0" : whole) + fraction);
  return { units: negative ? -units : units, places: fraction.length };
}

/** Rescale a decimal to exactly `places` digits. Only ever scales *up*, so it is always
 *  exact; asking for fewer places than the value carries is a caller bug, not a rounding
 *  request, and throws rather than quietly dropping a digit. */
export function rescale(decimal, places) {
  if (places < decimal.places) {
    throw new RangeError(`decimal: refusing to rescale ${format(decimal)} down to ${places} places`);
  }
  return { units: decimal.units * 10n ** BigInt(places - decimal.places), places };
}

/** The exact sum of any number of decimals, carried at the finest precision present.
 *  An empty list sums to zero, matching the identity every caller expects. */
export function sum(decimals) {
  if (decimals.length === 0) return { units: 0n, places: 0 };
  const places = decimals.reduce((most, d) => (d.places > most ? d.places : most), 0);
  const units = decimals.reduce((total, d) => total + rescale(d, places).units, 0n);
  return { units, places };
}

/** The exact sum of two decimals. */
export function add(a, b) {
  return sum([a, b]);
}

/** `-1`, `0`, or `1` as `a` is less than, equal to, or greater than `b` — exact at whatever
 *  precision either side carries. */
export function cmp(a, b) {
  const places = a.places > b.places ? a.places : b.places;
  const left = rescale(a, places).units;
  const right = rescale(b, places).units;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isZero(decimal) {
  return decimal.units === 0n;
}

export function isNegative(decimal) {
  return decimal.units < 0n;
}

export function negate(decimal) {
  return { units: -decimal.units, places: decimal.places };
}

/** Render a decimal in the package's canonical string shape: trailing fractional zeros
 *  trimmed, and no decimal point at all when the value is whole. */
export function format(decimal) {
  const { units, places } = decimal;
  if (places === 0) return String(units);
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places).replace(/0+$/, "");
  const body = fraction === "" ? whole : `${whole}.${fraction}`;
  return negative && !/^0(\.0*)?$/.test(body) ? `-${body}` : body;
}

/** Parse, total, and re-render in one step — the shape most callers actually want. */
export function totalOf(amounts) {
  return format(sum(amounts.map(parse)));
}
