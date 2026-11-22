CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('student','teacher')), password_hash TEXT NOT NULL, profile TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE login_attempts (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE subjects (id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, details TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE enrollments (student_id TEXT NOT NULL REFERENCES users(id), subject_id TEXT NOT NULL REFERENCES subjects(id), PRIMARY KEY(student_id,subject_id));
--> statement-breakpoint
CREATE TABLE lessons (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subjects(id), date TEXT NOT NULL, data TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE lesson_students (id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id), student_id TEXT NOT NULL REFERENCES users(id), UNIQUE(lesson_id,student_id));
--> statement-breakpoint
CREATE TABLE exams (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subjects(id), date TEXT NOT NULL, data TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE exam_students (id TEXT PRIMARY KEY, exam_id TEXT NOT NULL REFERENCES exams(id), student_id TEXT NOT NULL REFERENCES users(id), UNIQUE(exam_id,student_id));
--> statement-breakpoint
CREATE TABLE assignments (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subjects(id), sort_order INTEGER NOT NULL, data TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE results (student_id TEXT NOT NULL REFERENCES users(id), assignment_id TEXT NOT NULL REFERENCES assignments(id), score REAL, status TEXT NOT NULL, submitted_at TEXT, graded_at TEXT, feedback TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(student_id,assignment_id));
--> statement-breakpoint
CREATE TABLE rules (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subjects(id), sort_order INTEGER NOT NULL, data TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE calculations (student_id TEXT NOT NULL REFERENCES users(id), rule_id TEXT NOT NULL REFERENCES rules(id), fingerprint TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(student_id,rule_id));
--> statement-breakpoint
CREATE TABLE grade_history (id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES users(id), assignment_id TEXT NOT NULL REFERENCES assignments(id), actor_id TEXT NOT NULL REFERENCES users(id), occurred_at TEXT NOT NULL, old_data TEXT NOT NULL, new_data TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE requests (id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
--> statement-breakpoint
CREATE TABLE request_history (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), occurred_at TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, actor TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, published_at TEXT NOT NULL, expires_at TEXT, data TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE notification_reads (user_id TEXT NOT NULL REFERENCES users(id), notification_id TEXT NOT NULL REFERENCES notifications(id), read_at TEXT NOT NULL, PRIMARY KEY(user_id,notification_id));
--> statement-breakpoint
CREATE TABLE announcements (id TEXT PRIMARY KEY, published_at TEXT NOT NULL, expires_at TEXT, data TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE announcement_users (announcement_id TEXT NOT NULL REFERENCES announcements(id), user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(announcement_id,user_id));
--> statement-breakpoint
CREATE TABLE changes (id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id), announced_at TEXT NOT NULL, data TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE idempotency (user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, fingerprint TEXT NOT NULL, object_id TEXT NOT NULL, PRIMARY KEY(user_id,key));
--> statement-breakpoint
CREATE INDEX idx_lessons_date ON lessons(date);
--> statement-breakpoint
CREATE INDEX idx_results_assignment ON results(assignment_id,student_id);
--> statement-breakpoint
CREATE INDEX idx_notifications_user ON notifications(user_id,published_at);
--> statement-breakpoint
CREATE INDEX idx_requests_student ON requests(student_id,updated_at);
--> statement-breakpoint
CREATE INDEX idx_history_request ON request_history(request_id,occurred_at);
--> statement-breakpoint
CREATE INDEX idx_assignments_course ON assignments(subject_id,sort_order);
--> statement-breakpoint
CREATE INDEX idx_rules_course ON rules(subject_id,sort_order);
