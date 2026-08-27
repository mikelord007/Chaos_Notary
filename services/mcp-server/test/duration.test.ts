import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateDuration,
  InvalidDurationError,
  MIN_DURATION_SECONDS,
  MAX_DURATION_SECONDS,
} from "../src/duration.js";

test("accepts the minimum boundary", () => {
  assert.doesNotThrow(() => validateDuration(MIN_DURATION_SECONDS));
});

test("accepts the maximum boundary", () => {
  assert.doesNotThrow(() => validateDuration(MAX_DURATION_SECONDS));
});

test("rejects below the minimum", () => {
  assert.throws(() => validateDuration(MIN_DURATION_SECONDS - 1), InvalidDurationError);
});

test("rejects above the maximum", () => {
  assert.throws(() => validateDuration(MAX_DURATION_SECONDS + 1), InvalidDurationError);
});

test("rejects non-integers", () => {
  assert.throws(() => validateDuration(30.5), InvalidDurationError);
});
