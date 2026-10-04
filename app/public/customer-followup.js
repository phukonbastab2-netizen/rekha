export const DONATION_INTEREST_TEXT='मैं दान करना चाहता/चाहती हूँ · I want to donate';
export const donationInterestClientId=id=>Number.isSafeInteger(Number(id))&&Number(id)>0?`kundli-donation-interest-v1-${Number(id)}`:null;
export const isDonationInterestResponse=id=>typeof id==='string'&&/^kundli-donation-interest-v1-[1-9]\d*$/.test(id);
export function donationInterestState(chat,message,records=[]){
  let eligible=false;
  try{eligible=message?.role==='assistant'&&message.kind==='media'&&!message.deleted&&JSON.parse(message.body).donation?.action==='interest-v1';}catch{}
  const clientId=eligible?donationInterestClientId(message.id):null;
  const answered=Boolean(clientId&&(chat?.kundliDonationInterested===true||chat?.messages?.some(row=>row.role==='user'&&row.clientId===clientId)));
  const record=clientId?records.find(item=>item.clientId===clientId&&item.conversationId===chat?.id):null;
  const state=answered?'answered':record?record.state==='failed'?'failed':'pending':'available';
  return {clientId,state,disabled:!clientId||answered||Boolean(record)||chat?.customerSendHold?.active===true};
}
