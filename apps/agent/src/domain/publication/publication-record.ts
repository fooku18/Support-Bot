/** Confirmed publication of one project in an application run. */
export type PublishRecord = {
  state: string;
  /** Canonical project path. */
  project: string;
  commit: string | null;
  tree: string | null;
  branch: string | null;
  targetBranch: string | null;
  projectId: number;
  mrIid: number | null;
  mrUrl: string | null;
  lastError: string | null;
};
