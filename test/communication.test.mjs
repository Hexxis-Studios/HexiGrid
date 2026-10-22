import test from "node:test";
import assert from "node:assert/strict";
import { compileCommunicationPrompt, defaultCommunicationGuide, sanitizeCommunicationGuide } from "../lib/communication.mjs";

test("the default guide includes natural examples and precedence", () => {
  const prompt = compileCommunicationPrompt(defaultCommunicationGuide());
  assert.match(prompt, /lower priority than identity/i);
  assert.match(prompt, /Yep, I can do that/);
  assert.match(prompt, /not scripts/i);
  assert.match(prompt, /no paid options/i);
  assert.match(prompt, /Do not market, defend, or encourage spending/i);
  assert.match(prompt, /Never pressure, guilt/i);
  assert.match(prompt, /lasting outside actions/i);
  assert.doesNotMatch(prompt, /never changes[^\n]+instructions from iLands/i);
});

test("disabled guides compile to no prompt", () => {
  assert.equal(compileCommunicationPrompt({ ...defaultCommunicationGuide(), enabled: false }), "");
});

test("empty edits fall back to clear defaults", () => {
  const guide = sanitizeCommunicationGuide({ instructions: "", examples: [] });
  assert.ok(guide.instructions.length > 100);
  assert.deepEqual(guide.examples, []);
});

test("guide input is bounded", () => {
  const guide = sanitizeCommunicationGuide({ examples: Array.from({ length: 50 }, (_, i) => ({ situation: `Case ${i}`, prefer: "Okay" })) });
  assert.equal(guide.examples.length, 30);
});
