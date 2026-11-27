import { plainInline } from './markdown.js';
import { plural } from './view.js';

const choiceKey = ({ label, occurrence }) =>
  JSON.stringify([label, occurrence]);

const choicesOf = (blocks) => {
  const choices = new Map();
  const seen = new Map();
  const visit = (nodes) => {
    for (const block of nodes) {
      if (block.type !== 'list') continue;
      for (const item of block.items) {
        const line = item.children[0];
        if (
          block.sign === '-' &&
          item.checked === false &&
          line?.type === 'paragraph'
        ) {
          const label = plainInline(line.children).trim().replace(/\s+/g, ' ');
          if (label) {
            const occurrence = seen.get(label) ?? 0;
            const choice = { label, occurrence };
            choices.set(item, { ...choice, key: choiceKey(choice) });
            seen.set(label, occurrence + 1);
          }
        }
        visit(item.children);
      }
    }
  };
  visit(blocks);
  return choices;
};

const voteIdOf = async (message, author, choice) => {
  const data = new TextEncoder().encode(
    JSON.stringify([message, author, choice.label, choice.occurrence]),
  );
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `vote-${hex}`;
};

const votesOf = (replica, chat, me) => {
  const byMessage = new Map();
  for (const id of replica.keys('vote')) {
    const vote = replica.get(id);
    if (vote.chat !== chat || vote.active !== true) continue;
    const { message, label, occurrence, author } = vote;
    const key = choiceKey(vote);
    const options = byMessage.get(message) ?? new Map();
    const result = options.get(key) ?? {
      key,
      label,
      occurrence,
      authors: new Set(),
    };
    result.authors.add(author);
    options.set(key, result);
    byMessage.set(message, options);
  }
  const results = new Map();
  for (const [id, options] of byMessage) {
    const tallies = [...options.values()].map(({ authors, ...option }) => ({
      ...option,
      count: authors.size,
      checked: authors.has(me),
    }));
    results.set(id, tallies);
  }
  return results;
};

const countOf = (count) => plural(count, 'vote', 'votes');

const voteControls = (blocks, results, cast) => {
  const previous = new Map(results.map((result) => [result.key, result]));
  const tasks = new Map();
  for (const [item, choice] of choicesOf(blocks)) {
    const { key, label } = choice;
    const { count = 0, checked = false } = previous.get(key) ?? {};
    previous.delete(key);
    tasks.set(item, (box) => {
      const tally = document.createElement('span');
      tally.className = 'vote-tally';
      tally.textContent = countOf(count);
      box.className = 'vote-choice';
      box.dataset.choice = key;
      box.setAttribute('aria-label', `Vote for ${label}, ${tally.textContent}`);
      box.checked = checked;
      box.disabled = false;
      box.onchange = async () => {
        const active = box.checked;
        box.checked = checked;
        box.setAttribute('aria-busy', 'true');
        try {
          await cast(choice, active);
        } finally {
          box.removeAttribute('aria-busy');
        }
      };
      return tally;
    });
  }
  return { tasks, previous: [...previous.values()] };
};

const showPreviousVotes = (container, votes) => {
  if (votes.length === 0) return;
  const details = document.createElement('details');
  details.className = 'previous-votes';
  const summary = document.createElement('summary');
  summary.textContent = 'Votes for previous options';
  const list = document.createElement('ul');
  for (const { label, count } of votes) {
    const item = document.createElement('li');
    item.textContent = `${label} · ${countOf(count)}`;
    list.append(item);
  }
  details.append(summary, list);
  container.append(details);
};

export { choicesOf, voteIdOf, votesOf, voteControls, showPreviousVotes };
