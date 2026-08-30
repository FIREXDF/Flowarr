import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "./auth.js";

test("password round trip", () => { const hash = hashPassword("correct-horse-battery"); assert.equal(verifyPassword("correct-horse-battery", hash), true); assert.equal(verifyPassword("wrong-password", hash), false); });
test("weak passwords are rejected", () => assert.throws(() => hashPassword("short"), /12 characters/));
