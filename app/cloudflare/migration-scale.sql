-- Structural, additive migration. Apply via applyScaleMigration() to skip
-- columns already added during an interrupted rollout. Then backfillScaleCache()
-- in bounded pages until complete before enabling bounded-v1 inbox requests.
PRAGMA foreign_keys=ON;
ALTER TABLE conversations ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN inbox_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN inbox_pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN inbox_archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN inbox_blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN inbox_owner_read INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN last_user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN last_message_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN waiting_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS messages_changes ON messages(conversation_id,change_revision,id);
CREATE INDEX IF NOT EXISTS messages_pending_customer ON messages(conversation_id,id) WHERE role='user' AND status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS messages_live_customer ON messages(conversation_id,id) WHERE role='user' AND status!='deleted';
CREATE INDEX IF NOT EXISTS conversations_inbox ON conversations(inbox_archived,inbox_pinned DESC,updated DESC,id DESC);
CREATE INDEX IF NOT EXISTS conversations_waiting ON conversations(inbox_pinned DESC,updated DESC,id DESC) WHERE inbox_archived=0 AND waiting_count>0;
CREATE INDEX IF NOT EXISTS conversations_reply_waiting ON conversations(updated,id) WHERE waiting_count>0 AND mode IN ('ai','assist') AND inbox_blocked=0;
CREATE INDEX IF NOT EXISTS message_quotes ON message_messaging(reply_to);
CREATE INDEX IF NOT EXISTS call_signals_call ON call_signals(call_id,id);
CREATE INDEX IF NOT EXISTS conversations_retention ON conversations(updated,id);
-- Durable cleanup survives an interrupted R2 delete after metadata removal.
CREATE TABLE IF NOT EXISTS object_cleanup(object_key TEXT PRIMARY KEY);
CREATE TRIGGER IF NOT EXISTS scale_attachment_cleanup AFTER DELETE ON chat_attachments BEGIN
 INSERT OR IGNORE INTO object_cleanup(object_key) VALUES(OLD.object_key);
END;
CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires,token_hash);
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires,key);
CREATE INDEX IF NOT EXISTS reward_attempts_expiry ON reward_attempts(expires,id);
CREATE INDEX IF NOT EXISTS calls_retention ON calls(created,id);
CREATE INDEX IF NOT EXISTS conversations_unread ON conversations(inbox_pinned DESC,updated DESC,id DESC) WHERE inbox_archived=0 AND last_user_id>inbox_owner_read;
CREATE INDEX IF NOT EXISTS conversations_pinned ON conversations(updated DESC,id DESC) WHERE inbox_archived=0 AND inbox_pinned=1;
CREATE INDEX IF NOT EXISTS conversations_blocked ON conversations(inbox_pinned DESC,updated DESC,id DESC) WHERE inbox_archived=0 AND inbox_blocked=1;
CREATE INDEX IF NOT EXISTS conversations_name ON conversations(name COLLATE NOCASE,id);
CREATE INDEX IF NOT EXISTS conversations_name_active ON conversations(name COLLATE NOCASE,id) WHERE inbox_archived=0;
CREATE INDEX IF NOT EXISTS conversations_name_archived ON conversations(name COLLATE NOCASE,id) WHERE inbox_archived=1;
CREATE INDEX IF NOT EXISTS conversations_name_waiting ON conversations(name COLLATE NOCASE,id) WHERE inbox_archived=0 AND waiting_count>0;
CREATE INDEX IF NOT EXISTS conversations_name_unread ON conversations(name COLLATE NOCASE,id) WHERE inbox_archived=0 AND last_user_id>inbox_owner_read;
CREATE INDEX IF NOT EXISTS conversations_name_pinned ON conversations(name COLLATE NOCASE,id) WHERE inbox_archived=0 AND inbox_pinned=1;
CREATE INDEX IF NOT EXISTS conversations_name_blocked ON conversations(name COLLATE NOCASE,id) WHERE inbox_archived=0 AND inbox_blocked=1;
CREATE TRIGGER IF NOT EXISTS scale_message_insert AFTER INSERT ON messages BEGIN
  UPDATE conversations SET change_revision=change_revision+1,last_message_id=MAX(last_message_id,NEW.id),last_user_id=CASE WHEN NEW.role='user' THEN MAX(last_user_id,NEW.id) ELSE last_user_id END,waiting_count=waiting_count+(NEW.role='user' AND NEW.status IN ('pending','failed')) WHERE id=NEW.conversation_id;
  UPDATE messages SET change_revision=COALESCE((SELECT change_revision FROM conversations WHERE id=NEW.conversation_id),change_revision) WHERE id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS scale_message_update AFTER UPDATE OF body,status ON messages WHEN OLD.body IS NOT NEW.body OR OLD.status IS NOT NEW.status BEGIN
  UPDATE conversations SET change_revision=change_revision+1,waiting_count=MAX(0,waiting_count+(NEW.role='user' AND NEW.status IN ('pending','failed'))-(OLD.role='user' AND OLD.status IN ('pending','failed'))) WHERE id=NEW.conversation_id;
  UPDATE messages SET change_revision=COALESCE((SELECT change_revision FROM conversations WHERE id=NEW.conversation_id),change_revision) WHERE id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS scale_message_delete AFTER DELETE ON messages BEGIN
  UPDATE conversations SET waiting_count=MAX(0,waiting_count-(OLD.role='user' AND OLD.status IN ('pending','failed'))),last_message_id=COALESCE((SELECT id FROM messages WHERE conversation_id=OLD.conversation_id ORDER BY id DESC LIMIT 1),0),last_user_id=COALESCE((SELECT id FROM messages WHERE conversation_id=OLD.conversation_id AND role='user' ORDER BY id DESC LIMIT 1),0) WHERE id=OLD.conversation_id;
END;
CREATE TRIGGER IF NOT EXISTS scale_chat_settings_insert AFTER INSERT ON chat_messaging BEGIN
  UPDATE conversations SET inbox_pinned=NEW.pinned,inbox_archived=NEW.archived,inbox_blocked=NEW.blocked,inbox_owner_read=NEW.owner_read,inbox_revision=inbox_revision+1 WHERE id=NEW.conversation_id;
END;
CREATE TRIGGER IF NOT EXISTS scale_chat_settings_update AFTER UPDATE OF pinned,archived,blocked,owner_read,labels,notes ON chat_messaging WHEN OLD.pinned IS NOT NEW.pinned OR OLD.archived IS NOT NEW.archived OR OLD.blocked IS NOT NEW.blocked OR OLD.owner_read IS NOT NEW.owner_read OR OLD.labels IS NOT NEW.labels OR OLD.notes IS NOT NEW.notes BEGIN
  UPDATE conversations SET inbox_pinned=NEW.pinned,inbox_archived=NEW.archived,inbox_blocked=NEW.blocked,inbox_owner_read=NEW.owner_read,inbox_revision=inbox_revision+CASE WHEN OLD.pinned IS NOT NEW.pinned OR OLD.archived IS NOT NEW.archived OR OLD.blocked IS NOT NEW.blocked OR OLD.labels IS NOT NEW.labels OR OLD.notes IS NOT NEW.notes THEN 1 ELSE 0 END WHERE id=NEW.conversation_id;
END;
CREATE TRIGGER IF NOT EXISTS scale_chat_settings_delete AFTER DELETE ON chat_messaging BEGIN
  UPDATE conversations SET inbox_pinned=0,inbox_archived=0,inbox_blocked=0,inbox_owner_read=0,inbox_revision=inbox_revision+1 WHERE id=OLD.conversation_id;
END;
CREATE TRIGGER IF NOT EXISTS scale_details_insert AFTER INSERT ON message_messaging WHEN NEW.reply_to IS NOT NULL OR NEW.edited IS NOT NULL OR NEW.deleted IS NOT NULL BEGIN
  UPDATE conversations SET change_revision=change_revision+1 WHERE id=(SELECT conversation_id FROM messages WHERE id=NEW.message_id);
  UPDATE messages SET change_revision=COALESCE((SELECT change_revision FROM conversations WHERE id=messages.conversation_id),change_revision) WHERE id=NEW.message_id;
END;
CREATE TRIGGER IF NOT EXISTS scale_details_update AFTER UPDATE OF reply_to,edited,deleted ON message_messaging WHEN OLD.reply_to IS NOT NEW.reply_to OR OLD.edited IS NOT NEW.edited OR OLD.deleted IS NOT NEW.deleted BEGIN
  UPDATE conversations SET change_revision=change_revision+1 WHERE id=(SELECT conversation_id FROM messages WHERE id=NEW.message_id);
  UPDATE messages SET change_revision=COALESCE((SELECT change_revision FROM conversations WHERE id=messages.conversation_id),change_revision) WHERE id=NEW.message_id;
END;
CREATE TRIGGER IF NOT EXISTS scale_message_reactions_insert AFTER INSERT ON message_reactions BEGIN
  UPDATE conversations SET change_revision=change_revision+1 WHERE id=(SELECT conversation_id FROM messages WHERE id=NEW.message_id);
  UPDATE messages SET change_revision=COALESCE((SELECT change_revision FROM conversations WHERE id=messages.conversation_id),change_revision) WHERE id=NEW.message_id;
END;
CREATE TRIGGER IF NOT EXISTS scale_message_reactions_delete AFTER DELETE ON message_reactions BEGIN
  UPDATE conversations SET change_revision=change_revision+1 WHERE id=(SELECT conversation_id FROM messages WHERE id=OLD.message_id);
  UPDATE messages SET change_revision=COALESCE((SELECT change_revision FROM conversations WHERE id=messages.conversation_id),change_revision) WHERE id=OLD.message_id;
END;
CREATE TRIGGER IF NOT EXISTS scale_message_stars_insert AFTER INSERT ON message_stars BEGIN
  UPDATE conversations SET change_revision=change_revision+1 WHERE id=(SELECT conversation_id FROM messages WHERE id=NEW.message_id);
  UPDATE messages SET change_revision=COALESCE((SELECT change_revision FROM conversations WHERE id=messages.conversation_id),change_revision) WHERE id=NEW.message_id;
END;
CREATE TRIGGER IF NOT EXISTS scale_message_stars_delete AFTER DELETE ON message_stars BEGIN
  UPDATE conversations SET change_revision=change_revision+1 WHERE id=(SELECT conversation_id FROM messages WHERE id=OLD.message_id);
  UPDATE messages SET change_revision=COALESCE((SELECT change_revision FROM conversations WHERE id=messages.conversation_id),change_revision) WHERE id=OLD.message_id;
END;
CREATE TRIGGER IF NOT EXISTS scale_reaction_update AFTER UPDATE OF emoji ON message_reactions WHEN OLD.emoji IS NOT NEW.emoji BEGIN
  UPDATE conversations SET change_revision=change_revision+1 WHERE id=(SELECT conversation_id FROM messages WHERE id=NEW.message_id);
  UPDATE messages SET change_revision=COALESCE((SELECT change_revision FROM conversations WHERE id=messages.conversation_id),change_revision) WHERE id=NEW.message_id;
END;
