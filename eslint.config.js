'use strict';

const init = require('eslint-config-metarhia');

const VENDOR = [
  'application/static/metacom.js',
  'application/static/metautil.js',
  'application/static/globalstorage.js',
];

module.exports = [
  { ignores: VENDOR },
  ...init,
  {
    files: ['application/**/*.js'],
    rules: {
      strict: 'off',
    },
    languageOptions: {
      sourceType: 'module',
      globals: {
        api: true,
        application: true,
        config: true,
        context: true,
        node: true,
        npm: true,
        lib: true,
        db: true,
        bus: true,
        domain: true,
        metarhia: true,
        DomainError: true,
        document: true,
        location: true,
        self: true,
        caches: true,
        navigator: true,
        File: true,
        localStorage: true,
        Notification: true,
        requestAnimationFrame: true,
        matchMedia: true,
        history: true,
        CSS: true,
        IntersectionObserver: true,
        BroadcastChannel: true,
        createImageBitmap: true,
      },
    },
  },
];
