// Browser features that BetterNCM code written for NCM 2.x (Chrome 91) still expects.

// Event.path was removed in Chrome 109; the framework (index.tsx:69) and PluginMarket use it.
if (!('path' in Event.prototype)) {
  Object.defineProperty(Event.prototype, 'path', {
    get() { return this.composedPath(); },
    configurable: true,
  });
}

// NCM's CEF build sends Blob-backed upload data as empty (a FormData file part arrives with
// zero bytes, a bare Blob body as Content-Length 0), while ArrayBuffer bodies go through.
// betterncm.fs.writeFile and the market's plugin install upload Blobs, so for requests to our
// own API we serialize the body in the renderer first. NCM's own requests are left alone.
{
  const nativeFetch = window.fetch;
  const apiOrigin = new URL(BETTERNCM_API_PATH).origin;
  const isApiUrl = (u) => { try { return new URL(u, location.href).origin === apiOrigin; } catch { return false; } };
  window.fetch = function fetch(input, init) {
    const body = init && init.body;
    const url = typeof input === 'string' ? input : input && input.url;
    if (!(body instanceof Blob || body instanceof FormData) || !isApiUrl(url)) {
      return nativeFetch.apply(this, arguments);
    }
    // Request does the multipart encoding (with boundary) for FormData and keeps a Blob's type.
    const encoded = new Request(url, { method: init.method || 'POST', body });
    return encoded.arrayBuffer().then((buf) => {
      const headers = new Headers(init.headers);
      const type = encoded.headers.get('content-type');
      if (type) headers.set('Content-Type', type);
      return nativeFetch.call(this, input, { ...init, headers, body: buf });
    });
  };
}
