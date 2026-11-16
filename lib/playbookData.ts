import { PlaybookPayload } from "./types/playbook";
import { generateDailyPlaybook } from "./playbookEngine";

/** Lazy helper (avoids synchronous static preset generation at client bundle load). */
export function getDefaultPlaybookPayload(): PlaybookPayload {
  return generateDailyPlaybook();
}
