// The underlying provider may not support cancellation. A late result remains
// observed but cannot resume its caller or write after the deadline.
export async function withDeadline(operation, milliseconds, label='Provider operation') {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer=setTimeout(()=>reject(Error(label+' timed out')),milliseconds); })
    ]);
  } finally { clearTimeout(timer); }
}
