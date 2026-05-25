interface PolicyRule {
  name: string;
  body: string;
}

const TOOL_USE_RULES: PolicyRule[] = [
  {
    name: "SEARCH SCOPE",
    body:
      "When using Glob or Grep, always exclude vendored dependencies, " +
      "build outputs, generated files, and lockfiles unless the user explicitly asks " +
      "to include them. Do not glob with patterns that match the entire repository " +
      "when the user's request targets a specific feature area."
  },
  {
    name: "LARGE FILE GUARD",
    body:
      "Before reading a file, estimate its size from Glob or LS output. " +
      "If the file is likely over 20 KB (e.g. bundled JSON, data dumps, " +
      "minified code), do NOT read the whole file. Instead use Grep to locate the " +
      "relevant section, or ask the user for the specific part needed."
  }
];

const OUTPUT_RULES: PolicyRule[] = [
  {
    name: "OUTPUT DISCIPLINE",
    body:
      "Only create or modify files the user explicitly requested. " +
      "Never create documentation files (*.md, *.txt) unless the user asks for them. " +
      "Never overwrite the repository's existing README or any config file unless " +
      "the user asks for it. Do not create summary, preview, or reference documents."
  },
  {
    name: "CONCISE RESPONSES",
    body:
      "Keep the final summary under 300 words. Focus on what " +
      "was changed and any follow-up the user needs. Do not repeat the " +
      "implementation details already visible in the diff."
  },
  {
    name: "LANGUAGE",
    body:
      "Respond in the same language as the user's request. " +
      "If the request contains any Chinese text, respond in Chinese. " +
      "If the request is entirely in English, respond in English. " +
      "Never use emojis in responses."
  },
  {
    name: "GIT COMMITS",
    body:
      "When running git commit, use a single-line Conventional Commits subject only. " +
      "Never add Co-Authored-By, Co-authored-by, or any attribution trailer to the message."
  }
];

const WORKFLOW_RULES: PolicyRule[] = [
  {
    name: "TURN EFFICIENCY",
    body:
      "Complete the task in as few tool calls as possible. " +
      "Do not re-read a file you have already read in this session. " +
      "Do not repeat verification steps."
  },
  {
    name: "FOLLOW EXISTING PATTERNS",
    body:
      "When editing a file, closely follow the patterns already present in that file. " +
      "Do not introduce new property names, structures, or conventions that are not " +
      "already used by neighboring code. If the task requires something not covered " +
      "by existing patterns, search the codebase for prior art before inventing a new approach."
  },
  {
    name: "ALREADY DONE",
    body:
      "If the requested change already exists in the codebase, report that it is " +
      "already implemented and stop. Do not look for minor improvements to make. " +
      "Do not enter a verification loop checking every aspect of the existing " +
      "implementation. State what you found and finish."
  }
];

const ALL_POLICY_GROUPS: PolicyRule[][] = [
  TOOL_USE_RULES,
  OUTPUT_RULES,
  WORKFLOW_RULES
];

function buildPolicyLines(): string[] {
  const rules = ALL_POLICY_GROUPS.flat();
  return rules.map((rule, i) => `${i + 1}. ${rule.name} — ${rule.body}`);
}

const DIRECT_EDIT_MODE_HINT_LINES = [
  "Read files with Read, and modify them with Edit, MultiEdit, or Write.",
  "When editing, keep changes focused on the user's request.",
  "Before running destructive commands, ask the user for confirmation."
];

export function buildSystemPrompt(prompt: string): string {
  const policyEnabled = (process.env.AGENT_PROMPT_POLICY ?? "on").trim().toLowerCase() !== "off";
  const sections: string[] = [];

  if (policyEnabled) {
    sections.push("[POLICY]", ...buildPolicyLines());
  }

  sections.push("[INSTRUCTION]", ...DIRECT_EDIT_MODE_HINT_LINES);

  if (sections.length === 0) {
    return prompt;
  }

  return sections.join("\n") + `\n\n${prompt}`;
}
