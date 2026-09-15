import assert from "node:assert/strict";
import { getUpdateOptions, isNewerVersion } from "./logic.ts";

assert.equal(isNewerVersion("0.86.0", "0.85.1"), true);
assert.equal(isNewerVersion("0.85.1", "0.85.1"), false);
assert.equal(isNewerVersion("0.85.0", "0.85.1"), false);
assert.equal(isNewerVersion("not-a-version", "0.85.1"), false);
assert.equal(isNewerVersion("0.86.0-garbage", "0.85.1"), false);
assert.equal(isNewerVersion("0.86", "0.85.1"), false);

assert.deepEqual(
  getUpdateOptions(
    { piVersion: "0.86.0", packageNames: ["foo", "bar"] },
    "0.85.1",
  ).map((option) => option.choice),
  ["all", "pi", "extensions", "skip"],
);
assert.deepEqual(
  getUpdateOptions({ packageNames: [] }, "0.85.1").map(
    (option) => option.choice,
  ),
  ["skip"],
);
assert.deepEqual(
  getUpdateOptions({ packageNames: ["foo"] }, "0.85.1").map(
    (option) => option.choice,
  ),
  ["extensions", "skip"],
);

console.log("startup-update logic: ok");
