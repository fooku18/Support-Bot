/** Evidence checks of the native `tools` suite (T3), shared with its T2 test. */
import fs from 'node:fs';
import path from 'node:path';

/** The Atlassian token owner of the suite; Basic auth encodes `email:token`. */
export const TOOLS_SUITE_EMAIL = 'tools-bot@support-agent-test.example';

/** Every form a credential may travel or leak in: raw, base64 and Basic `email:token`. */
export function credentialForms(value, email = TOOLS_SUITE_EMAIL) {
  return [
    value,
    Buffer.from(value).toString('base64'),
    Buffer.from(`${email}:${value}`).toString('base64'),
  ];
}

/**
 * Files under `dir` that contain any form of a credential. Directories and
 * files in `skip` are not read; symbolic links are never followed.
 */
export function credentialHits(dir, credentials, skip = []) {
  const forms = Object.entries(credentials).flatMap(([name, value]) =>
    credentialForms(value).map((form) => [name, form]),
  );
  const hits = [];
  let files = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (skip.includes(full) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files += 1;
        const text = fs.readFileSync(full).toString('latin1');
        for (const [name, form] of forms)
          if (text.includes(form)) hits.push({ file: path.relative(dir, full), credential: name });
      }
    }
  };
  walk(dir);
  return { files, hits };
}
