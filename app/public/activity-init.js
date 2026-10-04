import {initActivity,setActivityScreen,manageActivityConsent} from './activity.js';

// Public website pages only. The customer app initializes its own surface.
initActivity({surface:'website'});
const path=location.pathname;
setActivityScreen(/privacy-policy/.test(path)?'privacy':/\/(?:astrorani\/)?(?:about|contact|support|data-deletion|terms-and-conditions|refund-cancellation|disclaimer|shipping-policy)/.test(path)?'policy':'download');
document.querySelectorAll('[data-activity-settings]').forEach(button=>button.addEventListener('click',()=>manageActivityConsent()));
