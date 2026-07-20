# @bankjobs/api — deferred

Cloudflare Worker read API (`GET /api/jobs`, `/api/jobs/:id`, `/api/meta`). Not built yet.

Before building: spike FTS5 virtual tables + triggers on a real D1 database — D1 restricts some
SQLite features, and if triggers are unavailable the ingest driver must maintain `jobs_fts`
explicitly instead. See the implementation plan in `docs/` and the deferred-milestones section of
the project plan.
