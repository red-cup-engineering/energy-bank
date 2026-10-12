import { test } from "node:test";
import assert from "node:assert/strict";
import * as decimal from "./decimal.mjs";

test("parse()/format(): round-trips a decimal string without losing a digit", () => {
  for (const amount of ["0", "10", "-5", "7.98", "4.99", "0.001", "-0.000000000000000001", "123456789012345678901234567890.5"]) {
    assert.equal(decimal.format(decimal.parse(amount)), amount);
  }
});

test("format(): renders minimally — trailing fractional zeros trimmed, no point when whole", () => {
  assert.equal(decimal.format(decimal.parse("10.000000")), "10");
  assert.equal(decimal.format(decimal.parse("7.980")), "7.98");
  assert.equal(decimal.format(decimal.parse("-0.0")), "0");
  assert.equal(decimal.format(decimal.parse(".5")), "0.5");
  assert.equal(decimal.format(decimal.parse("+3")), "3");
});

test("parse(): refuses anything that is not a finite decimal", () => {
  for (const bad of ["", "  ", "abc", "NaN", "Infinity", "-Infinity", "1e18", "1.2.3", "--1", "0x10"]) {
    assert.throws(() => decimal.parse(bad), RangeError, `expected "${bad}" to be refused`);
  }
});

test("sum(): exact at eighteen places — a wei does not vanish", () => {
  const wei = decimal.parse("0.000000000000000001");
  assert.equal(decimal.format(decimal.sum([wei])), "0.000000000000000001");
  assert.equal(decimal.isZero(decimal.sum([wei])), false);
  // Ten ETH plus one wei is not ten ETH.
  const total = decimal.sum([decimal.parse("10"), wei]);
  assert.equal(decimal.format(total), "10.000000000000000001");
});

test("sum(): exact far beyond Number.MAX_SAFE_INTEGER", () => {
  // 1e30 minor units — a scaled double would have lost the trailing digit long before here.
  const big = decimal.parse("1000000000000000000000000000000");
  assert.equal(decimal.format(decimal.sum([big, decimal.parse("1")])), "1000000000000000000000000000001");
});

test("sum(): the empty list is zero", () => {
  assert.equal(decimal.format(decimal.sum([])), "0");
  assert.equal(decimal.isZero(decimal.sum([])), true);
});

test("sum(): mixed precision totals at the finest precision present", () => {
  const total = decimal.sum([decimal.parse("1.5"), decimal.parse("-1.499999999999999999")]);
  assert.equal(decimal.format(total), "0.000000000000000001");
});

test("cmp(): compares exactly across differing precisions", () => {
  assert.equal(decimal.cmp(decimal.parse("10"), decimal.parse("10.000000000000000001")), -1);
  assert.equal(decimal.cmp(decimal.parse("10.000000000000000001"), decimal.parse("10")), 1);
  assert.equal(decimal.cmp(decimal.parse("10.00"), decimal.parse("10")), 0);
});

test("rescale(): refuses to scale down, because that would drop a digit", () => {
  assert.throws(() => decimal.rescale(decimal.parse("0.001"), 2), RangeError);
  assert.equal(decimal.format(decimal.rescale(decimal.parse("0.001"), 6)), "0.001");
});

test("isNegative()/negate(): exact at any precision", () => {
  assert.equal(decimal.isNegative(decimal.parse("-0.000000000000000001")), true);
  assert.equal(decimal.isNegative(decimal.parse("0")), false);
  assert.equal(decimal.format(decimal.negate(decimal.parse("-0.000000000000000001"))), "0.000000000000000001");
});

test("totalOf(): parses, totals, and renders in one step", () => {
  assert.equal(decimal.totalOf(["4.99", "-4.99"]), "0");
  assert.equal(decimal.totalOf(["0.000000000000000001", "0.000000000000000002"]), "0.000000000000000003");
});
