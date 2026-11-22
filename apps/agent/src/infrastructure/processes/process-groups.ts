/** Confirm process-group termination before releasing execution authority. */
import fs from 'node:fs';
export class VerificationShutdownError extends Error {
  constructor() {
    super('Verification process termination could not be confirmed');
    this.name = 'VerificationShutdownError';
  }
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw new VerificationShutdownError();
  }
}

/** Linux group membership inspection excludes zombies, which cannot write. */
export function processGroupActive(pgid: number): boolean {
  try {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      let stat: string;
      try {
        stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      } catch (err) {
        if (
          (err as NodeJS.ErrnoException).code === 'ENOENT' ||
          (err as NodeJS.ErrnoException).code === 'ESRCH'
        )
          continue;
        throw err;
      }
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') return true;
    }
    return false;
  } catch {
    throw new VerificationShutdownError();
  }
}

export async function stopProcessGroup(pgid: number | undefined): Promise<void> {
  if (pgid === undefined || !processGroupActive(pgid)) return;
  killGroup(pgid, 'SIGTERM');
  const started = Date.now();
  while (Date.now() - started < 3000) {
    if (!processGroupActive(pgid)) return;
    if (Date.now() - started >= 200) killGroup(pgid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new VerificationShutdownError();
}
