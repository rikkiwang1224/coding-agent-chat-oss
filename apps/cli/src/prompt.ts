export function buildAgentPromptEnvelope(input: {
  prompt: string;
  workspaceRoot: string;
}): string {
  return [
    `[WORKSPACE_ROOT] ${input.workspaceRoot}`,
    "[USER_REQUEST]",
    input.prompt.trim() || "Continue.",
  ].join("\n");
}

export function buildResumePrompt(workspaceRoot: string, userRequest: string): string {
  return buildAgentPromptEnvelope({ workspaceRoot, prompt: userRequest });
}

export function extractUserRequest(rawPrompt: string): string {
  const marker = "[USER_REQUEST]";
  const idx = rawPrompt.lastIndexOf(marker);
  return idx < 0 ? rawPrompt : rawPrompt.slice(idx + marker.length).trim();
}
