const REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉'];
const REACTION_LIMIT = 3;
const REACTION_WINDOW_MS = 1000;
const REACTION_SHOW_MS = 3000;
const AUTO_LOWER_MS = 3000;

const isReaction = (emoji) => REACTIONS.includes(emoji);

const isRaised = (person) => person.hand > 0;

const byHand = (a, b) => {
  if (a.hand !== b.hand) return a.hand - b.hand;
  if (a.endpoint < b.endpoint) return -1;
  return a.endpoint > b.endpoint ? 1 : 0;
};

const raisedOf = (people) => people.filter(isRaised).toSorted(byHand);

const orderOf = (people) => {
  const order = new Map();
  const raised = raisedOf(people);
  for (let index = 0; index < raised.length; index++) {
    order.set(raised[index].endpoint, index + 1);
  }
  return order;
};

const rosterOf = (people) => {
  const raised = raisedOf(people);
  const rest = people.filter((person) => !isRaised(person));
  return raised.concat(rest);
};

const createLimiter = () => ({ times: [] });

const takeReaction = (limiter, now) => {
  const times = limiter.times;
  while (times.length > 0 && now - times[0] >= REACTION_WINDOW_MS) {
    times.shift();
  }
  if (times.length >= REACTION_LIMIT) return false;
  times.push(now);
  return true;
};

const createAutoLower = () => ({ since: -Infinity });

const stepAutoLower = (state, input, now) => {
  const active = input.enabled && input.raised && input.speaking;
  if (!active) return { state: { since: -Infinity }, lower: false };
  const since = state.since === -Infinity ? now : state.since;
  if (now - since < AUTO_LOWER_MS) return { state: { since }, lower: false };
  return { state: { since: -Infinity }, lower: true };
};

export { REACTIONS, REACTION_SHOW_MS, isReaction, orderOf, rosterOf };
export { createLimiter, takeReaction, createAutoLower, stepAutoLower };
