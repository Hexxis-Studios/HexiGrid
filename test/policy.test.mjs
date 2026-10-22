import test from "node:test";
import assert from "node:assert/strict";
import { detectHumanVerificationChallenge, evaluatePolicy } from "../lib/policy.mjs";

test("plan mode blocks writes even under full access", () => {
  const result = evaluatePolicy({ approvalPolicy: "full", workMode: "plan", capability: "write_workspace", risk: "low" });
  assert.equal(result.decision, "deny");
});

test("ask mode prompts for every permitted tool action", () => {
  const result = evaluatePolicy({ approvalPolicy: "ask", workMode: "research", capability: "network_read", risk: "low" });
  assert.equal(result.decision, "ask");
});

test("approve-for-me prompts on high-risk work", () => {
  const result = evaluatePolicy({ approvalPolicy: "review", workMode: "build", capability: "external_write", risk: "high" });
  assert.equal(result.decision, "ask");
});

test("approve-for-me permits routine scoped work", () => {
  const result = evaluatePolicy({ approvalPolicy: "review", workMode: "build", capability: "write_workspace", risk: "medium" });
  assert.equal(result.decision, "allow");
});

test("full access still cannot escape the selected mode", () => {
  const result = evaluatePolicy({ approvalPolicy: "full", workMode: "converse", capability: "run_tools", risk: "low" });
  assert.equal(result.decision, "deny");
});

test("human verification always pauses instead of pretending to be human", () => {
  assert.equal(detectHumanVerificationChallenge("Please complete the CAPTCHA"), true);
  const result = evaluatePolicy({ approvalPolicy: "full", workMode: "build", capability: "external_write", risk: "low", humanVerification: true });
  assert.equal(result.decision, "ask");
  assert.match(result.reason, /will not claim to be human/);
});
