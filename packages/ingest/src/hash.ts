import { createHash } from 'node:crypto';
import type { CanonicalJob } from '@bankjobs/core';

/**
 * Stable content fingerprint of a job. Covers every field whose change should
 * count as a "content update" (and therefore bump `updated_at` / re-index FTS).
 * Lifecycle fields (seen timestamps, status) are deliberately excluded so that
 * merely re-seeing an unchanged job writes nothing to the content columns.
 */
export function contentHash(job: CanonicalJob): string {
  const payload = JSON.stringify([
    job.title,
    job.category,
    job.employmentType,
    job.descriptionHtml,
    job.primaryLocation,
    JSON.stringify(job.locations),
    job.country,
    job.applyUrl,
    job.postedDate,
    job.brand,
  ]);
  return createHash('sha256').update(payload).digest('hex');
}
