CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  title TEXT,
  author TEXT,
  branch TEXT,
  base_branch TEXT,
  head_sha TEXT,
  pr_url TEXT,
  is_draft INTEGER DEFAULT 0,
  pr_state TEXT DEFAULT 'open',
  review_status TEXT DEFAULT 'pending',
  verdict TEXT,
  severity_critical INTEGER DEFAULT 0,
  severity_high INTEGER DEFAULT 0,
  severity_medium INTEGER DEFAULT 0,
  severity_low INTEGER DEFAULT 0,
  reviewed_head_sha TEXT,
  last_reviewed_at TEXT,
  last_attempted_at TEXT,
  raw_report_md TEXT,
  error_message TEXT,
  UNIQUE(repo, pr_number)
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_request_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  file TEXT,
  line INTEGER,
  severity TEXT,
  summary TEXT,
  failure_scenario TEXT,
  evidence TEXT,
  fix_suggestion TEXT,
  code_snippet TEXT
);

CREATE INDEX IF NOT EXISTS idx_findings_pr ON findings(pull_request_id);
