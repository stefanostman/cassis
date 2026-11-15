CREATE TABLE IF NOT EXISTS test_messages (
  id INT PRIMARY KEY,
  message VARCHAR(255) NOT NULL
);

INSERT IGNORE INTO test_messages (id, message)
VALUES (1, 'Hej från MySQL!');
