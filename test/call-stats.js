'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../application/static/call-stats.js');
const reportsAt = (timestamp, bytes, packets, lost) => {
  const reports = [
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
    {
      id: 'pair',
      type: 'candidate-pair',
      currentRoundTripTime: 0.12,
      localCandidateId: 'local',
      remoteCandidateId: 'remote',
    },
    { id: 'local', candidateType: 'host' },
    { id: 'remote', candidateType: 'srflx' },
    { id: 'codec', mimeType: 'video/VP9' },
    {
      id: 'video',
      type: 'inbound-rtp',
      kind: 'video',
      codecId: 'codec',
      bytesReceived: bytes,
      packetsReceived: packets,
      packetsLost: lost,
      timestamp,
      frameWidth: 1280,
      frameHeight: 720,
      framesPerSecond: 30,
    },
  ];
  return new Map(reports.map((report) => [report.id, report]));
};

test('stats use interval deltas and selected candidates', async () => {
  const { readCallStats, statsText } = await load();
  const first = readCallStats(reportsAt(1000, 1000, 100, 10));
  assert.equal(first.streams[0].bitrate, undefined);
  assert.equal(first.loss, undefined);
  const sample = readCallStats(reportsAt(2000, 101000, 190, 20), first);
  assert.equal(sample.rtt, 120);
  assert.equal(sample.loss, 0.1);
  assert.equal(sample.streams[0].bitrate, 800000);
  assert.equal(sample.streams[0].codec, 'video/VP9');
  assert.equal(sample.bars, 2);
  assert.equal(sample.local, 'host');
  assert.equal(sample.remote, 'srflx');
  assert.match(statsText(sample), /1280×720.*30 fps/);
  assert.match(statsText(sample), /800 kbps/);
});

test('stats tolerate missing fields and counter resets', async () => {
  const { readCallStats, statsText } = await load();
  const before = readCallStats(reportsAt(2000, 10000, 100, 10));
  const sample = readCallStats(reportsAt(1000, 100, 1, 0), before);
  assert.equal(sample.loss, undefined);
  assert.equal(sample.streams[0].bitrate, undefined);
  const empty = readCallStats(new Map());
  assert.equal(empty.bars, 0);
  assert.equal(empty.rtt, undefined);
  assert.match(statsText(empty), /unavailable/);
  assert.doesNotMatch(statsText(empty), /NaN|undefined/);
  assert.match(statsText(null), /Waiting/);
});

test('remote reports supply missing RTT and loss', async () => {
  const { readCallStats } = await load();
  const report = {
    type: 'remote-inbound-rtp',
    roundTripTime: 0.8,
    fractionLost: 0.15,
  };
  const sample = readCallStats(new Map([['remote', report]]));
  assert.equal(sample.rtt, 800);
  assert.equal(sample.loss, 0.15);
  assert.equal(sample.bars, 1);
});

test('connection bars follow latency and loss boundaries', async () => {
  const { connectionBars } = await load();
  assert.equal(connectionBars(undefined, undefined), 0);
  assert.equal(connectionBars(120, 0.01), 4);
  assert.equal(connectionBars(151, 0), 3);
  assert.equal(connectionBars(301, 0), 2);
  assert.equal(connectionBars(601, 0), 1);
  assert.equal(connectionBars(0, 0.11), 1);
  assert.equal(connectionBars(undefined, 0), 4);
});
