const idOf = (endpoint, slot) => `${endpoint}/${slot}`;

const isLive = (track) => Boolean(track) && track.readyState === 'live';

const liveOf = (track) => (isLive(track) ? track : null);

const shownOf = (track) => {
  const live = liveOf(track);
  return live && !live.muted ? live : null;
};

const localTracks = (media) => {
  const screen = liveOf(media?.screenTrack);
  return {
    camera: media?.cameraOn === true ? shownOf(media?.cameraTrack) : null,
    screen,
    mic: liveOf(media?.micTrack),
    screenAudio: screen ? liveOf(media?.screenAudioTrack) : null,
  };
};

const remoteTracks = (tracks, person) => {
  const hasCamera = person.camera === true;
  const screen = person.screen === true ? liveOf(tracks?.screen) : null;
  return {
    camera: hasCamera ? shownOf(tracks?.camera) : null,
    screen,
    mic: liveOf(tracks?.mic),
    screenAudio: screen ? liveOf(tracks?.screenAudio) : null,
  };
};

const nickOf = (person, local, own) => {
  if (local) return own || person.nick || 'you';
  return person.nick || 'guest';
};

const memberOf = (state, person) => {
  const { endpoint, media, remote, speech } = state;
  const local = person.endpoint === endpoint;
  const tracks = local
    ? localTracks(media)
    : remoteTracks(remote?.get(person.endpoint), person);
  const heard = speech?.get(person.endpoint);
  return {
    endpoint: person.endpoint,
    nick: nickOf(person, local, state.nick),
    local,
    optOut: person.optOut === true,
    camera: tracks.camera,
    screen: tracks.screen,
    mic: tracks.mic,
    screenAudio: tracks.screenAudio,
    level: heard?.level ?? 0,
    speaking: heard?.speaking === true,
  };
};

const membersOf = (state) => {
  const people = Array.isArray(state.people) ? state.people : [];
  const hasSelf = people.some((item) => item.endpoint === state.endpoint);
  const self = { endpoint: state.endpoint };
  const everyone = hasSelf || !state.endpoint ? people : people.concat([self]);
  const make = (person) => memberOf(state, person);
  return everyone.filter((person) => person.endpoint).map(make);
};

export { idOf, membersOf };
