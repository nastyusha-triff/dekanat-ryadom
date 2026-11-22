CREATE TABLE request_numbers (number INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE REFERENCES requests(id));
--> statement-breakpoint
INSERT INTO request_numbers(request_id) SELECT id FROM requests ORDER BY julianday(json_extract(data,'$.created_at')),id;
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN display_number INTEGER;
--> statement-breakpoint
UPDATE requests SET display_number=(SELECT number FROM request_numbers WHERE request_id=requests.id);
--> statement-breakpoint
CREATE TRIGGER request_number_insert AFTER INSERT ON requests BEGIN
  INSERT INTO request_numbers(request_id) VALUES(NEW.id);
  UPDATE requests SET display_number=(SELECT number FROM request_numbers WHERE request_id=NEW.id) WHERE id=NEW.id;
END;
