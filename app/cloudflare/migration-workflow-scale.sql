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
CREATE INDEX IF NOT EXISTS workflow_events_message ON workflow_events(message_id);
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
