// Auto-integrate decision thresholds.
// Normalized score = raw_search_score / query_token_count,
// where raw_search_score counts token occurrences in the top-hit note.
// Can exceed 1 because one query token may match multiple times.
//
// Tuned on an initial small vault (~20 notes). Expect to retune as the
// vault grows and tokens become more distributed.

export const AUTO_INTEGRATE_BELOW = 0.5;   // normalized < this → auto-accept
export const REVIEW_DUP_ABOVE = 2.0;       // normalized >= this → probable duplicate
// 0.5 .. 2.0 → possibly related, pending review
