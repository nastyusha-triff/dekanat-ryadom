CREATE TABLE rule_publications (student_id TEXT NOT NULL REFERENCES users(id), rule_id TEXT NOT NULL REFERENCES rules(id), release_at TEXT NOT NULL, PRIMARY KEY(student_id,rule_id));
