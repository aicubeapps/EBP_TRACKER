ALTER TABLE users ADD COLUMN user_tf_access TEXT DEFAULT '["M5","M15","M30","1H","4H","D","W"]';
UPDATE users SET user_tf_access = '["M5","M15","M30","1H","4H","D","W"]' WHERE user_tf_access IS NULL;
