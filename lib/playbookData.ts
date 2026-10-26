import { PlaybookPayload } from "./types/playbook";
import { generateDailyPlaybook } from "./playbookEngine";

export const DEFAULT_PLAYBOOK_PAYLOAD: PlaybookPayload = generateDailyPlaybook();
