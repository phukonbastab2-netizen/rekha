-- One durable counter replaces a full attachment-table SUM on each upload.
-- Install triggers before initialisation so concurrent legacy uploads are counted.
-- Initialisation is performed once; retries never overwrite concurrent totals.
CREATE TABLE IF NOT EXISTS attachment_storage_stats(id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL CHECK(bytes>=0));
CREATE TRIGGER IF NOT EXISTS attachment_storage_insert AFTER INSERT ON chat_attachments BEGIN
  UPDATE attachment_storage_stats SET bytes=bytes+NEW.size WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS attachment_storage_delete AFTER DELETE ON chat_attachments BEGIN
  UPDATE attachment_storage_stats SET bytes=MAX(0,bytes-OLD.size) WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS attachment_storage_update AFTER UPDATE OF size ON chat_attachments WHEN OLD.size IS NOT NEW.size BEGIN
  UPDATE attachment_storage_stats SET bytes=MAX(0,bytes+NEW.size-OLD.size) WHERE id=1;
END;
INSERT OR IGNORE INTO attachment_storage_stats(id,bytes) SELECT 1,COALESCE(SUM(size),0) FROM chat_attachments;
