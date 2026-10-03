-- Keep idle call polling independent of accumulated ended-call history.
CREATE INDEX IF NOT EXISTS calls_active_expiry ON calls(expires,id) WHERE status!='ended';
CREATE INDEX IF NOT EXISTS calls_active_created ON calls(created DESC,id DESC) WHERE status!='ended';
CREATE INDEX IF NOT EXISTS calls_active_status ON calls(status,id) WHERE status!='ended';
CREATE INDEX IF NOT EXISTS calls_active_conversation ON calls(conversation_id,expires,id) WHERE status!='ended';
