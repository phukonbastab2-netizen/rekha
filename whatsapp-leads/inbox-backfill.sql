-- Idempotent import of the history still available in the previous seven-day jobs.
-- Never queues a send, resets an opt-out or deletes the once-per-phone marker.
INSERT OR IGNORE INTO wa_inbox_contacts(phone,last_at,control_at,opted_out)
SELECT c.phone,0,c.control_at,CASE WHEN c.paused=1 AND NOT EXISTS(
 SELECT 1 FROM lead_jobs j WHERE j.phone=c.phone AND j.inbound_at=c.control_at
 AND j.error_code='human'
) THEN 1 ELSE 0 END FROM lead_contacts c;

INSERT OR IGNORE INTO wa_messages(id,phone,direction,type,body,details_json,source,created_at,received_at,state,meta_id)
SELECT 'in:'||id,phone,'in','text',body,'{"legacyImport":true}','customer',inbound_at,created_at,'received',id FROM lead_jobs;

INSERT OR IGNORE INTO wa_messages(id,phone,direction,type,body,details_json,source,created_at,received_at,state,meta_id,delivery_status,error_code)
SELECT 'auto:'||id,phone,'out',CASE WHEN reply LIKE '%Watch this 2-minute guide.%' THEN 'video' ELSE 'text' END,reply,'{}','automatic',MAX(created_at,updated_at),MAX(created_at,updated_at),state,meta_id,delivery_status,error_code
FROM lead_jobs WHERE reply IS NOT NULL AND reply!='';

UPDATE wa_inbox_contacts SET
 last_at=MAX(last_at,COALESCE((SELECT MAX(created_at) FROM wa_messages m WHERE m.phone=wa_inbox_contacts.phone),0)),
 preview=COALESCE((SELECT CASE WHEN body!='' THEN substr(body,1,160) ELSE '['||type||']' END FROM wa_messages m WHERE m.phone=wa_inbox_contacts.phone ORDER BY created_at DESC,id DESC LIMIT 1),preview),
 unread=(SELECT COUNT(*) FROM wa_messages m WHERE m.phone=wa_inbox_contacts.phone AND direction='in' AND owner_seen=0);
