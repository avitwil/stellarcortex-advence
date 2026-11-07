// Minimal Server-Sent Events reader for streaming model APIs.
export async function* sseEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<{ event: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let event = '';
  let data: string[] = [];
  try {
    for (;;) {
      if (signal.aborted) throw new Error('aborted');
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') {
          if (data.length) yield { event: event || 'message', data: data.join('\n') };
          event = '';
          data = [];
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('event:')) event = line.slice(6).trim();
      }
    }
    if (data.length) yield { event: event || 'message', data: data.join('\n') };
  } finally {
    reader.releaseLock();
  }
}
