// One-time import of the prompts in pi's saved sessions into the prompt history
// used by extensions/prompt-history.ts. Safe to run again: it adds nothing twice.
//
//   npm run history:import

import { homedir } from "node:os";
import { join } from "node:path";
import { ENV_FILE, importSessions } from "../extensions/lib/prompt-history.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const file = process.env[ENV_FILE] || join(agentDir, "prompt-history.jsonl");
const sessionsDir = process.env.PI_CODING_AGENT_SESSION_DIR || join(agentDir, "sessions");

const r = importSessions(file, sessionsDir);
console.log(`read ${r.sessions} session files from ${sessionsDir}`);
console.log(`added ${r.added} prompts from ${r.projects} projects to ${file}`);
if (r.skippedMissingCwd > 0) console.log(`skipped ${r.skippedMissingCwd} prompts whose project directory no longer exists`);
