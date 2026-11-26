'use strict';

const { test } = require('node:test');
const {
  open,
  fixture,
  inspect,
  readTones,
  assertMedia,
} = require('./recording-edit-fixture.js');

test(
  'Chrome renders and decodes the kept ranges across non-keyframe cuts',
  {
    timeout: 90000,
  },
  async (t) => {
    const run = await open(t);
    for (const extension of ['mp4', 'webm']) {
      await t.test(extension, async (t) => {
        const result = await run(`
        const { editFormatOf, renderEdit } =
          await import('/recording-edit-render.js');
        const logic = await import('/recording-edit-logic.js');
        const { readPart, PartPlayer } =
          await import('/recording-edit-media.js');
        const { FORMATS } = await import('/recorder.js');
        const format = editFormatOf(true, FORMATS.filter(
          item => item.extension === ${JSON.stringify(extension)},
        ));
        if (!format) return null;
        const signal = new AbortController().signal;
        const blob = await (${fixture})(format.mime);
        const source = async () => blob;
        const player = new PartPlayer(document.createElement('video'), source);
        const part = await readPart(player, { index: 0 }, signal);
        player.clear();
        const parts = logic.partsOf([part]);
        const cuts = [{ start: 1110, end: 1910 }, { start: 2460, end: 3260 }];
        const draft = { start: 300, end: 4020, cuts };
        const timeline = logic.timelineOf(part.duration, draft);
        if (timeline.error) throw new Error(timeline.error);
        const chunks = [];
        const { mime } = await renderEdit({
          parts, timeline, source, signal, format,
          write: async chunk => chunks.push(chunk),
        });
        const output = new Blob(chunks, { type: mime });
        return (${inspect})(output, false, ${readTones});
      `);
        if (!result) return void t.skip('format encoder unavailable');
        assertMedia(t, result, 2.12, [0.81, 1.36]);
      });
    }
  },
);
