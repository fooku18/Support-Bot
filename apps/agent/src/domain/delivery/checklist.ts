/** the only dynamic progress text. No raw tool/event envelope is retained. */
import type { TaskChecklistDto, TaskProjectEvidenceDto } from '../../contracts/dto.js';

export function safeChecklistLabel(text: string): string {
  // Apply the credential shapes used by the tool runtimes BEFORE shortening.
  return (
    text
      .replace(/(?:glpat|gldt|glptt|glrt|gloas|glcbt|glimt)-[A-Za-z0-9_-]{6,}/g, '[redacted]')
      .replace(/(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted]')
      .replace(
        /sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]+|ATP[A-Za-z0-9_-]{8,}|dd(?:pat|sat)_[A-Za-z0-9_-]{8,}/g,
        '[redacted]',
      )
      .replace(
        /\b(?:password|secret|(?:access_|private_|auth_|refresh_|job_)?token|_authToken)\s*[:=]\s*\S+/gi,
        '[redacted]',
      )
      .replace(/`[^`]*`|<[^>]*>|https?:\/\/\S+|\bwww\.\S+/gi, '')
      .replace(/(?:^|\s)(?:\.?\.?\/|[A-Za-z]:\\)\S+/g, ' ')
      .replace(/\b\S+\/(?:\S+)/g, '')
      .replace(/@[\p{L}\p{N}._-]+/gu, '')
      .replace(/[&<>`*_~|\\]/g, '')
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
      .trim() || 'Task item'
  );
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid checklist object');
  return value as Record<string, unknown>;
}

export function parseChecklist(value: unknown): TaskChecklistDto {
  const v = object(value);
  if (
    Object.keys(v).some(
      (k) => !['objectiveRunId', 'runId', 'attempt', 'revision', 'items'].includes(k),
    )
  )
    throw new Error('unexpected checklist field');
  if (
    typeof v.runId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(v.runId) ||
    v.objectiveRunId !== v.runId
  )
    throw new Error('invalid checklist objective');
  if (
    !Number.isSafeInteger(v.attempt) ||
    Number(v.attempt) < 0 ||
    !Number.isSafeInteger(v.revision) ||
    Number(v.revision) < 1
  )
    throw new Error('invalid checklist revision');
  if (!Array.isArray(v.items) || v.items.length > 6)
    throw new Error('checklist requires at most six items');
  const items = v.items.map((item, index) => {
    const i = object(item);
    if (
      Object.keys(i).some((k) => !['ordinal', 'label', 'status'].includes(k)) ||
      i.ordinal !== index + 1 ||
      typeof i.label !== 'string' ||
      i.label.length < 1 ||
      i.label.length > 80 ||
      typeof i.status !== 'string' ||
      !['pending', 'in_progress', 'completed'].includes(i.status)
    )
      throw new Error('invalid checklist item');
    return {
      ordinal: index + 1,
      label: safeChecklistLabel(i.label),
      status: i.status as TaskChecklistDto['items'][number]['status'],
    };
  });
  return {
    objectiveRunId: v.runId,
    runId: v.runId,
    attempt: Number(v.attempt),
    revision: Number(v.revision),
    items,
  };
}

export function parseProjectEvidence(value: unknown): TaskProjectEvidenceDto[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('invalid project evidence');
  const projects = new Set<string>();
  return value.map((item) => {
    const v = object(item);
    if (
      Object.keys(v).some(
        (k) => !['project', 'treeDigest', 'verification', 'publication'].includes(k),
      ) ||
      typeof v.project !== 'string' ||
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(v.project) ||
      v.project.length > 160 ||
      projects.has(v.project)
    )
      throw new Error('invalid evidence project');
    projects.add(v.project);
    if (
      v.treeDigest !== null &&
      (typeof v.treeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.treeDigest))
    )
      throw new Error('invalid evidence tree');
    if (
      typeof v.verification !== 'string' ||
      typeof v.publication !== 'string' ||
      !['not_run', 'passed', 'failed', 'timed_out', 'incomplete', 'unknown'].includes(
        v.verification,
      ) ||
      !['not_published', 'published', 'unknown'].includes(v.publication)
    )
      throw new Error('invalid evidence outcome');
    if (v.treeDigest === null && (v.verification !== 'unknown' || v.publication !== 'unknown'))
      throw new Error('evidence requires a current tree');
    return {
      project: v.project,
      treeDigest: v.treeDigest as string | null,
      verification: v.verification as TaskProjectEvidenceDto['verification'],
      publication: v.publication as TaskProjectEvidenceDto['publication'],
    };
  });
}

export function renderChecklist(
  checklist: TaskChecklistDto | null,
  evidence: TaskProjectEvidenceDto[],
): string {
  const lines: string[] = [];
  if (checklist !== null && checklist.items.length > 0) {
    lines.push('Model plan (reported by agent):');
    for (const item of checklist.items)
      lines.push(
        `${item.status === 'completed' ? '☑' : item.status === 'in_progress' ? '◐' : '☐'} ${safeChecklistLabel(item.label)}`,
      );
  }
  if (evidence.length > 0) {
    lines.push('Controller evidence (current trees):');
    for (const row of evidence.slice(0, 8))
      lines.push(
        `${row.project}: Verify: ${row.verification.replaceAll('_', ' ')} · Publish: ${row.publication.replaceAll('_', ' ')}`,
      );
    if (evidence.length > 8) lines.push(`${evidence.length - 8} further projects not shown.`);
  }
  return lines.length === 0 ? '' : '\n\n' + lines.join('\n');
}
