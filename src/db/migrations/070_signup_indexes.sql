-- Create indexes for signup performance and case-insensitive lookups
CREATE INDEX IF NOT EXISTS idx_user_username_lower ON "user"(LOWER(username));
CREATE INDEX IF NOT EXISTS idx_user_email_lower ON "user"(LOWER(email));

-- Audit log for monitoring signup abuse patterns
CREATE TABLE IF NOT EXISTS signup_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip_address TEXT,
  status TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_signup_audit_email ON signup_audit(email);
CREATE INDEX IF NOT EXISTS idx_signup_audit_ip ON signup_audit(ip_address);
CREATE INDEX IF NOT EXISTS idx_signup_audit_created_at ON signup_audit(created_at);
