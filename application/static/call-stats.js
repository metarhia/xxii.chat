const finite = (value) => Number.isFinite(value) && value >= 0;

const connectionBars = (rtt, loss) => {
  if (!finite(rtt) && !finite(loss)) return 0;
  if (rtt > 600 || loss > 0.1) return 1;
  if (rtt > 300 || loss > 0.05) return 2;
  if (rtt > 150 || loss > 0.02) return 3;
  return 4;
};

const readCallStats = (reports, previous = null, lanes = new Map()) => {
  const counters = new Map();
  const streams = [];
  let pair = null;
  let rtt = undefined;
  let loss = undefined;
  for (const report of reports.values()) {
    const selected = reports.get(report.selectedCandidatePairId);
    if (report.type === 'transport' && selected) pair = selected;
  }
  for (const report of reports.values()) {
    const nominated = report.nominated || report.selected;
    if (!pair && report.type === 'candidate-pair' && nominated) {
      if (report.state === 'succeeded') pair = report;
    }
    const inbound = report.type === 'inbound-rtp';
    const outbound = report.type === 'outbound-rtp';
    if (!inbound && !outbound) continue;
    const bytes = inbound ? report.bytesReceived : report.bytesSent;
    const packets = inbound ? report.packetsReceived : report.packetsSent;
    const lost = Math.max(0, report.packetsLost ?? 0);
    const timestamp = report.timestamp;
    const counter = { bytes, packets, lost, timestamp };
    counters.set(report.id, counter);
    const before = previous?.counters.get(report.id);
    const elapsed = timestamp - (before?.timestamp ?? timestamp);
    const delta = bytes - (before?.bytes ?? bytes);
    const bitrate =
      elapsed > 0 && delta >= 0 ? (delta * 8000) / elapsed : undefined;
    if (inbound && before && packets >= before.packets) {
      const received = packets - before.packets;
      const missing = Math.max(0, lost - before.lost);
      const total = received + missing;
      if (total > 0) loss = Math.max(loss ?? 0, missing / total);
    }
    const codec = reports.get(report.codecId)?.mimeType ?? '';
    streams.push({
      direction: inbound ? 'in' : 'out',
      kind: report.kind ?? report.mediaType ?? '',
      codec,
      slot:
        lanes.get(report.trackIdentifier) ??
        lanes.get(reports.get(report.mediaSourceId)?.trackIdentifier) ??
        '',
      bitrate,
      width: report.frameWidth,
      height: report.frameHeight,
      fps: report.framesPerSecond,
    });
  }
  if (finite(pair?.currentRoundTripTime)) {
    rtt = pair.currentRoundTripTime * 1000;
  }
  for (const report of reports.values()) {
    if (report.type !== 'remote-inbound-rtp') continue;
    if (finite(report.fractionLost)) {
      loss = Math.max(loss ?? 0, report.fractionLost);
    }
    if (rtt === undefined && finite(report.roundTripTime)) {
      rtt = report.roundTripTime * 1000;
    }
  }
  const local = reports.get(pair?.localCandidateId)?.candidateType ?? '';
  const remote = reports.get(pair?.remoteCandidateId)?.candidateType ?? '';
  return {
    counters,
    streams,
    rtt,
    loss,
    local,
    remote,
    bars: connectionBars(rtt, loss),
  };
};

const statsText = (sample) => {
  if (!sample) return 'Waiting for connection stats…';
  const rtt = finite(sample.rtt)
    ? `${Math.round(sample.rtt)} ms`
    : 'unavailable';
  const loss = finite(sample.loss)
    ? `${(sample.loss * 100).toFixed(1)}%`
    : 'unavailable';
  const route = [sample.local, sample.remote].filter(Boolean).join(' / ');
  const lines = [
    `RTT ${rtt} · loss ${loss}`,
    `Candidates ${route || 'unavailable'}`,
  ];
  for (const stream of sample.streams) {
    const rate = finite(stream.bitrate)
      ? `${Math.round(stream.bitrate / 1000)} kbps`
      : 'bitrate pending';
    const parts = [
      stream.direction,
      stream.slot || stream.kind,
      stream.codec || 'codec pending',
    ];
    parts.push(rate);
    if (stream.width && stream.height) {
      parts.push(`${stream.width}×${stream.height}`);
    }
    if (finite(stream.fps)) parts.push(`${Math.round(stream.fps)} fps`);
    lines.push(parts.join(' · '));
  }
  return lines.join('\n');
};

export { connectionBars, readCallStats, statsText };
