// Renew the private HttpOnly session after a supervised gateway restart.
// Retry only an explicit 401: a network error may have happened after a send.
export function createApi(fetcher = fetch) {
  let renewal;
  return async (route, data, signal) => {
    const options = data === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) };
    if (signal) options.signal = signal;
    const send = () => fetcher('/api/' + route, options);
    let response = await send();
    if (response.status === 401) {
      renewal ||= fetcher('/', {cache:'no-store'}).then(r => { if (!r.ok) throw Error('Could not reconnect to the private gateway.'); }).finally(() => { renewal = null; });
      await renewal;
      response = await send();
    }
    const value = await response.json();
    if (!response.ok) throw Error(value.error || 'Please try again');
    return value;
  };
}
