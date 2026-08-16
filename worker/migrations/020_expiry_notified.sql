ALTER TABLE users ADD COLUMN expiry_notified INT DEFAULT 0;
ALTER TABLE users ADD COLUMN expiry_warning_sent INT DEFAULT 0;
