/**
 * `bun run test:python`: the adapter's tests, run inside the pinned SkillOpt
 * (they need uv). Kept out of `bun test`, which runs everywhere uv may not be.
 */
import { join } from "node:path";
import { PYTHON_DIR, readPin, skilloptArgv } from "./skillopt.ts";

const proc = Bun.spawn(skilloptArgv(await readPin(), ["-m", "unittest", "discover", "-s", join(PYTHON_DIR, "tests")]), { stdout: "inherit", stderr: "inherit" });
process.exitCode = await proc.exited;
