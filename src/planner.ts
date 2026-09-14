// Chooses the review plan. With no hard effort override, a cheap classifier
// refines persona choice and per-PR focus; on any failure it falls back to the
// deterministic plan. A forced /review low|high skips the classifier.

import type { Effort } from './findings';
import type { Metrics } from './metrics';
import { assemblePlan, bucketEffort, buildPlan, focusFor, type Plan } from './policy';
import { classifyPlan } from './classify';

export async function planReview(metrics: Metrics, effortOverride?: Effort): Promise<Plan> {
  if (effortOverride === 'low' || effortOverride === 'high') {
    return buildPlan(metrics, effortOverride);
  }
  if (metrics.bucket === 'docs-only' || metrics.bucket === 'tests-only') {
    // Single obvious persona — not worth a classifier call.
    return buildPlan(metrics);
  }

  const choices = await classifyPlan(metrics);
  if (!choices || choices.length === 0) return buildPlan(metrics);

  return assemblePlan(choices, metrics.bucket, bucketEffort(metrics.bucket), focusFor(metrics));
}
