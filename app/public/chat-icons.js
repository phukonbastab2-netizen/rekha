// Original chat controls share a compact 24px grid and inherit the UI colour.
const icons={
  back:'<path d="M19 12H5m6-6-6 6 6 6"/>',
  smile:'<circle cx="12" cy="12" r="9"/><path d="M8 14.5c1 1.7 2.3 2.5 4 2.5s3-.8 4-2.5"/><path d="M8.5 9h.01M15.5 9h.01" stroke-width="3"/>',
  attach:'<path d="m9 13 6-6a3 3 0 0 1 4.2 4.2l-8.3 8.3a5 5 0 0 1-7.1-7.1l8.3-8.3a2 2 0 0 1 2.8 2.8l-8.2 8.2a1 1 0 0 0 1.4 1.4l7.2-7.2"/>',
  camera:'<path d="M8 5.5 9.5 3h5L16 5.5h3A2 2 0 0 1 21 7.5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="4"/>',
  mic:'<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11.5v1a6 6 0 0 0 12 0v-1M12 18.5V22m-3 0h6"/>',
  send:'<path d="m3 3 19 9L3 21l3-9-3-9Zm3 9h16"/>',
  phone:'<path d="m5 3 4 1-1 5-2 1c2 4 4 6 8 8l1-2 5-1 1 4c.3 1.2-.4 2-1.6 2C11 21 3 13 3 5.5 3 4 3.8 2.7 5 3Z"/>',
  video:'<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 9 5-3v12l-5-3"/>',
  more:'<circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  file:'<path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8m-8 4h6"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  check:'<path d="m4 12 5 5L20 6"/>',
  checks:'<path d="m2 12 5 5L18 6m-5 11L23 7"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
};
const aliases={emoji:'smile',attachment:'attach',microphone:'mic',document:'file',gallery:'image'};
export function chatIcon(name,size=24){
  const pixels=Number.isFinite(Number(size))?Math.max(12,Math.min(64,Number(size))):24;
  const body=icons[aliases[name]||name]||icons.file;
  return `<svg class="chat-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${pixels}" height="${pixels}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
