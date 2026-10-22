export const APPROVAL_PROFILES = Object.freeze({
  ask: {
    id: "ask",
    label: "Ask for approval",
    shortLabel: "Always ask",
    description: "Pause before every agent tool action, including reads outside the conversation."
  },
  review: {
    id: "review",
    label: "Approve for me",
    shortLabel: "Risk reviewed",
    description: "Proceed with routine work and ask before actions judged sensitive, destructive, costly, or difficult to reverse."
  },
  full: {
    id: "full",
    label: "Full access",
    shortLabel: "No prompts",
    description: "Proceed without per-action prompts inside the active mode, plugin grants, and device scopes."
  }
});

export const WORK_MODES = Object.freeze({
  converse: {
    id: "converse",
    label: "Converse",
    description: "Talk, reflect, and use attached context without taking tool actions.",
    capabilities: ["conversation"]
  },
  setup: {
    id: "setup",
    label: "Connect",
    description: "Set up accounts, models, plugins, and devices. Agent work remains paused.",
    capabilities: ["conversation", "read_local", "network_read", "write_workspace", "run_tools", "external_write"]
  },
  plan: {
    id: "plan",
    label: "Plan",
    description: "Inspect allowed information and produce a plan. No writes, execution, delegation, or external changes.",
    capabilities: ["conversation", "read_local", "network_read"]
  },
  goal: {
    id: "goal",
    label: "Goal",
    description: "Pursue a named outcome persistently, including parallel delegation when enabled.",
    capabilities: ["conversation", "read_local", "network_read", "write_workspace", "run_tools", "external_write", "spawn_subagents"]
  },
  sketch: {
    id: "sketch",
    label: "Sketch",
    description: "Create drafts, simulations, mockups, and previews without changing connected services.",
    capabilities: ["conversation", "read_local", "network_read", "write_drafts", "generate_media"]
  },
  research: {
    id: "research",
    label: "Research",
    description: "Gather and compare information, preserve citations, and write local research notes only.",
    capabilities: ["conversation", "read_local", "network_read", "write_notes", "spawn_subagents"]
  },
  build: {
    id: "build",
    label: "Build",
    description: "Create and change local projects, run tools, and use approved integrations.",
    capabilities: ["conversation", "read_local", "network_read", "write_workspace", "run_tools", "external_write", "generate_media", "spawn_subagents", "self_modify"]
  },
  watch: {
    id: "watch",
    label: "Watch",
    description: "Monitor approved sources or devices and notify on meaningful changes.",
    capabilities: ["conversation", "read_local", "network_read", "schedule", "notify", "spawn_subagents"]
  }
});

export const RISK_LEVELS = Object.freeze(["none", "low", "medium", "high", "critical"]);

export function detectHumanVerificationChallenge(value = "") {
  return /(?:captcha|reCAPTCHA|hCaptcha|cloudflare turnstile|verify you(?:'re| are) human|prove you(?:'re| are) human|i am human|robot check|bot check)/i.test(String(value));
}

export function evaluatePolicy({ approvalPolicy, workMode, capability, risk = "medium", humanVerification = false }) {
  const profile = APPROVAL_PROFILES[approvalPolicy] || APPROVAL_PROFILES.review;
  const mode = WORK_MODES[workMode] || WORK_MODES.converse;
  const normalizedRisk = RISK_LEVELS.includes(risk) ? risk : "medium";

  if (!mode.capabilities.includes(capability)) {
    return {
      decision: "deny",
      reason: `${mode.label} mode does not permit ${capability}.`,
      approvalPolicy: profile.id,
      workMode: mode.id
    };
  }

  if (humanVerification === true || detectHumanVerificationChallenge(humanVerification)) {
    return {
      decision: "ask",
      reason: "A human-verification challenge is present. HexiGrid will not claim to be human, solve the challenge, or bypass it; ask the owner to take over.",
      approvalPolicy: profile.id,
      workMode: mode.id
    };
  }

  if (capability === "conversation") {
    return { decision: "allow", reason: "Conversation does not invoke a tool action.", approvalPolicy: profile.id, workMode: mode.id };
  }

  if (profile.id === "ask") {
    return { decision: "ask", reason: "Ask for approval is active.", approvalPolicy: profile.id, workMode: mode.id };
  }

  if (profile.id === "review" && ["high", "critical"].includes(normalizedRisk)) {
    return { decision: "ask", reason: `The action was classified ${normalizedRisk} risk.`, approvalPolicy: profile.id, workMode: mode.id };
  }

  return {
    decision: "allow",
    reason: profile.id === "full" ? "Full access is active inside the current scopes." : "The action passed local risk review.",
    approvalPolicy: profile.id,
    workMode: mode.id
  };
}

export function publicPolicyCatalog() {
  return {
    approvalProfiles: Object.values(APPROVAL_PROFILES),
    workModes: Object.values(WORK_MODES).map((mode) => ({ ...mode, capabilities: [...mode.capabilities] })),
    riskLevels: [...RISK_LEVELS]
  };
}
