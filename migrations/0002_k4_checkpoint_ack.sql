CREATE TABLE device_checkpoints (
  instance_id TEXT NOT NULL,
  product TEXT NOT NULL CHECK (product = 'tasks'),
  device_id TEXT NOT NULL,
  last_change_seq INTEGER NOT NULL CHECK (last_change_seq >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, product, device_id)
);
