// The protected-write prompt's three answers, kept apart from App.tsx so the
// key handling can be tested without React.
//
// "Allow always" exists because the same grant was asked for at the start of
// every session in a repo the bots were building: the bridge saves the root
// to the project's botference/project.json, so the prompt never returns for it.

export type PermissionChoice = "once" | "always" | "deny";

export const PERMISSION_CHOICES: readonly PermissionChoice[] = ["once", "always", "deny"];

export const PERMISSION_LABELS: Record<PermissionChoice, string> = {
  once: "Allow once",
  always: "Allow always",
  deny: "Deny",
};

export const PERMISSION_KEYS_HINT =
  "Enter confirms | Tab/Left/Right switches | Y once | A always | N/Esc denies";

/** The next choice along, wrapping; `step` is +1 (Tab, Right) or -1 (Left). */
export function cyclePermissionChoice(choice: PermissionChoice, step: 1 | -1): PermissionChoice {
  const n = PERMISSION_CHOICES.length;
  const i = PERMISSION_CHOICES.indexOf(choice);
  return PERMISSION_CHOICES[(i + step + n) % n];
}

/** The answer a single letter gives directly, or null for any other key. */
export function permissionChoiceForKey(input: string): PermissionChoice | null {
  switch (input.toLowerCase()) {
    case "y":
      return "once";
    case "a":
      return "always";
    case "n":
      return "deny";
    default:
      return null;
  }
}

/** The bridge message for an answer. `always` rides beside `allow`, so a
 *  bridge that predates it still reads an allow. */
export function permissionResponse(requestId: string, choice: PermissionChoice) {
  return {
    type: "permission_response" as const,
    request_id: requestId,
    allow: choice !== "deny",
    ...(choice === "always" ? { always: true } : {}),
  };
}
