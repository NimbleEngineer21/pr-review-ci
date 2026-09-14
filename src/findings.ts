// Shared types for the review pipeline.

export type Severity = 'blocker' | 'high' | 'medium' | 'nit';
export type Effort = 'low' | 'medium' | 'high';
export type Verdict = 'MERGE' | 'COMMENT' | 'BLOCK';

export const SEVERITY_RANK: Record<Severity, number> = {
  blocker: 3,
  high: 2,
  medium: 1,
  nit: 0,
};

/** One issue a single reviewer raised. */
export interface Finding {
  path: string;
  /** New-file (RIGHT side) line number, or null for a file/PR-level note. */
  line: number | null;
  severity: Severity;
  category: string;
  title: string;
  body: string;
  /** 0..1 self-reported confidence. */
  confidence?: number;
}

/** What one reviewer returned. */
export interface ReviewerResult {
  /** Persona id, also used for agreement attribution. */
  id: string;
  /** Human-readable persona title for the panel listing. */
  title: string;
  model: string;
  findings: Finding[];
  /** Set when the reviewer call failed; findings is then empty. */
  error?: string;
}

/** A finding after cross-model merge. */
export interface MergedFinding extends Finding {
  /** Reviewer ids that raised a matching issue (agreement is signal). */
  agreedBy: string[];
  /** True when it maps to a diff line and was chosen for an inline comment. */
  inline: boolean;
}

/** The synthesizer's consolidated output. */
export interface Synthesis {
  summary: string;
  verdict: Verdict;
  findings: MergedFinding[];
}
