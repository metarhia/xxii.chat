({
  maxParticipants: 8,
  maxCameras: 6,
  maxScreens: 2,
  maxLobby: 20,
  maxCallsPerPeer: 3,
  heartbeatMs: 10000,
  timeoutMs: (() => {
    const raw = Number(process.env.XXII_CALL_TIMEOUT_MS);
    if (Number.isFinite(raw) && raw > 0) return raw;
    return 30000;
  })(),
  ringMs: 45000,
  signalRate: 100,
  updateRate: 10,
  defaultPolicy: 'link',
});
