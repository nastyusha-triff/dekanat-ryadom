PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
CREATE TABLE users_next (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('student','teacher','deanery')), password_hash TEXT NOT NULL, profile TEXT NOT NULL);
--> statement-breakpoint
INSERT INTO users_next SELECT * FROM users;
--> statement-breakpoint
DROP TABLE users;
--> statement-breakpoint
ALTER TABLE users_next RENAME TO users;
--> statement-breakpoint
CREATE TABLE migration_integrity (valid INTEGER NOT NULL CHECK(valid=1));
--> statement-breakpoint
INSERT INTO migration_integrity SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
--> statement-breakpoint
DROP TABLE migration_integrity;
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE subjects ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE lessons ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE assignments ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE exams ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE rules ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE management_history (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, object_id TEXT NOT NULL, occurred_at TEXT NOT NULL, old_data TEXT, new_data TEXT NOT NULL);
