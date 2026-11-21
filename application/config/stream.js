({
  allowHttp: process.env.XXII_STREAM_ALLOW_HTTP === 'true',
  allowPrivate: process.env.XXII_STREAM_ALLOW_PRIVATE === 'true',
  timeoutMs: 10000,
  maxBody: 65536,
});
