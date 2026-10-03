PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,name TEXT NOT NULL,dob TEXT NOT NULL,language TEXT NOT NULL,preferences TEXT NOT NULL,mode TEXT NOT NULL DEFAULT 'ai',version INTEGER NOT NULL DEFAULT 0,free_used INTEGER NOT NULL DEFAULT 0,entitlement TEXT NOT NULL DEFAULT 'free',created INTEGER NOT NULL,updated INTEGER NOT NULL,change_revision INTEGER NOT NULL DEFAULT 0,inbox_revision INTEGER NOT NULL DEFAULT 0,inbox_pinned INTEGER NOT NULL DEFAULT 0,inbox_archived INTEGER NOT NULL DEFAULT 0,inbox_blocked INTEGER NOT NULL DEFAULT 0,inbox_owner_read INTEGER NOT NULL DEFAULT 0,last_user_id INTEGER NOT NULL DEFAULT 0,last_message_id INTEGER NOT NULL DEFAULT 0,waiting_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,role TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'sent',client_id TEXT,created INTEGER NOT NULL,change_revision INTEGER NOT NULL DEFAULT 0,UNIQUE(conversation_id,client_id));
CREATE TABLE IF NOT EXISTS drafts(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,message_id INTEGER NOT NULL,body TEXT NOT NULL,kind TEXT NOT NULL,version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS admin_sessions(token_hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,id);

CREATE TABLE IF NOT EXISTS media_items(id TEXT PRIMARY KEY,title TEXT NOT NULL,type TEXT NOT NULL,category TEXT NOT NULL DEFAULT 'general',object_key TEXT,url TEXT,mime TEXT,size INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media_collections(id TEXT PRIMARY KEY,title TEXT NOT NULL,item_ids TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media_grants(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,PRIMARY KEY(conversation_id,media_id));

CREATE TABLE IF NOT EXISTS reward_attempts(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,created INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reward_grants(transaction_id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS reward_grants_conversation ON reward_grants(conversation_id);
CREATE INDEX IF NOT EXISTS reward_attempts_conversation ON reward_attempts(conversation_id,created);
CREATE TABLE IF NOT EXISTS reward_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS chat_messaging(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,customer_read INTEGER NOT NULL DEFAULT 0,owner_read INTEGER NOT NULL DEFAULT 0,customer_typing INTEGER NOT NULL DEFAULT 0,owner_typing INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,blocked INTEGER NOT NULL DEFAULT 0,labels TEXT NOT NULL DEFAULT '[]',notes TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS message_messaging(message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,edited INTEGER,deleted INTEGER);
CREATE TABLE IF NOT EXISTS message_stars(message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,side TEXT NOT NULL CHECK(side IN ('customer','owner')),PRIMARY KEY(message_id,side));
CREATE TABLE IF NOT EXISTS message_reactions(message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,side TEXT NOT NULL CHECK(side IN ('customer','owner')),emoji TEXT NOT NULL,PRIMARY KEY(message_id,side));
CREATE TABLE IF NOT EXISTS chat_attachments(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,title TEXT NOT NULL,type TEXT NOT NULL,object_key TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,ready INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS chat_attachments_conversation ON chat_attachments(conversation_id);
CREATE TABLE IF NOT EXISTS saved_replies(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,caller TEXT NOT NULL,type TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS call_signals(id INTEGER PRIMARY KEY AUTOINCREMENT,call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,actor TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS calls_conversation ON calls(conversation_id,created);
CREATE INDEX IF NOT EXISTS calls_active_expiry ON calls(expires,id) WHERE status!='ended';
CREATE INDEX IF NOT EXISTS calls_active_created ON calls(created DESC,id DESC) WHERE status!='ended';
CREATE INDEX IF NOT EXISTS calls_active_status ON calls(status,id) WHERE status!='ended';
CREATE INDEX IF NOT EXISTS calls_active_conversation ON calls(conversation_id,expires,id) WHERE status!='ended';
CREATE UNIQUE INDEX IF NOT EXISTS calls_one_active_per_conversation ON calls(conversation_id) WHERE status!='ended';
CREATE TABLE IF NOT EXISTS workflow_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_workflow(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,generation INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'armed',stage TEXT NOT NULL DEFAULT 'NEW',campaign TEXT NOT NULL DEFAULT 'NONE',config TEXT NOT NULL,started_at INTEGER NOT NULL,updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_jobs(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,generation INTEGER NOT NULL,kind TEXT NOT NULL,step INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',due INTEGER NOT NULL,lease_until INTEGER,attempts INTEGER NOT NULL DEFAULT 0,payload TEXT NOT NULL,trigger_id INTEGER,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(conversation_id,generation,kind));
CREATE INDEX IF NOT EXISTS workflow_jobs_due ON workflow_jobs(status,due,lease_until);
CREATE INDEX IF NOT EXISTS workflow_jobs_conversation ON workflow_jobs(conversation_id,generation,status,due);
CREATE TABLE IF NOT EXISTS workflow_events(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,generation INTEGER NOT NULL,message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,created INTEGER NOT NULL,PRIMARY KEY(conversation_id,generation,message_id));
CREATE INDEX IF NOT EXISTS workflow_events_message ON workflow_events(message_id);
CREATE TABLE IF NOT EXISTS app_settings(id INTEGER PRIMARY KEY CHECK(id=1),published TEXT NOT NULL,draft TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=0),updated INTEGER NOT NULL,published_at INTEGER);
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
-- Additive and repeatable. Historical recovery is scanned in bounded cursor
-- batches by workflowRecoverMessages(), never by a full migration-time sweep.
CREATE TABLE IF NOT EXISTS workflow_recovery(message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS workflow_recovery_conversation ON workflow_recovery(conversation_id,message_id);
CREATE INDEX IF NOT EXISTS messages_user_id ON messages(id) WHERE role='user';
CREATE INDEX IF NOT EXISTS messages_user_conversation ON messages(conversation_id,id) WHERE role='user';
CREATE INDEX IF NOT EXISTS workflow_jobs_pending_order ON workflow_jobs(status,due,id);
CREATE INDEX IF NOT EXISTS workflow_jobs_lease_order ON workflow_jobs(status,lease_until,id);
CREATE INDEX IF NOT EXISTS workflow_jobs_chat_order ON workflow_jobs(conversation_id,status,due,id);
CREATE INDEX IF NOT EXISTS workflow_jobs_chat_lease ON workflow_jobs(conversation_id,status,lease_until,id);
INSERT OR IGNORE INTO workflow_settings(key,value) VALUES('recovery-cursor','0');
INSERT OR IGNORE INTO workflow_settings(key,value) SELECT 'recovery-legacy-max',CAST(COALESCE(MAX(id),0) AS TEXT) FROM messages;

CREATE TRIGGER IF NOT EXISTS workflow_recovery_insert AFTER INSERT ON messages WHEN NEW.role='user' AND EXISTS(SELECT 1 FROM chat_workflow WHERE conversation_id=NEW.conversation_id AND NEW.created>=started_at) BEGIN
 INSERT OR IGNORE INTO workflow_recovery(message_id,conversation_id) VALUES(NEW.id,NEW.conversation_id);
END;

-- Held jobs retain their original due time. Eligibility transitions are scoped
-- to one conversation; no owner toggle sweeps the full registered population.
CREATE TRIGGER IF NOT EXISTS workflow_jobs_hold_insert AFTER INSERT ON workflow_jobs WHEN NEW.status IN ('pending','processing') AND NOT EXISTS(SELECT 1 FROM chat_workflow f JOIN conversations c ON c.id=f.conversation_id LEFT JOIN chat_messaging s ON s.conversation_id=c.id WHERE f.conversation_id=NEW.conversation_id AND f.generation=NEW.generation AND f.status!='paused' AND c.mode='ai' AND COALESCE(s.blocked,0)=0) BEGIN
 UPDATE workflow_jobs SET status='held',lease_until=NULL,attempts=CASE WHEN status='processing' THEN MAX(0,attempts-1) ELSE attempts END WHERE id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS workflow_jobs_hold_updated AFTER UPDATE OF status ON workflow_jobs WHEN NEW.status IN ('pending','processing') AND NOT EXISTS(SELECT 1 FROM chat_workflow f JOIN conversations c ON c.id=f.conversation_id LEFT JOIN chat_messaging s ON s.conversation_id=c.id WHERE f.conversation_id=NEW.conversation_id AND f.generation=NEW.generation AND f.status!='paused' AND c.mode='ai' AND COALESCE(s.blocked,0)=0) BEGIN
 UPDATE workflow_jobs SET status='held',lease_until=NULL,attempts=CASE WHEN status='processing' THEN MAX(0,attempts-1) ELSE attempts END WHERE id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS workflow_jobs_mode AFTER UPDATE OF mode ON conversations BEGIN
 UPDATE workflow_jobs SET status='held',lease_until=NULL,attempts=CASE WHEN status='processing' THEN MAX(0,attempts-1) ELSE attempts END WHERE conversation_id=NEW.id AND status IN ('pending','processing') AND NOT EXISTS(SELECT 1 FROM chat_workflow f LEFT JOIN chat_messaging s ON s.conversation_id=f.conversation_id WHERE f.conversation_id=NEW.id AND f.generation=workflow_jobs.generation AND f.status!='paused' AND NEW.mode='ai' AND COALESCE(s.blocked,0)=0);
 UPDATE workflow_jobs SET status='pending',lease_until=NULL WHERE conversation_id=NEW.id AND status='held' AND EXISTS(SELECT 1 FROM chat_workflow f LEFT JOIN chat_messaging s ON s.conversation_id=f.conversation_id WHERE f.conversation_id=NEW.id AND f.generation=workflow_jobs.generation AND f.status!='paused' AND NEW.mode='ai' AND COALESCE(s.blocked,0)=0);
END;
CREATE TRIGGER IF NOT EXISTS workflow_jobs_block_insert AFTER INSERT ON chat_messaging WHEN NEW.blocked=1 BEGIN
 UPDATE workflow_jobs SET status='held',lease_until=NULL,attempts=CASE WHEN status='processing' THEN MAX(0,attempts-1) ELSE attempts END WHERE conversation_id=NEW.conversation_id AND status IN ('pending','processing');
END;
CREATE TRIGGER IF NOT EXISTS workflow_jobs_block_update AFTER UPDATE OF blocked ON chat_messaging BEGIN
 UPDATE workflow_jobs SET status='held',lease_until=NULL,attempts=CASE WHEN status='processing' THEN MAX(0,attempts-1) ELSE attempts END WHERE conversation_id=NEW.conversation_id AND status IN ('pending','processing') AND NEW.blocked=1;
 UPDATE workflow_jobs SET status='pending',lease_until=NULL WHERE conversation_id=NEW.conversation_id AND status='held' AND NEW.blocked=0 AND EXISTS(SELECT 1 FROM chat_workflow f JOIN conversations c ON c.id=f.conversation_id WHERE f.conversation_id=NEW.conversation_id AND f.generation=workflow_jobs.generation AND f.status!='paused' AND c.mode='ai');
END;
CREATE TRIGGER IF NOT EXISTS workflow_jobs_flow_update AFTER UPDATE OF status,generation ON chat_workflow BEGIN
 UPDATE workflow_jobs SET status='held',lease_until=NULL,attempts=CASE WHEN status='processing' THEN MAX(0,attempts-1) ELSE attempts END WHERE conversation_id=NEW.conversation_id AND status IN ('pending','processing') AND NOT EXISTS(SELECT 1 FROM conversations c LEFT JOIN chat_messaging s ON s.conversation_id=c.id WHERE c.id=NEW.conversation_id AND NEW.generation=workflow_jobs.generation AND NEW.status!='paused' AND c.mode='ai' AND COALESCE(s.blocked,0)=0);
 UPDATE workflow_jobs SET status='pending',lease_until=NULL WHERE conversation_id=NEW.conversation_id AND status='held' AND EXISTS(SELECT 1 FROM conversations c LEFT JOIN chat_messaging s ON s.conversation_id=c.id WHERE c.id=NEW.conversation_id AND NEW.generation=workflow_jobs.generation AND NEW.status!='paused' AND c.mode='ai' AND COALESCE(s.blocked,0)=0);
END;
